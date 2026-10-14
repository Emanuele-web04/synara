import "../index.css";
import {
  ThreadId,
  ProjectId,
  type NativeApi,
  type TerminalCloseInput,
  type TerminalOpenInput,
  type TerminalWriteInput,
  type TerminalEvent,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RightDock } from "./chat/RightDock";
import { DockTerminalPane } from "./chat/DockTerminalPane";
import { selectRightDockState, useRightDockStore } from "../rightDockStore";
import { useStore } from "../store";
import { dockTerminalThreadId } from "../lib/dockTerminalScope";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { terminalRuntimeRegistry } from "./terminal/terminalRuntimeRegistry";
import { useTerminalStateStore } from "../terminalStateStore";
import { closeTerminalSurface } from "../hooks/useTerminalSurfaceController";
import { disposeAndCloseTerminalSession } from "./terminal/terminalSession";

const api = vi.hoisted(() => ({
  terminal: {
    open: vi.fn(async (input: TerminalOpenInput) => ({
      ...input,
      status: "running",
      pid: 123,
      history: "$ echo ready\r\nready\r\n$ ",
      exitCode: null,
      exitSignal: null,
      updatedAt: new Date().toISOString(),
    })),
    write: vi.fn<(input: TerminalWriteInput) => Promise<void>>(async () => {}),
    resize: vi.fn(async () => {}),
    ackOutput: vi.fn(async () => {}),
    close: vi.fn<(input: TerminalCloseInput) => Promise<void>>(async () => {}),
    onEvent: vi.fn<(listener: (event: TerminalEvent) => void) => () => void>(() => () => {}),
  },
}));
vi.mock("../nativeApi", () => ({ readNativeApi: () => api }));

afterEach(() => {
  terminalRuntimeRegistry.disposeOrphanedThreads(new Set());
  useTerminalStateStore.setState({ terminalStateByThreadId: {} });
  useRightDockStore.setState({ dockStateByThreadId: {} });
  vi.clearAllMocks();
  api.terminal.close.mockReset();
});

function panel(threadId: ThreadId, isVisible: boolean) {
  return (
    <div style={{ width: 720, height: 420 }}>
      <ThreadTerminalDrawer
        threadId={threadId}
        activeTerminalId="default"
        cwd="/tmp"
        terminalLabelsById={{ default: "Terminal" }}
        terminalTitleOverridesById={{}}
        terminalCliKindsById={{}}
        focusRequestId={0}
        onTerminalSessionExited={vi.fn()}
        onTerminalMetadataChange={vi.fn()}
        onTerminalActivityChange={vi.fn()}
        isVisible={isVisible}
      />
    </div>
  );
}

it.each(["chat-panel", "dock-terminal:chat-panel"])(
  "keeps one interactive viewport across hide/show in %s",
  async (scope) => {
    const threadId = ThreadId.makeUnsafe(scope);
    const view = await render(panel(threadId, true));
    await expect.poll(() => api.terminal.open.mock.calls.length).toBeGreaterThan(0);
    await expect
      .poll(() => document.querySelectorAll('aside[aria-label="Terminal"] .xterm').length)
      .toBe(1);
    expect(
      document.querySelectorAll('aside[aria-label="Terminal"] button[aria-label*="Split"]').length,
    ).toBe(0);
    expect(
      document.querySelectorAll('aside[aria-label="Terminal"] [data-surface-tab]').length,
    ).toBe(0);
    const viewport = document.querySelector('aside[aria-label="Terminal"] .xterm');
    await view.rerender(panel(threadId, false));
    await view.rerender(panel(threadId, true));
    expect(document.querySelector('aside[aria-label="Terminal"] .xterm')).toBe(viewport);
    expect(new Set(api.terminal.open.mock.calls.map(([input]) => input.terminalId))).toEqual(
      new Set(["default"]),
    );
    await page.getByRole("textbox", { name: "Terminal input" }).fill("pwd");
    await expect.poll(() => api.terminal.write.mock.calls.length).toBeGreaterThan(0);
    useTerminalStateStore.getState().openTerminalThreadPage(threadId);
    api.terminal.close.mockRejectedValueOnce(new Error("Connection lost"));
    await expect(closeTerminalSurface(threadId, false)).rejects.toThrow("Connection lost");
    expect(useTerminalStateStore.getState().terminalStateByThreadId[threadId]?.terminalOpen).toBe(
      true,
    );
    expect(document.querySelector('aside[aria-label="Terminal"] .xterm')).toBe(viewport);
    api.terminal.write.mockClear();
    await page.getByRole("textbox", { name: "Terminal input" }).fill("echo still connected");
    await expect.poll(() => api.terminal.write.mock.calls.length).toBeGreaterThan(0);
    const bounds = document.querySelector('aside[aria-label="Terminal"]')!.getBoundingClientRect();
    expect(bounds.height).toBe(420);
    if (scope === "chat-panel")
      await page.screenshot({ path: "../../../../output/playwright/single-terminal-panel.png" });
    await expect(closeTerminalSurface(threadId, false)).resolves.toBe(true);
    expect(useTerminalStateStore.getState().terminalStateByThreadId[threadId]?.terminalOpen).toBe(
      false,
    );
    expect(document.querySelector('aside[aria-label="Terminal"] .xterm')).toBeNull();
    await view.unmount();
  },
);

it("keeps busy legacy sessions pending and retires them on a later idle mount", async () => {
  const threadId = ThreadId.makeUnsafe("legacy-layout");
  const store = useTerminalStateStore.getState();
  store.openTerminalThreadPage(threadId);
  useTerminalStateStore.setState((state) => ({
    terminalStateByThreadId: {
      ...state.terminalStateByThreadId,
      [threadId]: { ...state.terminalStateByThreadId[threadId]!, retiredTerminalIds: ["old-tab"] },
    },
  }));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  api.terminal.close.mockImplementationOnce(async (input) => {
    if (input.onlyIfIdle) throw new Error("Terminal is busy");
  });
  const view = await render(panel(threadId, true));
  await expect.poll(() => api.terminal.close.mock.calls.length).toBe(1);
  await expect.poll(() => error.mock.calls.length).toBe(1);
  expect(
    useTerminalStateStore.getState().terminalStateByThreadId[threadId]?.retiredTerminalIds,
  ).toEqual(["old-tab"]);
  expect(api.terminal.write).not.toHaveBeenCalled();
  await view.unmount();
  error.mockRestore();

  const reopened = await render(panel(threadId, true));
  await expect
    .poll(
      () => useTerminalStateStore.getState().terminalStateByThreadId[threadId]?.retiredTerminalIds,
    )
    .toEqual([]);
  expect(api.terminal.close).toHaveBeenLastCalledWith({
    threadId,
    terminalId: "old-tab",
    onlyIfIdle: true,
    deleteHistory: false,
  });
  await reopened.unmount();
});

it("keeps a reopened shell alive when cleanup of the exited shell finishes later", async () => {
  const threadId = ThreadId.makeUnsafe("reopened-shell");
  const view = await render(panel(threadId, true));
  await expect.poll(() => api.terminal.open.mock.calls.length).toBe(1);
  let finishClose = () => {};
  const pendingClose = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  api.terminal.close.mockReturnValueOnce(pendingClose);
  const cleanup = disposeAndCloseTerminalSession({
    api: api as unknown as NativeApi,
    threadId,
    terminalId: "default",
    processAlreadyExited: true,
  });
  try {
    await expect
      .poll(() => document.querySelector('aside[aria-label="Terminal"] .xterm'))
      .toBeNull();
    await view.unmount();
    const reopened = await render(panel(threadId, true));
    await expect.poll(() => api.terminal.open.mock.calls.length).toBe(2);
    const viewport = document.querySelector('aside[aria-label="Terminal"] .xterm');
    expect(viewport).not.toBeNull();
    finishClose();
    await cleanup;
    expect(document.querySelector('aside[aria-label="Terminal"] .xterm')).toBe(viewport);
    await page.getByRole("textbox", { name: "Terminal input" }).fill("pwd");
    await expect.poll(() => api.terminal.write.mock.calls.length).toBeGreaterThan(0);
    await reopened.unmount();
  } finally {
    finishClose();
    await cleanup;
  }
});

const dockHostId = ThreadId.makeUnsafe("multiple-dock-terminals");
const dockProjectId = ProjectId.makeUnsafe("terminal-project");

function TerminalDock() {
  const state = useRightDockStore(selectRightDockState(dockHostId));
  const store = useRightDockStore.getState();
  return (
    <RightDock
      state={state}
      minWidth={300}
      defaultWidth="50vw"
      shouldAcceptWidth={() => true}
      addMenuKinds={["terminal"]}
      onSelectPane={(paneId) => store.setActivePane(dockHostId, paneId)}
      onClosePane={(paneId) => {
        void closeTerminalSurface(dockTerminalThreadId(dockHostId), false, paneId).then(
          (closed) => {
            if (closed) store.closePane(dockHostId, paneId);
          },
        );
      }}
      onCollapse={() => store.setDockOpen(dockHostId, false)}
      onOpenChange={(open) => store.setDockOpen(dockHostId, open)}
      onAddPane={(kind) => store.openPane(dockHostId, { kind })}
      renderPane={(pane, context) => (
        <DockTerminalPane
          hostThreadId={dockHostId}
          paneId={pane.id}
          projectId={dockProjectId}
          isActive={context.isVisible}
          onClosePanel={() => store.closePane(dockHostId, pane.id)}
        />
      )}
    />
  );
}

it("opens independent shells through the plus menu and keeps siblings interactive after closing a tab", async () => {
  await page.viewport(1280, 800);
  const previousProjects = useStore.getState().projects;
  useStore.setState({
    projects: [
      {
        id: dockProjectId,
        kind: "project",
        name: "Terminal project",
        remoteName: "",
        folderName: "tmp",
        localName: null,
        cwd: "/tmp",
        defaultModelSelection: null,
        expanded: true,
        scripts: [],
      },
    ],
  });
  useRightDockStore.getState().openPane(dockHostId, { kind: "terminal" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <div style={{ display: "flex", width: 1280, height: 800 }}>
        <div style={{ flex: 1 }}>Chat</div>
        <TerminalDock />
      </div>
    </QueryClientProvider>,
  );
  const scopeId = dockTerminalThreadId(dockHostId);
  const panes = () => useRightDockStore.getState().dockStateByThreadId[dockHostId]!.panes;
  try {
    await expect.poll(() => api.terminal.open.mock.calls.length).toBe(1);
    for (const count of [2, 3]) {
      await page.getByRole("button", { name: "Add panel", exact: true }).click();
      await page.getByRole("menuitem", { name: "Terminal", exact: true }).click();
      await expect.poll(() => panes().length).toBe(count);
      await expect.poll(() => api.terminal.open.mock.calls.length).toBe(count);
    }
    const sessions = api.terminal.open.mock.calls.map(([input]) => input.terminalId);
    expect(new Set(sessions).size).toBe(3);
    expect(api.terminal.open.mock.calls.every(([input]) => input.threadId === scopeId)).toBe(true);
    const tabs = page.getByRole("button", { name: "Terminal", exact: true });
    await tabs.nth(0).click();
    await page.getByRole("textbox", { name: "Terminal input" }).fill("echo first");
    await expect
      .poll(() => api.terminal.write.mock.lastCall?.[0])
      .toMatchObject({
        threadId: scopeId,
        terminalId: sessions[0],
      });
    await page.getByRole("button", { name: "Close Terminal", exact: true }).nth(1).click();
    await expect.poll(() => panes().length).toBe(2);
    expect(api.terminal.close).toHaveBeenLastCalledWith(
      expect.objectContaining({
        threadId: scopeId,
        terminalId: sessions[1],
      }),
    );
    await tabs.nth(1).click();
    await page.getByRole("textbox", { name: "Terminal input" }).fill("echo third");
    await expect
      .poll(() => api.terminal.write.mock.lastCall?.[0])
      .toMatchObject({
        threadId: scopeId,
        terminalId: sessions[2],
      });
    expect(api.terminal.open.mock.calls).toHaveLength(3);
    await page.screenshot({ path: "../../../../output/playwright/multiple-dock-terminals.png" });
    await tabs.nth(0).click();
    api.terminal.onEvent.mock.lastCall![0]({
      type: "exited",
      threadId: scopeId,
      terminalId: sessions[2]!,
      exitCode: 0,
      exitSignal: null,
      createdAt: new Date().toISOString(),
    });
    await expect.poll(() => panes().length).toBe(1);
    await page.getByRole("textbox", { name: "Terminal input" }).fill("echo still alive");
    await expect
      .poll(() => api.terminal.write.mock.lastCall?.[0])
      .toMatchObject({
        threadId: scopeId,
        terminalId: sessions[0],
      });
    expect(api.terminal.open.mock.calls).toHaveLength(3);
  } finally {
    await view.unmount();
    client.clear();
    useStore.setState({ projects: previousProjects });
  }
});
