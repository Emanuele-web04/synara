import { page } from "vitest/browser";
import "../../index.css";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { RightDock } from "./RightDock";
import type { RightDockThreadState } from "../../rightDockStore.logic";

const dockTabs = () => [
  ...document.querySelectorAll<HTMLElement>('nav[aria-label="Open panels"] [data-surface-tab]'),
];
const dockTabLabels = () =>
  dockTabs().map((tab) => tab.querySelector("button:not([aria-label])")!.textContent);
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const mousePointerEvent = (type: string, x: number, y: number) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType: "mouse",
    pointerId: 1,
    isPrimary: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: y,
  });

function renderDock(content: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return render(<QueryClientProvider client={client}>{content}</QueryClientProvider>);
}

it("keeps the resize rail reachable from the chat side in the rail layout", async () => {
  await page.viewport(1280, 800);
  const { createDefaultRightDockState, openPaneInState } =
    await import("../../rightDockStore.logic");
  const state = openPaneInState(createDefaultRightDockState(), {
    paneId: "browser",
    kind: "browser",
  });
  const screen = await renderDock(
    <div data-sidebar-layout="rail" className="flex h-screen w-screen">
      <div className="min-w-0 flex-1">Chat</div>
      <RightDock
        state={state}
        minWidth={300}
        defaultWidth="50vw"
        shouldAcceptWidth={() => true}
        addMenuKinds={[]}
        onClosePane={() => {}}
        onCollapse={() => {}}
        onOpenChange={() => {}}
        onAddPane={() => {}}
        renderPane={() => <div className="h-full w-full">Browser viewport</div>}
      />
    </div>,
  );
  try {
    const rail = document.querySelector<HTMLButtonElement>("[data-slot='sidebar-rail']")!;
    const container = document.querySelector<HTMLElement>("[data-slot='sidebar-container']")!;
    await expect.poll(() => Math.round(container.getBoundingClientRect().width)).toBe(640);
    const { left, top, height } = container.getBoundingClientRect();
    const y = top + height / 2;
    // This side of the seam is outside Electron's native browser viewport.
    expect(document.elementFromPoint(left - 4, y)).toBe(rail);
    const handle = page.getByRole("button", { name: "Resize Sidebar" });
    await handle.hover({
      position: { x: 4, y: height / 2 },
    });
    expect(rail.matches(":hover")).toBe(true);
    expect(getComputedStyle(rail).cursor).toMatch(/resize/);
    for (const delta of [-100, 100]) {
      const width = container.getBoundingClientRect().width;
      await handle.dropTo(handle, {
        sourcePosition: { x: 4, y: height / 2 },
        targetPosition: { x: 4 + delta, y: height / 2 },
        force: true,
      });
      await expect
        .poll(() => container.getBoundingClientRect().width)
        .toBeCloseTo(width - delta, 0);
    }
  } finally {
    await screen.unmount();
  }
});

it("maximizes and restores without remounting or resetting document state", async () => {
  await page.viewport(1280, 800);
  const state: RightDockThreadState = {
    open: true,
    activePaneId: "file",
    panes: [
      {
        id: "file",
        kind: "file",
        filePath: "note.md",
        threadId: null,
        diffTurnId: null,
        diffFilePath: null,
        pullRequestProjectId: null,
        pullRequestRepository: null,
        pullRequestNumber: null,
        pullRequestInitialTab: null,
      },
    ],
  };
  const screen = await renderDock(
    <div style={{ display: "flex", width: 1000, height: 600 }}>
      <div data-testid="chat" style={{ flex: 1 }}>
        Chat continues
      </div>
      <RightDock
        state={state}
        minWidth={300}
        defaultWidth="500px"
        shouldAcceptWidth={() => true}
        addMenuKinds={[]}
        onClosePane={() => {}}
        onCollapse={() => {}}
        onOpenChange={() => {}}
        onAddPane={() => {}}
        renderPane={() => (
          <div data-testid="document" style={{ overflow: "auto", height: 400, width: "100%" }}>
            <input aria-label="Draft" defaultValue="Keep me" />
            <div style={{ height: 2000 }}>Document</div>
          </div>
        )}
      />
    </div>,
  );
  await expect
    .element(screen.getByRole("button", { name: "Maximize panel", exact: true }))
    .toBeVisible();
  const doc = document.querySelector<HTMLElement>('[data-testid="document"]')!;
  doc.scrollTop = 120;
  const container = doc.closest<HTMLElement>('[data-slot="sidebar-container"]')!;
  const originalWidth = container.getBoundingClientRect().width;
  await screen.getByRole("button", { name: "Maximize panel", exact: true }).click();
  await expect.poll(() => container.getBoundingClientRect().width).toBe(1000);
  expect(document.querySelector('[data-testid="document"]')).toBe(doc);
  expect(doc.scrollTop).toBe(120);
  expect(document.querySelector<HTMLElement>('[data-testid="chat"]')!.inert).toBe(true);
  expect(document.querySelector<HTMLElement>('[data-testid="chat"]')!.style.visibility).toBe(
    "hidden",
  );
  await screen.getByRole("button", { name: "Restore panel", exact: true }).click();
  await expect.poll(() => container.getBoundingClientRect().width).toBe(originalWidth);
  expect(document.querySelector('[data-testid="document"]')).toBe(doc);
  expect(doc.scrollTop).toBe(120);
  expect(document.querySelector<HTMLElement>('[data-testid="chat"]')!.inert).toBe(false);
});

it("keeps the whole dock maximized across selecting, opening and closing documents", async () => {
  await page.viewport(1280, 800);
  const { useState } = await import("react");
  const pane = (id: string) => ({
    id,
    kind: "file" as const,
    filePath: id + ".md",
    threadId: null,
    diffTurnId: null,
    diffFilePath: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    pullRequestNumber: null,
    pullRequestInitialTab: null,
  });
  function Harness() {
    const [state, setState] = useState<RightDockThreadState>({
      open: true,
      activePaneId: "a",
      panes: [pane("a"), pane("b")],
    });
    return (
      <div style={{ display: "flex", width: 1000, height: 600 }}>
        <div className="drag-region" style={{ flex: 1 }}>
          Chat header
        </div>
        <RightDock
          state={state}
          paneLabelOverrides={{ a: "a.md", b: "b.md", c: "c.md" }}
          minWidth={300}
          defaultWidth="500px"
          shouldAcceptWidth={() => true}
          addMenuKinds={[]}
          onSelectPane={(id) => setState((s) => ({ ...s, activePaneId: id }))}
          onClosePane={(id) =>
            setState((s) => ({
              ...s,
              panes: s.panes.filter((p) => p.id !== id),
              activePaneId: s.panes.find((p) => p.id !== id)?.id ?? null,
            }))
          }
          onCollapse={() => {}}
          onOpenChange={() => {}}
          onAddPane={() => {}}
          renderPane={(p) => (
            <div>
              <p>Document {p.id}</p>
              <button
                onClick={() =>
                  setState((s) => ({ ...s, panes: [...s.panes, pane("c")], activePaneId: "c" }))
                }
              >
                Open linked document
              </button>
            </div>
          )}
        />
      </div>
    );
  }
  const screen = await renderDock(<Harness />);
  await screen.getByRole("button", { name: "Maximize panel", exact: true }).click();
  await screen.getByRole("button", { name: "b.md", exact: true }).click();
  await expect.element(screen.getByText("Document b", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Restore panel", exact: true }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Open linked document", exact: true }).click();
  await expect.element(screen.getByText("Document c", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Restore panel", exact: true }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Close c.md", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "Close c.md", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Restore panel", exact: true }))
    .toBeVisible();
});

it("restores host accessibility on resize, thread changes, collapse and final close", async () => {
  await page.viewport(1280, 800);
  const { useState } = await import("react");
  const { ChatPaneDropOverlay } = await import("../chat-drop-overlay/ChatPaneDropOverlay");
  const { RouteInsetSurface } = await import("../RouteInsetSurface");
  const { closePaneInState, createDefaultRightDockState, openPaneInState } =
    await import("../../rightDockStore.logic");
  const initial = openPaneInState(createDefaultRightDockState(), {
    paneId: "note",
    kind: "file",
    filePath: "note.md",
  });
  function Harness() {
    const [state, setState] = useState(initial);
    const [thread, setThread] = useState("a");
    const [width, setWidth] = useState(1000);
    return (
      <>
        <button onClick={() => setWidth(900)}>Resize host</button>
        <button onClick={() => setThread(thread === "a" ? "b" : "a")}>Switch thread</button>
        <button onClick={() => setState(initial)}>Reopen</button>
        <div
          data-testid="host"
          className="flex h-dvh min-h-0 min-w-0 overflow-hidden"
          style={{ width }}
        >
          <ChatPaneDropOverlay onDrop={() => {}} className="flex h-full min-h-0 min-w-0 flex-1">
            <RouteInsetSurface surfaceClassName="bg-background">
              <input aria-label="Chat composer" defaultValue="Retained draft" />
              <div className="drag-region">Chat header</div>
            </RouteInsetSurface>
          </ChatPaneDropOverlay>
          <RightDock
            state={state}
            motionKey={thread}
            minWidth={300}
            defaultWidth="500px"
            shouldAcceptWidth={() => true}
            addMenuKinds={[]}
            paneLabelOverrides={{ note: "note.md" }}
            onClosePane={(id) => setState((s) => closePaneInState(s, id))}
            onCollapse={() => setState((s) => ({ ...s, open: false }))}
            onOpenChange={(open) => setState((s) => ({ ...s, open }))}
            onAddPane={() => {}}
            renderPane={() => (
              <>
                <input aria-label="Document draft" defaultValue="Saved document" />
                <button onClick={() => setState((s) => closePaneInState(s, "note"))}>
                  Close from document
                </button>
              </>
            )}
          />
        </div>
      </>
    );
  }
  const screen = await renderDock(<Harness />);
  const chat = document.querySelector<HTMLInputElement>('[aria-label="Chat composer"]')!;
  const host = document.querySelector<HTMLElement>('[data-testid="host"]')!;
  const covered = host.firstElementChild as HTMLElement;
  const dock = host.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
  const draft = document.querySelector<HTMLInputElement>('[aria-label="Document draft"]')!;
  await screen.getByRole("button", { name: "Maximize panel", exact: true }).click();
  expect(covered.inert).toBe(true);
  expect(covered.style.visibility).toBe("hidden");
  chat.focus();
  expect(document.activeElement).not.toBe(chat);
  await screen.getByRole("button", { name: "Resize host", exact: true }).click();
  await expect.poll(() => dock.getBoundingClientRect().width).toBe(900);
  expect(document.querySelector('[aria-label="Document draft"]')).toBe(draft);
  await screen.getByRole("button", { name: "Switch thread", exact: true }).click();
  expect(covered.inert).toBe(false);
  expect(covered.style.visibility).toBe("");
  await screen.getByRole("button", { name: "Maximize panel", exact: true }).click();
  await screen.getByRole("button", { name: "Collapse panel", exact: true }).click();
  expect(covered.inert).toBe(false);
  expect(covered.style.visibility).toBe("");
  await screen.getByRole("button", { name: "Reopen", exact: true }).click();
  await screen.getByRole("button", { name: "Maximize panel", exact: true }).click();
  await screen.getByRole("button", { name: "Close note.md", exact: true }).click();
  expect(covered.inert).toBe(false);
  expect(covered.style.visibility).toBe("");
  await expect
    .poll(
      () =>
        host.querySelector<HTMLElement>('[data-slot="sidebar-gap"]')!.getBoundingClientRect().width,
    )
    .toBe(0);
  expect(document.querySelector('[aria-label="Chat composer"]')).toBe(chat);
  expect(chat.value).toBe("Retained draft");
  chat.focus();
  expect(document.activeElement).toBe(chat);
  await screen.getByRole("button", { name: "Reopen", exact: true }).click();
  await screen.getByRole("button", { name: "Maximize panel", exact: true }).click();
  await screen.getByRole("button", { name: "Close from document", exact: true }).click();
  await expect
    .poll(
      () =>
        host.querySelector<HTMLElement>('[data-slot="sidebar-gap"]')!.getBoundingClientRect().width,
    )
    .toBe(0);
  expect(covered.inert).toBe(false);
  await screen.getByRole("button", { name: "Reopen", exact: true }).click();
  await screen.getByRole("button", { name: "Close note.md", exact: true }).click();
  expect(
    host.querySelector<HTMLElement>('[data-slot="sidebar-gap"]')!.getBoundingClientRect().width,
  ).toBeGreaterThan(0);
  await screen.getByRole("button", { name: "Reopen", exact: true }).click();
  await screen.getByRole("button", { name: "Maximize panel", exact: true }).click();
  await page.viewport(600, 800);
  await expect.poll(() => covered.inert).toBe(false);
  expect(covered.style.visibility).toBe("");
  await page.viewport(1280, 800);
  await expect.poll(() => covered.inert).toBe(true);
  await screen.unmount();
  expect(covered.inert).toBe(false);
  expect(covered.style.visibility).toBe("");
});

it("offers maximize for every pane kind, not only documents", async () => {
  await page.viewport(1280, 800);
  const state: RightDockThreadState = {
    open: true,
    activePaneId: "terminal",
    panes: [
      {
        id: "terminal",
        kind: "terminal",
        filePath: null,
        threadId: null,
        diffTurnId: null,
        diffFilePath: null,
        pullRequestProjectId: null,
        pullRequestRepository: null,
        pullRequestNumber: null,
        pullRequestInitialTab: null,
      },
    ],
  };
  const screen = await renderDock(
    <div style={{ display: "flex", width: 1000, height: 600 }}>
      <div style={{ flex: 1 }}>Chat continues</div>
      <RightDock
        state={state}
        minWidth={300}
        defaultWidth="500px"
        shouldAcceptWidth={() => true}
        addMenuKinds={[]}
        onClosePane={() => {}}
        onCollapse={() => {}}
        onOpenChange={() => {}}
        onAddPane={() => {}}
        renderPane={() => <div data-testid="terminal-pane">Terminal</div>}
      />
    </div>,
  );
  const pane = document.querySelector<HTMLElement>('[data-testid="terminal-pane"]')!;
  const container = pane.closest<HTMLElement>('[data-slot="sidebar-container"]')!;
  await screen.getByRole("button", { name: "Maximize panel", exact: true }).click();
  await expect.poll(() => container.getBoundingClientRect().width).toBe(1000);
  await screen.getByRole("button", { name: "Restore panel", exact: true }).click();
  await expect.poll(() => container.getBoundingClientRect().width).toBeLessThan(1000);
  await screen.unmount();
});

it("opens at half the shell by default and at the host's share when it asks for one", async () => {
  await page.viewport(1280, 800);
  const state: RightDockThreadState = {
    open: true,
    activePaneId: "file",
    panes: [
      {
        id: "file",
        kind: "file",
        filePath: "note.md",
        threadId: null,
        diffTurnId: null,
        diffFilePath: null,
        pullRequestProjectId: null,
        pullRequestRepository: null,
        pullRequestNumber: null,
        pullRequestInitialTab: null,
      },
    ],
  };
  const dockWidth = async (openWidthFraction: number | undefined) => {
    const screen = await renderDock(
      <div style={{ display: "flex", width: 1000, height: 600 }}>
        <div style={{ flex: 1 }}>Chat</div>
        <RightDock
          state={state}
          minWidth={200}
          defaultWidth="500px"
          {...(openWidthFraction === undefined ? {} : { openWidthFraction })}
          shouldAcceptWidth={() => true}
          addMenuKinds={[]}
          onClosePane={() => {}}
          onCollapse={() => {}}
          onOpenChange={() => {}}
          onAddPane={() => {}}
          renderPane={() => <div data-testid="pane">Pane</div>}
        />
      </div>,
    );
    const container = document
      .querySelector<HTMLElement>('[data-testid="pane"]')!
      .closest<HTMLElement>('[data-slot="sidebar-container"]')!;
    const measure = () => Math.round(container.getBoundingClientRect().width);
    return { screen, measure };
  };

  const half = await dockWidth(undefined);
  await expect.poll(half.measure).toBe(500);
  await half.screen.unmount();

  const quarter = await dockWidth(0.25);
  await expect.poll(quarter.measure).toBe(250);
  await quarter.screen.unmount();
});

it("shows its panes as content tabs that close, keep their width, and reorder", async () => {
  await page.viewport(1280, 800);
  const { useState } = await import("react");
  const { closePaneInState, createDefaultRightDockState, movePaneInState, openPaneInState } =
    await import("../../rightDockStore.logic");
  const initial = ["a.md", "b.md", "c.md", "d.md"].reduce(
    (state, filePath) => openPaneInState(state, { paneId: filePath, kind: "file", filePath }),
    createDefaultRightDockState(),
  );
  function Harness() {
    const [state, setState] = useState<RightDockThreadState>({
      ...initial,
      activePaneId: "a.md",
    });
    return (
      <div style={{ display: "flex", width: 1000, height: 600 }}>
        <div style={{ flex: 1 }}>Chat</div>
        <RightDock
          state={state}
          paneLabelOverrides={{ "a.md": "a.md", "b.md": "b.md", "c.md": "c.md", "d.md": "d.md" }}
          minWidth={300}
          defaultWidth="500px"
          shouldAcceptWidth={() => true}
          addMenuKinds={[]}
          onSelectPane={(id) => setState((s) => ({ ...s, activePaneId: id }))}
          onClosePane={(id) => setState((s) => closePaneInState(s, id))}
          onMovePane={(id, overId) => setState((s) => movePaneInState(s, id, overId))}
          onCollapse={() => {}}
          onOpenChange={() => {}}
          onAddPane={() => {}}
          renderPane={(pane) => <p>Document {pane.id}</p>}
        />
      </div>
    );
  }
  const screen = await renderDock(<Harness />);
  await expect.poll(dockTabLabels).toEqual(["a.md", "b.md", "c.md", "d.md"]);

  // Four tabs do not fit at their basis, so they shrink together rather than hug their labels.
  const widths = dockTabs().map((tab) => Math.round(tab.getBoundingClientRect().width));
  expect(new Set(widths).size).toBe(1);

  // A middle click closes an inactive tab without selecting it.
  dockTabs()[3]!.dispatchEvent(
    new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
  );
  await expect.poll(dockTabLabels).toEqual(["a.md", "b.md", "c.md"]);
  await expect.element(screen.getByText("Document a.md", { exact: true })).toBeVisible();

  // Closing from the X keeps the survivors' width while the pointer stays on the strip.
  const widthBeforeClose = dockTabs()[0]!.getBoundingClientRect().width;
  await screen.getByRole("button", { name: "Close a.md", exact: true }).click();
  await expect.poll(dockTabLabels).toEqual(["b.md", "c.md"]);
  expect(dockTabs()[0]!.getBoundingClientRect().width).toBeCloseTo(widthBeforeClose, 0);

  // Dragging a tab onto its neighbour swaps them; the pane on screen stays the active one.
  const source = dockTabs()[0]!.querySelector("button:not([aria-label])")!;
  const from = source.getBoundingClientRect();
  const to = dockTabs()[1]!.getBoundingClientRect();
  const y = from.top + from.height / 2;
  const targetX = to.left + to.width / 2;
  source.dispatchEvent(mousePointerEvent("pointerdown", from.left + from.width / 2, y));
  document.dispatchEvent(mousePointerEvent("pointermove", from.left + from.width / 2 + 8, y));
  await nextFrame();
  document.dispatchEvent(mousePointerEvent("pointermove", targetX, y));
  await nextFrame();
  document.dispatchEvent(mousePointerEvent("pointermove", targetX + 1, y));
  await nextFrame();
  document.dispatchEvent(mousePointerEvent("pointerup", targetX + 1, y));
  await expect.poll(dockTabLabels).toEqual(["c.md", "b.md"]);
  await expect.element(screen.getByText("Document b.md", { exact: true })).toBeVisible();
  await screen.unmount();
});
