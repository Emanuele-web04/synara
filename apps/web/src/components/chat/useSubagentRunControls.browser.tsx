import { ThreadId } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useSubagentRunControls } from "./useSubagentRunControls";

const state = vi.hoisted(() => ({
  provider: "devin",
  nested: false,
  dispatch: vi.fn(async (_command: unknown) => {}),
}));
vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({ orchestration: { dispatchCommand: state.dispatch } }),
}));
vi.mock("../../store", () => ({ useStore: { getState: () => ({}) } }));
vi.mock("../../threadDerivation", () => ({
  getThreadFromState: (_snapshot: unknown, id: string) =>
    id === "outer-child"
      ? { id, parentThreadId: "parent", session: null, latestTurn: null }
      : {
          id: "parent",
          parentThreadId: null,
          session: { provider: state.provider, status: "ready" },
          latestTurn: null,
        },
}));
vi.mock("../ChatView.selectors", () => ({
  localSubagentThreadId: (parent: string, child: string) => `subagent:${parent}:${child}`,
}));
function Controls() {
  const { stopSubagent } = useSubagentRunControls(
    ThreadId.makeUnsafe(state.nested ? "outer-child" : "parent"),
  );
  return (
    <button onClick={() => void stopSubagent({ providerThreadId: "child-agent" })}>
      Stop child
    </button>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
});
it.each([
  ["devin", false],
  ["devin", true],
  ["claudeAgent", false],
  ["claudeAgent", true],
] as const)(
  "stops %s children with a nested source=%s while the parent is ready",
  async (provider, nested) => {
    state.nested = nested;
    state.provider = provider;
    await render(<Controls />);
    await page.getByRole("button", { name: "Stop child" }).click();
    expect(state.dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(
        provider === "devin"
          ? { type: "thread.task.stop", threadId: "parent", taskId: "child-agent" }
          : {
              type: "thread.turn.interrupt",
              threadId: `subagent:${nested ? "outer-child" : "parent"}:child-agent`,
            },
      ),
    );
  },
);
