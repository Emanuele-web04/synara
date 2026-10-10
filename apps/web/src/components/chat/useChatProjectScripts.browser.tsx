import { type TerminalCloseInput, type TerminalOpenInput } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { dockTerminalThreadId } from "../../lib/dockTerminalScope";
import { selectRightDockState, useRightDockStore } from "../../rightDockStore";
import { makeProject, makeThread } from "../../storeTestFixtures";
import { useTerminalStateStore } from "../../terminalStateStore";
import { useChatProjectScripts } from "./useChatProjectScripts";

const api = vi.hoisted(() => ({
  terminal: {
    close: vi.fn<(input: TerminalCloseInput) => Promise<void>>(async () => {}),
    open: vi.fn(async (input: TerminalOpenInput) => ({ ...input, status: "running" })),
    write: vi.fn(async () => {}),
  },
}));
vi.mock("../../nativeApi", () => ({ readNativeApi: () => api, ensureNativeApi: () => api }));

afterEach(() => {
  useTerminalStateStore.setState({ terminalStateByThreadId: {} });
  useRightDockStore.setState({ dockStateByThreadId: {} });
  vi.clearAllMocks();
  api.terminal.close.mockReset();
});

it.each([
  { writeFails: false, missingTarget: false, siblingBusy: true },
  { writeFails: true, missingTarget: false, siblingBusy: true },
  { writeFails: false, missingTarget: true, siblingBusy: false },
  { writeFails: false, missingTarget: true, siblingBusy: true },
])(
  "runs actions in the right dock without replacing siblings (write fails: $writeFails, missing target: $missingTarget, sibling busy: $siblingBusy)",
  async ({ writeFails, missingTarget, siblingBusy }) => {
    const project = makeProject();
    const thread = makeThread({ projectId: project.id });
    const store = useTerminalStateStore.getState();
    const scopeId = dockTerminalThreadId(thread.id);
    store.newTerminal(thread.id, "center-shell");
    store.setTerminalActivity(thread.id, "center-shell", {
      hasRunningSubprocess: true,
      agentState: null,
    });
    store.newTerminal(scopeId, "restored-shell");
    store.ensureDockTerminal(scopeId, "action-pane");
    store.ensureDockTerminal(scopeId, "sibling-pane");
    const siblingId =
      useTerminalStateStore.getState().terminalStateByThreadId[scopeId]!.dockTerminalIdsByPaneId![
        "sibling-pane"
      ]!;
    store.setTerminalActivity(scopeId, siblingId, {
      hasRunningSubprocess: siblingBusy,
      agentState: null,
    });
    if (missingTarget) store.closeTerminal(scopeId, "restored-shell");
    else store.setActiveTerminal(scopeId, "restored-shell");
    store.setTerminalOpen(scopeId, false);
    useRightDockStore.getState().openPane(thread.id, { kind: "terminal", paneId: "sibling-pane" });
    useRightDockStore.getState().openPane(thread.id, { kind: "terminal", paneId: "action-pane" });
    const centerState = useTerminalStateStore.getState().terminalStateByThreadId[thread.id];
    if (!missingTarget) useRightDockStore.getState().openPane(thread.id, { kind: "git" });
    useRightDockStore.getState().setDockOpen(thread.id, false);
    // Hydration does not restore activity; the renderer cannot authorize a close.
    expect(
      useTerminalStateStore.getState().terminalStateByThreadId[scopeId]?.runningTerminalIds,
    ).toEqual(siblingBusy ? [siblingId] : []);
    const setThreadError = vi.fn();
    const queryClient = new QueryClient();
    function ScriptAction() {
      const { runProjectScript } = useChatProjectScripts({
        activeThreadId: thread.id,
        activeThread: thread,
        activeProject: project,
        gitCwd: project.cwd,
        isGroupContainer: false,
        setThreadError,
      });
      return (
        <button
          onClick={() =>
            void runProjectScript(
              {
                id: "build",
                name: "Build",
                command: "bun run build",
                icon: "play",
                runOnWorktreeCreate: false,
              },
              { rememberAsLastInvoked: false },
            )
          }
        >
          Run build
        </button>
      );
    }
    if (!missingTarget)
      api.terminal.close.mockImplementationOnce(async (input) => {
        if (input.onlyIfIdle) throw new Error("The terminal is busy.");
      });
    const view = await render(
      <QueryClientProvider client={queryClient}>
        <ScriptAction />
      </QueryClientProvider>,
    );
    if (!missingTarget) {
      await page.getByRole("button", { name: "Run build" }).click();
      await expect.poll(() => setThreadError.mock.calls.length).toBe(1);
      expect(api.terminal.open).not.toHaveBeenCalled();
      expect(api.terminal.write).not.toHaveBeenCalled();
      expect(
        useTerminalStateStore.getState().terminalStateByThreadId[scopeId]?.activeTerminalId,
      ).toBe("restored-shell");
    }

    if (writeFails) api.terminal.write.mockRejectedValueOnce(new Error("Command delivery failed"));
    await page.getByRole("button", { name: "Run build" }).click();
    await expect.poll(() => api.terminal.write.mock.calls.length).toBe(1);
    if (missingTarget) expect(api.terminal.close).not.toHaveBeenCalled();
    else
      expect(api.terminal.close).toHaveBeenLastCalledWith({
        threadId: scopeId,
        terminalId: "restored-shell",
        deleteHistory: false,
        onlyIfIdle: true,
      });
    expect(api.terminal.open).toHaveBeenCalledTimes(1);
    const launched = api.terminal.open.mock.calls[0]![0];
    expect(launched.threadId).toBe(scopeId);
    expect(launched.cwd).toBe(project.cwd);
    expect(launched.terminalId).not.toBe("restored-shell");
    const launchedState = useTerminalStateStore.getState().terminalStateByThreadId[scopeId]!;
    expect(launchedState.terminalIds).toEqual(
      expect.arrayContaining([siblingId, launched.terminalId]),
    );
    expect(launchedState.dockTerminalIdsByPaneId).toEqual({
      "sibling-pane": siblingId,
      "action-pane": launched.terminalId,
    });
    expect(useTerminalStateStore.getState().terminalStateByThreadId[thread.id]).toEqual(
      centerState,
    );
    const dock = selectRightDockState(thread.id)(useRightDockStore.getState());
    expect(dock.open).toBe(true);
    expect(dock.activePaneId).toBe("action-pane");
    expect(dock.panes.filter((pane) => pane.kind === "terminal")).toHaveLength(2);
    expect(dock.panes.some((pane) => pane.kind === "git")).toBe(!missingTarget);
    if (writeFails) {
      await expect.poll(() => setThreadError.mock.lastCall?.[1]).toBe("Command delivery failed");
    }
    await view.unmount();
    queryClient.clear();
  },
);
