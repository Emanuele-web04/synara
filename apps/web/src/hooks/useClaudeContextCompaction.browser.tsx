import { MessageId, ThreadId, TurnId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import { useStore } from "../store";
import { initialState } from "../storeState";
import { makeActivity, makeState, makeThread } from "../storeTestFixtures";
import { useComposerDraftStore } from "../composerDraftStore";
import { useClaudeCompactionRequests } from "../lib/claudeCompactionRequests";
import { useClaudeContextCompaction } from "./useClaudeContextCompaction";

const mocks = vi.hoisted(() => ({ dispatchCommand: vi.fn(), toast: vi.fn() }));
vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({ orchestration: { dispatchCommand: mocks.dispatchCommand } }),
  ensureNativeApi: () => ({ orchestration: { dispatchCommand: mocks.dispatchCommand } }),
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
const threadId = ThreadId.makeUnsafe("claude-compact-thread");
const thread = makeThread({
  id: threadId,
  modelSelection: {
    provider: "claudeAgent",
    model: "claude-opus-4-6",
    options: { effort: "high", autoCompactWindow: "1m" },
  },
  runtimeMode: "approval-required",
  interactionMode: "plan",
  session: {
    provider: "claudeAgent",
    status: "ready",
    orchestrationStatus: "ready",
    createdAt: "2026-09-16T10:00:00.000Z",
    updatedAt: "2026-09-16T10:00:00.000Z",
  },
});

beforeEach(() => {
  useClaudeCompactionRequests.setState({ requests: {} });
  useStore.setState(initialState);
  useStore.setState(makeState(thread));
  mocks.dispatchCommand.mockReset().mockResolvedValue(undefined);
  mocks.toast.mockReset();
});

function callbacks() {
  return { onBegin: vi.fn(), onAccepted: vi.fn(), onFailure: vi.fn() };
}

describe("useClaudeContextCompaction", () => {
  it("uses the exact native command without sending draft settings or attachments", async () => {
    useComposerDraftStore.getState().setPrompt(threadId, "Keep this draft for later");
    const actions = callbacks();
    const hook = await renderHook(() =>
      useClaudeContextCompaction({ threadId, disabledReason: null, ...actions }),
    );
    try {
      expect(await hook.result.current.compact()).toBe(true);
      const command = mocks.dispatchCommand.mock.calls[0]?.[0];
      expect(command).toMatchObject({
        type: "thread.turn.start",
        threadId,
        message: { text: "/compact", role: "user", attachments: [] },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        dispatchMode: "queue",
      });
      expect(command).not.toHaveProperty("modelSelection");
      expect(command).not.toHaveProperty("providerOptions");
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
        "Keep this draft for later",
      );
      expect(actions.onBegin).toHaveBeenCalledExactlyOnceWith({
        expectedUserMessageId: command.message.messageId,
      });
      expect(actions.onAccepted).toHaveBeenCalledExactlyOnceWith(threadId);
      expect(actions.onFailure).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });

  it("rejects a repeated click while the same native command is being accepted", async () => {
    let release: (() => void) | undefined;
    mocks.dispatchCommand.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const hook = await renderHook(() =>
      useClaudeContextCompaction({ threadId, disabledReason: null, ...callbacks() }),
    );
    try {
      const first = hook.result.current.compact();
      expect(await hook.result.current.compact()).toBe(false);
      expect(mocks.dispatchCommand).toHaveBeenCalledTimes(1);
      release?.();
      expect(await first).toBe(true);
    } finally {
      await hook.unmount();
    }
  });

  it("rechecks durable held state even if the button rendered before the review arrived", async () => {
    const hook = await renderHook(() =>
      useClaudeContextCompaction({ threadId, disabledReason: null, ...callbacks() }),
    );
    try {
      useStore.setState(
        makeState(
          makeThread({
            ...thread,
            claudeCacheReview: {
              reviewId: "review-1",
              messageId: MessageId.makeUnsafe("pending-message"),
              sourceEventSequence: 1,
              status: "pending",
              createdAt: "2026-09-16T10:00:00.000Z",
              assessment: {
                observedAt: "2026-09-16T10:00:00.000Z",
                state: "likely-expired",
                source: "session-start",
              },
            },
          }),
        ),
      );
      expect(await hook.result.current.compact()).toBe(false);
      expect(mocks.dispatchCommand).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });

  it("recognizes a saved native command when the RPC acknowledgement is lost", async () => {
    const actions = callbacks();
    mocks.dispatchCommand.mockImplementation(async (command) => {
      useStore.setState(
        makeState(
          makeThread({
            ...thread,
            messages: [
              {
                id: command.message.messageId,
                role: "user",
                text: "/compact",
                createdAt: command.createdAt,
                streaming: false,
              },
            ],
          }),
        ),
      );
      throw new Error("Disconnected after acceptance");
    });
    const hook = await renderHook(() =>
      useClaudeContextCompaction({ threadId, disabledReason: null, ...actions }),
    );
    try {
      expect(await hook.result.current.compact()).toBe(true);
      expect(actions.onAccepted).toHaveBeenCalledExactlyOnceWith(threadId);
      expect(actions.onFailure).not.toHaveBeenCalled();
      expect(mocks.toast).not.toHaveBeenCalled();
    } finally {
      await hook.unmount();
    }
  });

  it("does not automatically retry or report compaction complete when dispatch fails", async () => {
    const actions = callbacks();
    mocks.dispatchCommand.mockRejectedValue(new Error("Connection unavailable"));
    const hook = await renderHook(() =>
      useClaudeContextCompaction({ threadId, disabledReason: null, ...actions }),
    );
    try {
      expect(await hook.result.current.compact()).toBe(false);
      expect(mocks.dispatchCommand).toHaveBeenCalledTimes(1);
      expect(actions.onAccepted).not.toHaveBeenCalled();
      expect(actions.onFailure).toHaveBeenCalledTimes(1);
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", title: "Could not confirm compaction" }),
      );
    } finally {
      await hook.unmount();
    }
  });

  it.each(["approval", "question", "background", "active-turn"] as const)(
    "rechecks newly arrived %s work before dispatch",
    async (kind) => {
      const hook = await renderHook(() =>
        useClaudeContextCompaction({ threadId, disabledReason: null, ...callbacks() }),
      );
      try {
        useStore.setState(
          makeState(
            makeThread({
              ...thread,
              hasPendingApprovals: kind === "approval",
              hasPendingUserInput: kind === "question",
              ...(kind === "active-turn" && thread.session
                ? {
                    session: {
                      ...thread.session,
                      activeTurnId: TurnId.makeUnsafe("turn-in-flight"),
                    },
                  }
                : {}),
              activities:
                kind === "background"
                  ? [
                      makeActivity({
                        kind: "task.started",
                        payload: { taskId: "task-1", taskType: "background" },
                      }),
                    ]
                  : [],
            }),
          ),
        );
        expect(await hook.result.current.compact()).toBe(false);
        expect(mocks.dispatchCommand).not.toHaveBeenCalled();
      } finally {
        await hook.unmount();
      }
    },
  );

  it("keeps independent request ownership when switching threads", async () => {
    const secondThreadId = ThreadId.makeUnsafe("claude-compact-thread-2");
    let release: (() => void) | undefined;
    mocks.dispatchCommand.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const actions = callbacks();
    const hook = await renderHook(
      (props?: { currentThreadId: ThreadId }) =>
        useClaudeContextCompaction({
          threadId: props?.currentThreadId ?? threadId,
          disabledReason: null,
          ...actions,
        }),
      { initialProps: { currentThreadId: threadId } },
    );
    try {
      const first = hook.result.current.compact();
      useStore.setState(makeState(makeThread({ ...thread, id: secondThreadId })));
      await hook.rerender({ currentThreadId: secondThreadId });
      expect(hook.result.current.isSubmitting).toBe(false);
      expect(await hook.result.current.compact()).toBe(true);
      expect(mocks.dispatchCommand).toHaveBeenCalledTimes(2);
      release?.();
      expect(await first).toBe(true);
      expect(actions.onAccepted).toHaveBeenCalledExactlyOnceWith(secondThreadId);
    } finally {
      release?.();
      await hook.unmount();
    }
  });
});

it("preserves operation identity after lost acknowledgement and event", async () => {
  const accepted: string[] = [];
  mocks.dispatchCommand.mockImplementation(async (command) => {
    accepted.push(command.commandId);
    if (accepted.length === 1)
      throw new Error("Disconnected after server commit, before ack and event");
  });
  const hook = await renderHook(() =>
    useClaudeContextCompaction({ threadId, disabledReason: null, ...callbacks() }),
  );
  try {
    await hook.result.current.compact();
    await hook.result.current.compact();
    expect(new Set(accepted).size).toBe(1);
  } finally {
    await hook.unmount();
  }
});

it("reuses an unconfirmed request after remount and persisted state hydration", async () => {
  mocks.dispatchCommand.mockRejectedValueOnce(new Error("Lost acknowledgement"));
  const first = await renderHook(() =>
    useClaudeContextCompaction({ threadId, disabledReason: null, ...callbacks() }),
  );
  await first.result.current.compact();
  const original = mocks.dispatchCommand.mock.calls[0]![0];
  await first.unmount();
  // Simulate a page reload: the persisted request is all the new hook inherits.
  const saved = sessionStorage.getItem("synara:claude-compaction-requests")!;
  useClaudeCompactionRequests.setState({ requests: {} });
  sessionStorage.setItem("synara:claude-compaction-requests", saved);
  await useClaudeCompactionRequests.persist.rehydrate();
  const second = await renderHook(() =>
    useClaudeContextCompaction({ threadId, disabledReason: null, ...callbacks() }),
  );
  try {
    expect(await second.result.current.compact()).toBe(true);
    expect(mocks.dispatchCommand.mock.calls[1]![0]).toEqual(original);
  } finally {
    await second.unmount();
  }
});

it("allows a fresh request after a proven server rejection", async () => {
  mocks.dispatchCommand.mockRejectedValueOnce(
    Object.assign(new Error("Task is unavailable"), {
      code: "ORCHESTRATION_COMMAND_REJECTED",
    }),
  );
  const hook = await renderHook(() =>
    useClaudeContextCompaction({ threadId, disabledReason: null, ...callbacks() }),
  );
  try {
    expect(await hook.result.current.compact()).toBe(false);
    expect(await hook.result.current.compact()).toBe(true);
    expect(mocks.dispatchCommand.mock.calls[0]![0].commandId).not.toBe(
      mocks.dispatchCommand.mock.calls[1]![0].commandId,
    );
  } finally {
    await hook.unmount();
  }
});

it("allows a later compaction after observing the accepted message", async () => {
  const hook = await renderHook(() =>
    useClaudeContextCompaction({ threadId, disabledReason: null, ...callbacks() }),
  );
  try {
    expect(await hook.result.current.compact()).toBe(true);
    const command = mocks.dispatchCommand.mock.calls[0]![0];
    useStore.setState(
      makeState(
        makeThread({
          ...thread,
          messages: [
            {
              id: command.message.messageId,
              role: "user",
              text: "/compact",
              createdAt: command.createdAt,
              streaming: false,
            },
          ],
        }),
      ),
    );
    expect(useClaudeCompactionRequests.getState().requests[threadId]).toBeUndefined();
    expect(await hook.result.current.compact()).toBe(true);
    expect(mocks.dispatchCommand.mock.calls[1]![0].commandId).not.toBe(command.commandId);
  } finally {
    await hook.unmount();
  }
});

it("forgets acknowledged compaction even when its message is outside the loaded history", async () => {
  const hook = await renderHook(() =>
    useClaudeContextCompaction({ threadId, disabledReason: null, ...callbacks() }),
  );
  try {
    await hook.result.current.compact();
    expect(useClaudeCompactionRequests.getState().requests[threadId]).toBeUndefined();
  } finally {
    await hook.unmount();
  }
});

it("does not erase a newer request when an older acknowledgement arrives late", async () => {
  let acceptFirst!: () => void;
  let acceptSecond!: () => void;
  mocks.dispatchCommand
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acceptFirst = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acceptSecond = resolve;
        }),
    );
  const first = await renderHook(() =>
    useClaudeContextCompaction({ threadId, disabledReason: null, ...callbacks() }),
  );
  const firstSend = first.result.current.compact();
  const command = mocks.dispatchCommand.mock.calls[0]![0];
  useStore.setState(
    makeState(
      makeThread({
        ...thread,
        messages: [
          {
            id: command.message.messageId,
            role: "user",
            text: "/compact",
            createdAt: command.createdAt,
            streaming: false,
          },
        ],
      }),
    ),
  );
  const second = await renderHook(() =>
    useClaudeContextCompaction({ threadId, disabledReason: null, ...callbacks() }),
  );
  try {
    const secondSend = second.result.current.compact();
    const secondCommand = mocks.dispatchCommand.mock.calls[1]![0];
    acceptFirst();
    await firstSend;
    expect(useClaudeCompactionRequests.getState().requests[threadId]?.commandId).toBe(
      secondCommand.commandId,
    );
    acceptSecond();
    await secondSend;
  } finally {
    acceptFirst();
    acceptSecond?.();
    await first.unmount();
    await second.unmount();
  }
});
