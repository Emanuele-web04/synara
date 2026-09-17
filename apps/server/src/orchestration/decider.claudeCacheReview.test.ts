import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type PendingClaudeCacheReview,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-09-16T12:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-claude-cache");
const MESSAGE_ID = MessageId.makeUnsafe("message-pending");

const REVIEW: PendingClaudeCacheReview = {
  reviewId: "cache-review-1",
  messageId: MESSAGE_ID,
  sourceEventSequence: 41,
  assessment: {
    nativeSessionId: "native-claude-session",
    lifecycleGeneration: "generation-1",
    model: "claude-opus-4-6",
    observedAt: NOW,
    contextTokens: 887_036,
    lastResponseAt: "2026-09-16T07:45:27.000Z",
    ttlSeconds: 3_600,
    state: "likely-expired",
    source: "request-usage",
  },
  status: "pending",
  createdAt: NOW,
};

function makeReadModel(
  input: {
    review?: PendingClaudeCacheReview | null;
    session?: OrchestrationSession | null;
  } = {},
): OrchestrationReadModel {
  return {
    snapshotSequence: 42,
    updatedAt: NOW,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-claude-cache"),
        title: "Claude cache review",
        modelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        createdAt: NOW,
        updatedAt: NOW,
        latestTurn: null,
        handoff: null,
        messages: [],
        session: input.session ?? null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
        ...(input.review !== undefined ? { claudeCacheReview: input.review } : {}),
      },
    ],
  };
}

function respond(
  decision: "continue" | "compact" | "cancel" = "continue",
  overrides: Partial<Extract<OrchestrationCommand, { type: "thread.claude-cache.respond" }>> = {},
): OrchestrationCommand {
  return {
    type: "thread.claude-cache.respond",
    commandId: CommandId.makeUnsafe("cmd-cache-respond"),
    threadId: THREAD_ID,
    messageId: MESSAGE_ID,
    reviewId: REVIEW.reviewId,
    decision,
    createdAt: NOW,
    ...overrides,
  };
}

async function decide(command: OrchestrationCommand, readModel: OrchestrationReadModel) {
  const result = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  return Array.isArray(result) ? result : [result];
}

describe("decider Claude cache review", () => {
  const compactionTurnId = TurnId.makeUnsafe("turn-cache-compaction");

  function compacted(overrides: { reviewId?: string; turnId?: TurnId } = {}): OrchestrationCommand {
    return {
      type: "thread.claude-cache.compacted",
      commandId: CommandId.makeUnsafe("cmd-cache-compacted"),
      threadId: THREAD_ID,
      reviewId: overrides.reviewId ?? REVIEW.reviewId,
      turnId: overrides.turnId ?? compactionTurnId,
      createdAt: NOW,
    };
  }

  it.each(["compacting", "uncertain"] as const)(
    "releases the matching %s compaction into a server-owned Continue response",
    async (status) => {
      const review: PendingClaudeCacheReview = { ...REVIEW, status, compactionTurnId };
      const events = await decide(compacted(), makeReadModel({ review }));

      expect(events.map((event) => event.type)).toEqual([
        "thread.claude-cache-set",
        "thread.claude-cache-response-requested",
      ]);
      expect(events[0]).toMatchObject({
        payload: { review: { status: "responding", messageId: MESSAGE_ID } },
      });
      expect(events[1]).toMatchObject({
        payload: {
          threadId: THREAD_ID,
          decision: "continue",
          review: { reviewId: REVIEW.reviewId, messageId: MESSAGE_ID },
        },
      });

      let readModel = makeReadModel({ review });
      for (const [index, event] of events.entries()) {
        readModel = await Effect.runPromise(
          projectEvent(readModel, { ...event, sequence: 43 + index }),
        );
      }
      expect(await decide(compacted(), readModel)).toEqual([]);
    },
  );

  it.each(["pending", "responding", "failed"] as const)(
    "does not release a compaction completion when the current review is %s",
    async (status) => {
      expect(
        await decide(
          compacted(),
          makeReadModel({ review: { ...REVIEW, status, compactionTurnId } }),
        ),
      ).toEqual([]);
    },
  );

  it.each([
    { reviewId: "different-review" },
    { turnId: TurnId.makeUnsafe("different-compaction-turn") },
  ])("ignores a stale compaction completion identity %j", async (overrides) => {
    expect(
      await decide(
        compacted(overrides),
        makeReadModel({
          review: {
            ...REVIEW,
            status: "compacting",
            compactionTurnId,
          },
        }),
      ),
    ).toEqual([]);
  });

  it.each([undefined, null])(
    "creates a review when expectedReviewId is null and current is %s",
    async (review) => {
      const events = await decide(
        {
          type: "thread.claude-cache.set",
          commandId: CommandId.makeUnsafe("cmd-cache-set"),
          threadId: THREAD_ID,
          review: REVIEW,
          expectedReviewId: null,
          createdAt: NOW,
        },
        makeReadModel(review === undefined ? {} : { review }),
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "thread.claude-cache-set",
        payload: { threadId: THREAD_ID, review: REVIEW, updatedAt: NOW },
      });
    },
  );

  it("does not replace a held review when the setter expected no review", async () => {
    const events = await decide(
      {
        type: "thread.claude-cache.set",
        commandId: CommandId.makeUnsafe("cmd-cache-stale-create"),
        threadId: THREAD_ID,
        review: { ...REVIEW, reviewId: "different-review" },
        expectedReviewId: null,
        createdAt: NOW,
      },
      makeReadModel({ review: REVIEW }),
    );

    expect(events).toEqual([]);
  });

  it.each(["cache-review-1", "stale-review"])(
    "clears only the expected review (%s)",
    async (expectedReviewId) => {
      const events = await decide(
        {
          type: "thread.claude-cache.set",
          commandId: CommandId.makeUnsafe("cmd-cache-clear"),
          threadId: THREAD_ID,
          review: null,
          expectedReviewId,
          createdAt: NOW,
        },
        makeReadModel({ review: REVIEW }),
      );

      if (expectedReviewId === REVIEW.reviewId) {
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "thread.claude-cache-set",
          payload: { review: null },
        });
      } else {
        expect(events).toEqual([]);
      }
    },
  );

  it.each(["pending", "failed"] as const)(
    "accepts a response to a %s review and carries the server assessment",
    async (status) => {
      const review = { ...REVIEW, status };
      const events = await decide(respond(), makeReadModel({ review }));

      expect(events.map((event) => event.type)).toEqual([
        "thread.claude-cache-set",
        "thread.claude-cache-response-requested",
      ]);
      expect(events[0]).toMatchObject({
        payload: { review: { ...review, status: "responding" } },
      });
      expect(events[1]).toMatchObject({
        payload: { threadId: THREAD_ID, review, decision: "continue", createdAt: NOW },
      });
    },
  );

  it.each(["responding", "compacting", "uncertain"] as const)(
    "does not replay responses while a review is %s",
    async (status) => {
      expect(await decide(respond(), makeReadModel({ review: { ...REVIEW, status } }))).toEqual([]);
    },
  );

  it.each([{ reviewId: "stale-review" }, { messageId: MessageId.makeUnsafe("different-message") }])(
    "ignores a response with stale identity %j",
    async (overrides) => {
      expect(
        await decide(respond("continue", overrides), makeReadModel({ review: REVIEW })),
      ).toEqual([]);
    },
  );

  it("ignores a response after the review has been cleared", async () => {
    expect(await decide(respond(), makeReadModel({ review: null }))).toEqual([]);
  });

  it("projects the accepted response before rejecting a duplicate command", async () => {
    let readModel = makeReadModel({ review: REVIEW });
    const events = await decide(respond(), readModel);
    for (const [index, event] of events.entries()) {
      readModel = await Effect.runPromise(
        projectEvent(readModel, { ...event, sequence: 43 + index }),
      );
    }

    expect(readModel.threads[0]?.claudeCacheReview?.status).toBe("responding");
    expect(
      await decide(
        respond("continue", { commandId: CommandId.makeUnsafe("cmd-cache-respond-again") }),
        readModel,
      ),
    ).toEqual([]);
  });

  it("requests cancellation without emitting a turn request", async () => {
    const events = await decide(respond("cancel"), makeReadModel({ review: REVIEW }));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread.claude-cache-set",
        payload: expect.objectContaining({ review: { ...REVIEW, status: "responding" } }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "thread.claude-cache-response-requested",
        payload: expect.objectContaining({ decision: "cancel", review: REVIEW }),
      }),
    );
    expect(events.map((event) => event.type)).not.toContain("thread.turn-start-requested");
  });

  it.each(["queue", "steer"] as const)(
    "holds new %s messages during review without interrupting a turn",
    async (dispatchMode) => {
      const events = await decide(
        {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-next-turn"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.makeUnsafe("next-message"),
            role: "user",
            text: "A later user message",
            attachments: [],
          },
          dispatchMode,
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: NOW,
        },
        makeReadModel({ review: REVIEW }),
      );

      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-queued",
      ]);
      expect(events[0]).toMatchObject({ payload: { startsNewTurn: true } });
      expect(events[1]).toMatchObject({ payload: { messageId: "next-message", dispatchMode } });
    },
  );

  it("does not interrupt an active provider turn while the review is responding", async () => {
    const events = await decide(
      {
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-steer-during-response"),
        threadId: THREAD_ID,
        message: {
          messageId: MessageId.makeUnsafe("message-during-response"),
          role: "user",
          text: "A later steering message",
          attachments: [],
        },
        dispatchMode: "steer",
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: NOW,
      },
      makeReadModel({
        review: { ...REVIEW, status: "responding" },
        session: {
          threadId: THREAD_ID,
          providerName: "claudeAgent",
          status: "running",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("turn-current"),
          lastError: null,
          updatedAt: NOW,
        },
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "thread.message-sent",
      "thread.turn-queued",
    ]);
  });
});
