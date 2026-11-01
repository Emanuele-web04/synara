import { MessageId, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useComposerDraftStore, type QueuedComposerTurn } from "../composerDraftStore";
import { makeImage, resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import { useStore } from "../store";
import { initialState } from "../storeState";
import { makeState, makeThread } from "../storeTestFixtures";
import { dispatchQueuedComposerTurnHeadless } from "./queuedComposerDispatch";
import * as composerSend from "./composerSend";

const nativeApiMocks = vi.hoisted(() => ({
  dispatchCommand: vi.fn(async () => undefined),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand: nativeApiMocks.dispatchCommand,
    },
  }),
}));

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function makeQueuedChatTurn(): QueuedComposerTurn {
  return {
    id: "queued-chat-1",
    kind: "chat",
    createdAt: "2026-03-13T12:00:00.000Z",
    previewText: "follow up after the turn",
    prompt: "follow up after the turn",
    images: [],
    files: [],
    assistantSelections: [],
    browserAnnotations: [],
    terminalContexts: [],
    fileComments: [],
    pastedTexts: [],
    pullRequestContexts: [],
    skills: [],
    mentions: [],
    selectedProvider: "codex",
    selectedModel: "gpt-5",
    selectedPromptEffort: null,
    modelSelection: {
      provider: "codex",
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
  };
}

function makeQueuedPlanFollowUp(): QueuedComposerTurn {
  return {
    id: "queued-plan-1",
    kind: "plan-follow-up",
    createdAt: "2026-03-13T12:00:00.000Z",
    previewText: "implement the plan",
    text: "implement the plan",
    interactionMode: "default",
    selectedProvider: "codex",
    selectedModel: "gpt-5",
    selectedPromptEffort: null,
    modelSelection: {
      provider: "codex",
      model: "gpt-5",
    },
    runtimeMode: "full-access",
  };
}

describe("dispatchQueuedComposerTurnHeadless", () => {
  beforeEach(() => {
    resetComposerDraftStore();
    useStore.setState(initialState);
    nativeApiMocks.dispatchCommand.mockClear();
    useStore.setState(makeState(makeThread({ id: THREAD_ID })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetComposerDraftStore();
    useStore.setState(initialState);
  });

  it.each(["chat"] as const)(
    "holds a %s before uploads or settings changes while a cache review is pending",
    async (kind) => {
      const stageUpload = vi.spyOn(composerSend, "stageUploadComposerAttachments");
      useStore.setState(
        makeState(
          makeThread({
            id: THREAD_ID,
            claudeCacheReview: {
              reviewId: "cache-review-1",
              messageId: MessageId.makeUnsafe("held-message"),
              sourceEventSequence: 8,
              assessment: {
                observedAt: "2026-09-16T10:00:00.000Z",
                state: "likely-expired",
                source: "session-start",
              },
              status: "pending",
              createdAt: "2026-09-16T10:00:00.000Z",
            },
          }),
        ),
      );
      const succeeded = await dispatchQueuedComposerTurnHeadless({
        threadId: THREAD_ID,
        queuedTurn: kind === "chat" ? makeQueuedChatTurn() : makeQueuedPlanFollowUp(),
        dispatchMode: "queue",
        assistantDeliveryMode: "streaming",
      });
      expect(succeeded).toBe(false);
      expect(stageUpload).not.toHaveBeenCalled();
      expect(nativeApiMocks.dispatchCommand).not.toHaveBeenCalled();
    },
  );

  it("dispatches a snapshotted chat turn with dispatchMode queue", async () => {
    const queuedTurn = makeQueuedChatTurn();
    const messageId = MessageId.makeUnsafe("queued-dispatch-message");
    const succeeded = await dispatchQueuedComposerTurnHeadless({
      threadId: THREAD_ID,
      queuedTurn,
      dispatchMode: "queue",
      assistantDeliveryMode: "streaming",
      messageId,
    });

    expect(succeeded).toBe(true);
    expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.turn.start",
        threadId: THREAD_ID,
        dispatchMode: "queue",
        interactionMode: "default",
        runtimeMode: "full-access",
        assistantDeliveryMode: "streaming",
        message: expect.objectContaining({
          messageId,
          role: "user",
          text: "follow up after the turn",
        }),
      }),
    );
  });

  it("holds an early upload refusal until preparation settles without losing its queued retry", async () => {
    const queuedTurn = makeQueuedChatTurn();
    if (queuedTurn.kind !== "chat") throw new Error("Expected a queued chat");
    queuedTurn.images = [makeImage({ id: "retry-photo", previewUrl: "blob:retry-photo" })];
    useStore.setState(
      makeState(
        makeThread({
          id: THREAD_ID,
          modelSelection: queuedTurn.modelSelection,
          runtimeMode: "approval-required",
        }),
      ),
    );
    useComposerDraftStore.getState().enqueueQueuedTurn(THREAD_ID, queuedTurn);

    let finishPreparation: () => void = () => undefined;
    const preparation = new Promise<undefined>((resolve) => {
      finishPreparation = () => resolve(undefined);
    });
    nativeApiMocks.dispatchCommand.mockImplementationOnce(() => preparation);
    vi.stubGlobal("window", {
      desktopBridge: { getWsUrl: () => null },
      location: { origin: "synara-remote://app" },
    });
    vi.stubEnv("VITE_WS_URL", "");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    let settled = false;
    const pending = dispatchQueuedComposerTurnHeadless({
      threadId: THREAD_ID,
      queuedTurn,
      dispatchMode: "queue",
      assistantDeliveryMode: "streaming",
    }).finally(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledOnce());
      // A real event-loop turn exposes an unobserved rejection while the RPC is held.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();

      finishPreparation();
      await expect(pending).resolves.toBe(false);
      expect(nativeApiMocks.dispatchCommand).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "thread.turn.start" }),
      );
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.queuedTurns).toEqual([
        queuedTurn,
      ]);
    } finally {
      finishPreparation();
      try {
        await pending;
      } finally {
        process.off("unhandledRejection", unhandled);
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    }
  });

  it("sends a queued turn on the provider the thread was handed off to", async () => {
    const claudeSelection = { provider: "claudeAgent" as const, model: "claude-sonnet-5" };
    useStore.setState(
      makeState(
        makeThread({
          id: THREAD_ID,
          modelSelection: claudeSelection,
          latestTurn: {
            turnId: "turn-1" as never,
            state: "completed",
            requestedAt: "2026-03-13T11:00:00.000Z",
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
        }),
      ),
    );

    const succeeded = await dispatchQueuedComposerTurnHeadless({
      threadId: THREAD_ID,
      queuedTurn: makeQueuedChatTurn(),
      dispatchMode: "queue",
      assistantDeliveryMode: "streaming",
    });

    expect(succeeded).toBe(true);
    // Writing the queued Codex selection back would flip the thread off Claude.
    expect(nativeApiMocks.dispatchCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.meta.update" }),
    );
    expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.turn.start", modelSelection: claudeSelection }),
    );
  });

  it("dispatches a snapshotted plan follow-up as its own turn kind", async () => {
    const succeeded = await dispatchQueuedComposerTurnHeadless({
      threadId: THREAD_ID,
      queuedTurn: makeQueuedPlanFollowUp(),
      dispatchMode: "queue",
      assistantDeliveryMode: "buffered",
    });

    expect(succeeded).toBe(true);
    expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.turn.start",
        threadId: THREAD_ID,
        dispatchMode: "queue",
        interactionMode: "default",
        assistantDeliveryMode: "buffered",
        message: expect.objectContaining({
          role: "user",
          text: "implement the plan",
          attachments: [],
        }),
      }),
    );
  });

  it("returns false when the thread is not in the store", async () => {
    useStore.setState(initialState);
    const succeeded = await dispatchQueuedComposerTurnHeadless({
      threadId: THREAD_ID,
      queuedTurn: makeQueuedChatTurn(),
      dispatchMode: "queue",
      assistantDeliveryMode: "streaming",
    });
    expect(succeeded).toBe(false);
    expect(nativeApiMocks.dispatchCommand).not.toHaveBeenCalled();
  });

  it.each(["chat", "plan-follow-up"] as const)(
    "accepts the exact held %s after a lost RPC acknowledgement without cleaning its attachments",
    async (kind) => {
      const messageId = MessageId.makeUnsafe("accepted-held-message");
      const queuedTurn = kind === "chat" ? makeQueuedChatTurn() : makeQueuedPlanFollowUp();
      const idleThread = makeThread({ id: THREAD_ID, modelSelection: queuedTurn.modelSelection });
      useStore.setState(makeState(idleThread));
      const cleanup = vi.fn(async () => undefined);
      const commit = vi.fn();
      vi.spyOn(composerSend, "stageUploadComposerAttachments").mockResolvedValue({
        attachments: [],
        cleanup,
        commit,
        runWithDispatch: async (dispatch) => {
          try {
            const result = await dispatch([]);
            commit();
            return result;
          } catch (error) {
            await cleanup();
            throw error;
          }
        },
      });
      nativeApiMocks.dispatchCommand.mockImplementationOnce(async () => {
        useStore.setState(
          makeState({
            ...idleThread,
            claudeCacheReview: {
              reviewId: "cache-review-accepted",
              messageId,
              sourceEventSequence: 8,
              assessment: {
                observedAt: "2026-09-16T10:00:00.000Z",
                state: "likely-expired",
                source: "session-start",
              },
              status: "pending",
              createdAt: "2026-09-16T10:00:00.000Z",
            },
          }),
        );
        throw new Error("RPC acknowledgement lost");
      });
      const accepted = await dispatchQueuedComposerTurnHeadless({
        threadId: THREAD_ID,
        queuedTurn,
        dispatchMode: "queue",
        assistantDeliveryMode: "streaming",
        messageId,
      });
      expect(accepted).toBe(true);
      expect(cleanup).not.toHaveBeenCalled();
      if (kind === "chat") expect(commit).toHaveBeenCalledOnce();
    },
  );
});
