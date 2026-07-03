import {
  CommandId,
  MessageId,
  ORCHESTRATION_GOAL_COMPLETION_SENTINEL,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Option, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { renderGoalContinuationPrompt } from "../goalContinuationPrompt.ts";
import {
  GoalContinuationReactor,
  type GoalContinuationReactorShape,
} from "../Services/GoalContinuationReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

// Domain events that mean "a turn may have just settled" for a thread. We re-read the
// snapshot on each and decide from `latestTurn`, so either ordering (checkpoint-first or
// session-idle-first) converges.
const TRIGGER_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.activity-appended",
  "thread.goal-cleared",
  "thread.goal-completed",
  "thread.goal-created",
  "thread.goal-paused",
  "thread.goal-resumed",
  "thread.message-sent",
  "thread.turn-diff-completed",
  "thread.session-set",
]);

function triggerThreadId(event: OrchestrationEvent): ThreadId | null {
  switch (event.type) {
    case "thread.activity-appended":
    case "thread.goal-cleared":
    case "thread.goal-completed":
    case "thread.goal-created":
    case "thread.goal-paused":
    case "thread.goal-resumed":
    case "thread.message-sent":
    case "thread.turn-diff-completed":
    case "thread.session-set":
      return event.payload.threadId;
    default:
      return null;
  }
}

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const continuationMessageId = (): MessageId =>
  MessageId.makeUnsafe(`goal-continuation:${crypto.randomUUID()}`);

// The assistant message produced by the just-completed turn. We require it to be present
// before deciding, so sentinel detection reads the real final text rather than racing the
// message's persistence into the projection.
function findAssistantMessageForTurn(thread: OrchestrationThread, turnId: TurnId) {
  return thread.messages
    .toReversed()
    .find((entry) => entry.role === "assistant" && entry.turnId === turnId);
}

function turnHadToolActivity(thread: OrchestrationThread, turnId: TurnId): boolean {
  return thread.activities.some((entry) => entry.turnId === turnId && entry.tone === "tool");
}

function turnWasGoalContinuation(thread: OrchestrationThread, turnId: TurnId): boolean {
  return thread.messages.some(
    (entry) =>
      entry.turnId === turnId && entry.role === "user" && entry.source === "goal-continuation",
  );
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  // We act at most once per completed turn per thread. Recorded only once we commit to
  // an action, so a trigger that arrives while the agent is still busy can retry later.
  const lastHandledTurnId = new Map<ThreadId, TurnId>();

  const handleThread = Effect.fn(function* (threadId: ThreadId) {
    const thread = Option.getOrUndefined(
      yield* projectionSnapshotQuery.getThreadDetailById(threadId),
    );
    if (!thread) {
      return;
    }

    const goal = thread.goal;
    if (!goal || goal.status !== "active") {
      lastHandledTurnId.delete(threadId);
      return;
    }

    // Only act on a turn that has actually completed.
    const latestTurn = thread.latestTurn;
    if (!latestTurn || latestTurn.state !== "completed") {
      return;
    }
    if (lastHandledTurnId.get(threadId) === latestTurn.turnId) {
      return;
    }

    // The agent must be free. If a turn is still running, a later trigger will retry —
    // do not record the turn as handled yet.
    if (thread.session?.activeTurnId != null) {
      return;
    }
    const sessionStatus = thread.session?.status;
    if (sessionStatus !== "ready" && sessionStatus !== "idle") {
      return;
    }

    // Never override a human in the loop.
    if (thread.hasPendingApprovals === true || thread.hasPendingUserInput === true) {
      return;
    }

    // Plan mode is read-only planning; do not apply continuation pressure.
    if (thread.interactionMode === "plan") {
      return;
    }

    // Require the completed turn's assistant message to be persisted before deciding. The
    // turn-diff/session-set triggers can arrive before the message lands in the projection;
    // acting early would read stale text and wrongly suppress the goal forever. Retry on
    // the next trigger instead (without marking the turn handled).
    const assistantMessage = findAssistantMessageForTurn(thread, latestTurn.turnId);
    if (assistantMessage === undefined) {
      return;
    }

    // Completion: the model emitted the sentinel as the final line of its reply after the
    // completion audit. Require an exact last-line match (not a substring) so quoting the
    // sentinel in prose, a code block, or a blocker explanation does not falsely complete.
    const lastLine = assistantMessage.text.trimEnd().split(/\r?\n/).at(-1)?.trim();
    if (lastLine === ORCHESTRATION_GOAL_COMPLETION_SENTINEL) {
      yield* orchestrationEngine.dispatch({
        type: "thread.goal.complete",
        commandId: serverCommandId("goal-complete"),
        threadId,
        createdAt: new Date().toISOString(),
      });
      // Goal is terminal now; drop the per-thread bookkeeping so the map cannot grow
      // unboundedly across the server's lifetime.
      lastHandledTurnId.delete(threadId);
      return;
    }

    // No-activity suppression: once continuations have started, a turn that produced no
    // tool activity means the agent is spinning. Stop until the user nudges it (mirrors
    // pi-goal's no-tool continuation suppression). This is a terminal decision for the
    // turn, so record it as handled.
    if (
      turnWasGoalContinuation(thread, latestTurn.turnId) &&
      !turnHadToolActivity(thread, latestTurn.turnId)
    ) {
      lastHandledTurnId.set(threadId, latestTurn.turnId);
      yield* Effect.logDebug("goal continuation suppressed: no tool activity", {
        threadId,
        turnId: latestTurn.turnId,
      });
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: serverCommandId("goal-continuation"),
      threadId,
      message: {
        messageId: continuationMessageId(),
        role: "user",
        text: renderGoalContinuationPrompt(goal),
        attachments: [],
      },
      inputSource: "goal-continuation",
      runtimeMode: thread.runtimeMode,
      interactionMode: "default",
      dispatchMode: "queue",
      createdAt: new Date().toISOString(),
    });
    // Only mark the turn handled after a successful dispatch; if the dispatch above
    // fails the turn stays unhandled and a later trigger retries instead of stalling.
    lastHandledTurnId.set(threadId, latestTurn.turnId);
  });

  const handleThreadSafely = (threadId: ThreadId) =>
    handleThread(threadId).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("goal continuation reactor failed to process thread", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(handleThreadSafely);

  const start: GoalContinuationReactorShape["start"] = Effect.fn(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (!TRIGGER_EVENT_TYPES.has(event.type)) {
          return Effect.void;
        }
        const threadId = triggerThreadId(event);
        return threadId === null ? Effect.void : worker.enqueue(threadId);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies GoalContinuationReactorShape;
});

export const GoalContinuationReactorLive = Layer.effect(GoalContinuationReactor, make);
