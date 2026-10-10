import { useStore } from "../../store";
import { initialState } from "../../storeState";
import { ApprovalRequestId, ThreadId, TurnId } from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { resetComposerDraftStore } from "../../composerDraftStoreTestFixtures";
import { makeActivity, makeState, makeThread } from "../../storeTestFixtures";
import { adoptVerifiedThreadCacheIdentity } from "../../threadDetailCacheIdentity";
import { startThreadDetailCachePersistence } from "../../threadDetailCache";
import type { Thread } from "../../types";
import { useChatPendingInteractions } from "./useChatPendingInteractions";
const api = vi.hoisted(() => ({ dispatchCommand: vi.fn(), subscribeThread: vi.fn() }));
vi.mock("../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  readNativeApi: () => ({ orchestration: api }),
}));

afterEach(() => {
  resetComposerDraftStore();
  useStore.setState(initialState);
  api.dispatchCommand.mockReset();
  api.subscribeThread.mockReset();
});

it("does not deliver a queued pending-input response after identity invalidates detail", async () => {
  const thread = threadWithPendingRequests({
    provider: "codex",
    status: "running",
    orchestrationStatus: "running",
    activeTurnId: turnId,
    createdAt,
    updatedAt: createdAt,
  });
  adoptVerifiedThreadCacheIdentity("input-identity-before");
  useStore.setState({
    ...makeState(thread),
    threadDetailSyncById: { [threadId]: "synced" },
    threadDetailAppliedSequenceById: { [threadId]: 20 },
  });
  const stop = startThreadDetailCachePersistence();
  api.dispatchCommand.mockResolvedValue({});
  api.subscribeThread.mockResolvedValue({});
  const screen = await renderPendingInteractions(thread);
  try {
    expect(screen.result.current.pendingUserInputs).toHaveLength(1);
    screen.result.current.onCancelActivePendingUserInput();
    adoptVerifiedThreadCacheIdentity("input-identity-after");
    expect(useStore.getState().threadDetailSyncById?.[threadId]).toBe("cached");
    await Promise.resolve();
    expect(api.dispatchCommand).not.toHaveBeenCalled();
  } finally {
    stop();
    await screen.unmount();
  }
});

const threadId = ThreadId.makeUnsafe("pending-gate-thread");
const turnId = TurnId.makeUnsafe("pending-gate-turn");
const createdAt = "2026-10-06T19:53:00.000Z";

function threadWithPendingRequests(session: Thread["session"]): Thread {
  const approvalId = ApprovalRequestId.makeUnsafe("pending-gate-approval");
  const userInputId = ApprovalRequestId.makeUnsafe("pending-gate-question");
  return makeThread({
    id: threadId,
    session,
    latestTurn: {
      turnId,
      state: "running",
      requestedAt: createdAt,
      startedAt: createdAt,
      completedAt: null,
      assistantMessageId: null,
    },
    hasPendingApprovals: true,
    hasPendingUserInput: true,
    activities: [
      makeActivity({
        id: "pending-gate-approval-requested",
        kind: "approval.requested",
        tone: "approval",
        createdAt,
        sequence: 1,
        turnId,
        payload: {
          requestId: approvalId,
          requestKind: "command",
          requestType: "command_execution_approval",
          detail: "Command: git status",
        },
      }),
      makeActivity({
        id: "pending-gate-question-requested",
        kind: "user-input.requested",
        tone: "info",
        createdAt,
        sequence: 2,
        turnId,
        payload: {
          requestId: userInputId,
          questions: [{ id: "next", header: "Next", question: "Continue?", options: [] }],
        },
      }),
    ],
  });
}

function renderPendingInteractions(thread: Thread) {
  return renderHook(() =>
    useChatPendingInteractions({
      threadId,
      activeThread: thread,
      runtimeMode: "approval-required",
      promptRef: { current: "" },
      setPrompt: () => undefined,
      setComposerCursor: () => undefined,
      setComposerTrigger: () => undefined,
      setComposerHighlightedItemId: () => undefined,
    }),
  );
}

it("keeps pending requests of a live session actionable", async () => {
  const { result } = await renderPendingInteractions(
    threadWithPendingRequests({
      provider: "codex",
      status: "running",
      orchestrationStatus: "running",
      activeTurnId: turnId,
      createdAt,
      updatedAt: createdAt,
    }),
  );
  expect(result.current.pendingApprovals).toHaveLength(1);
  expect(result.current.activePendingApproval?.requestId).toBe("pending-gate-approval");
  expect(result.current.pendingUserInputs).toHaveLength(1);
});

it.each([
  ["stopped", "closed"],
  ["error", "error"],
] as const)(
  "does not hold the composer on requests a %s session can no longer answer",
  async (orchestrationStatus, status) => {
    // Matches the sidebar pill, Kanban and Tasks gating: a closed or errored
    // session has no live provider callback to deliver an answer to.
    const { result } = await renderPendingInteractions(
      threadWithPendingRequests({
        provider: "codex",
        status,
        orchestrationStatus,
        activeTurnId: undefined,
        createdAt,
        updatedAt: createdAt,
      }),
    );
    expect(result.current.pendingApprovals).toEqual([]);
    expect(result.current.activePendingApproval).toBeNull();
    expect(result.current.pendingUserInputs).toEqual([]);
  },
);

it("holds cached approvals and input controls until replay confirms authority", async () => {
  useStore.setState({ threadDetailSyncById: { [threadId]: "cached" } });
  const { result } = await renderPendingInteractions(
    threadWithPendingRequests({
      provider: "codex",
      status: "running",
      orchestrationStatus: "running",
      activeTurnId: turnId,
      createdAt,
      updatedAt: createdAt,
    }),
  );
  expect(result.current.pendingApprovals).toEqual([]);
  expect(result.current.pendingUserInputs).toEqual([]);
  useStore.getState().confirmThreadDetailReplay(threadId);
  await expect.poll(() => result.current.pendingApprovals.length).toBe(1);
});
