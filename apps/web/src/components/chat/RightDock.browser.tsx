import { page } from "vitest/browser";
import "../../index.css";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { RightDock } from "./RightDock";
import type { RightDockThreadState } from "../../rightDockStore.logic";

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
  const screen = await render(
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
  const screen = await render(<Harness />);
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
  const screen = await render(<Harness />);
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
