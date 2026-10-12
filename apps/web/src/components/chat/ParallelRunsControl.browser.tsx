import "../../index.css";
import {
  type ModelSelection,
  type ServerProviderStatus,
  ThreadId,
  MessageId,
  TurnId,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render, cleanup } from "vitest-browser-react";
import { makeThread, makeProject, makeReadModelThread } from "../../storeTestFixtures";

const harness = vi.hoisted(() => ({
  summaries: {} as Record<string, unknown>,
  startParallelRun: vi.fn(),
  getThreadDetailSnapshot: vi.fn(),
  getShellSnapshot: vi.fn(),
  dispatchCommand: vi.fn(async () => ({ sequence: 1 })),
  readWorkingTreeDiff: vi.fn(async () => ({ patch: "+independent change", truncated: false })),
}));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ orchestration: harness, git: harness }),
  readNativeApi: () => ({ orchestration: harness, git: harness }),
}));
import { ParallelRunsControl } from "./ParallelRunsControl";
import { useStore } from "../../store";

const initialStoreState = useStore.getState();

const selection: ModelSelection = { provider: "codex", instanceId: "codex", model: "gpt-5-codex" };
const providers: ServerProviderStatus[] = [
  {
    provider: "codex",
    instanceId: "codex",
    driver: "codex",
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-10-11T10:00:00.000Z",
  },
];
const picker = {
  providers,
  modelOptionsByProvider: {
    codex: [{ slug: "gpt-5-codex", name: "GPT-5 Codex" }],
    claudeAgent: [],
    cursor: [],
    antigravity: [],
    grok: [],
    droid: [],
    opencode: [],
    devin: [],
    pi: [],
    omp: [],
  },
};

async function mount(thread = makeThread()) {
  useStore.setState({
    sidebarThreadSummaryById: harness.summaries as ReturnType<
      typeof useStore.getState
    >["sidebarThreadSummaryById"],
  });
  await page.viewport(1280, 900);
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ParallelRunsControl
        thread={thread}
        project={makeProject()}
        selection={selection}
        picker={picker}
        onNavigate={vi.fn()}
      />
    </QueryClientProvider>,
  );
}
afterEach(async () => {
  await cleanup();
  useStore.setState(initialStoreState, true);
  harness.summaries = {};
  vi.clearAllMocks();
});

it("bounds attempts at three and retries a failed admission with the original request", async () => {
  harness.startParallelRun
    .mockRejectedValueOnce(new Error("Connection lost"))
    .mockResolvedValueOnce({
      threadIds: [ThreadId.makeUnsafe("first")],
      baseCommit: "a".repeat(40),
    });
  const screen = await mount();
  await screen.getByRole("button", { name: "Parallel run" }).click();
  await screen.getByRole("textbox", { name: "Task for every attempt" }).fill("Implement the task");
  await screen.getByRole("button", { name: "Add third attempt" }).click();
  await expect.element(screen.getByText("Attempt 3")).toBeVisible();
  await vi.waitFor(() =>
    expect(getComputedStyle(document.querySelector('[role="dialog"]')!).opacity).toBe("1"),
  );
  await page.screenshot({ path: "node_modules/.cache/parallel-run-launch.png" });
  await screen.getByRole("button", { name: "Start 3 attempts" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Connection lost");
  await screen.getByRole("button", { name: "Retry same run" }).click();
  await vi.waitFor(() => expect(harness.startParallelRun).toHaveBeenCalledTimes(2));
  expect(harness.startParallelRun.mock.calls[1]?.[0]).toEqual(
    harness.startParallelRun.mock.calls[0]?.[0],
  );
  expect(harness.startParallelRun.mock.calls[0]?.[0].attempts).toHaveLength(3);
});

it("shows answers and diffs, then preserves the winner and archives only its sibling", async () => {
  const parallelRun = {
    runId: "run",
    index: 0,
    count: 2,
    baseCommit: "a".repeat(40),
    requestHash: "b".repeat(64),
  };
  const first = makeReadModelThread({
    parallelRun,
    latestTurn: {
      turnId: TurnId.makeUnsafe("turn"),
      state: "completed",
      requestedAt: "2026-10-11T10:00:00.000Z",
      startedAt: null,
      completedAt: "2026-10-11T10:01:00.000Z",
      assistantMessageId: null,
    },
    worktreePath: "/attempt-one",
    branch: "attempt-one",
    messages: [
      {
        id: MessageId.makeUnsafe("answer"),
        role: "assistant",
        text: "Implemented the task with focused validation.",
        turnId: null,
        streaming: false,
        source: "native",
        createdAt: "2026-10-11T10:01:00.000Z",
        updatedAt: "2026-10-11T10:01:00.000Z",
      },
    ],
  });
  const second = {
    ...first,
    id: ThreadId.makeUnsafe("second"),
    parallelRun: { ...parallelRun, index: 1 },
    branch: "attempt-two",
    worktreePath: "/attempt-two",
  };
  harness.summaries = { [first.id]: first, [second.id]: second };
  harness.getShellSnapshot.mockResolvedValue({ threads: [first, second] });
  harness.getThreadDetailSnapshot.mockImplementation(async ({ threadId }) => ({
    thread: threadId === first.id ? first : second,
  }));
  const screen = await mount(makeThread({ parallelRun }));
  await screen.getByRole("button", { name: "Compare attempts" }).click();
  await expect.element(screen.getByText("attempt-two", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Compare in new thread" })).toBeEnabled();
  await vi.waitFor(() =>
    expect(getComputedStyle(document.querySelector('[role="dialog"]')!).opacity).toBe("1"),
  );
  await page.screenshot({ path: "node_modules/.cache/parallel-run-compare.png" });
  await screen.getByRole("button", { name: "Keep this attempt" }).first().click();
  await vi.waitFor(() => expect(harness.dispatchCommand).toHaveBeenCalledOnce());
  expect(harness.dispatchCommand).toHaveBeenCalledWith(
    expect.objectContaining({ type: "thread.archive", threadId: second.id }),
  );
});

it("recovers an incomplete launch after reload using its durable request", async () => {
  const request = {
    runId: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-10-11T10:00:00.000Z",
    sourceThreadId: ThreadId.makeUnsafe("source"),
    prompt: "Persisted task",
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    attempts: [selection, selection],
  };
  const parallelRun = {
    runId: request.runId,
    index: 0,
    count: 2,
    baseCommit: "a".repeat(40),
    requestHash: "b".repeat(64),
    request,
  };
  const thread = makeReadModelThread({ parallelRun });
  harness.summaries = { [thread.id]: thread };
  harness.getThreadDetailSnapshot.mockResolvedValue({ thread });
  harness.startParallelRun.mockResolvedValue({
    threadIds: [thread.id, ThreadId.makeUnsafe("second")],
    baseCommit: parallelRun.baseCommit,
  });
  const screen = await mount(makeThread({ parallelRun }));
  await screen.getByRole("button", { name: "Compare attempts" }).click();
  await screen.getByRole("button", { name: "Resume launch" }).click();
  await vi.waitFor(() => expect(harness.startParallelRun).toHaveBeenCalledWith(request));
});
