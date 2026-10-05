import { type TerminalCloseInput, type TerminalOpenInput } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
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
  vi.clearAllMocks();
  api.terminal.close.mockReset();
});

it("preserves a restored busy terminal and starts an action only after the server allows replacement", async () => {
  const project = makeProject();
  const thread = makeThread({ projectId: project.id });
  const store = useTerminalStateStore.getState();
  store.newTerminal(thread.id, "restored-shell");
  store.setTerminalOpen(thread.id, false);
  // Hydration does not restore activity; the renderer cannot authorize a close.
  expect(
    useTerminalStateStore.getState().terminalStateByThreadId[thread.id]?.runningTerminalIds,
  ).toEqual([]);
  const setThreadError = vi.fn();
  const queryClient = new QueryClient();
  function ScriptAction() {
    const { runProjectScript } = useChatProjectScripts({
      activeThreadId: thread.id,
      activeThread: thread,
      activeProject: project,
      gitCwd: project.cwd,
      isGroupContainer: false,
      requestTerminalFocus: () => {},
      setTerminalOpen: (open) => store.setTerminalOpen(thread.id, open),
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
  api.terminal.close.mockImplementationOnce(async (input) => {
    if (input.onlyIfIdle) throw new Error("The terminal is busy.");
  });
  const view = await render(
    <QueryClientProvider client={queryClient}>
      <ScriptAction />
    </QueryClientProvider>,
  );
  await page.getByRole("button", { name: "Run build" }).click();
  await expect.poll(() => setThreadError.mock.calls.length).toBe(1);
  expect(api.terminal.open).not.toHaveBeenCalled();
  expect(api.terminal.write).not.toHaveBeenCalled();
  expect(
    useTerminalStateStore.getState().terminalStateByThreadId[thread.id]?.activeTerminalId,
  ).toBe("restored-shell");

  await page.getByRole("button", { name: "Run build" }).click();
  await expect.poll(() => api.terminal.write.mock.calls.length).toBe(1);
  expect(api.terminal.close).toHaveBeenLastCalledWith({
    threadId: thread.id,
    terminalId: "restored-shell",
    deleteHistory: false,
    onlyIfIdle: true,
  });
  expect(api.terminal.open).toHaveBeenCalledTimes(1);
  const launched = api.terminal.open.mock.calls[0]![0];
  expect(launched.cwd).toBe(project.cwd);
  expect(launched.terminalId).not.toBe("restored-shell");
  expect(useTerminalStateStore.getState().terminalStateByThreadId[thread.id]?.terminalIds).toEqual([
    launched.terminalId,
  ]);
  await view.unmount();
  queryClient.clear();
});
