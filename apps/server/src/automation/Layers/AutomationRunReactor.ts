import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { Cause, Effect, Layer, Stream } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { AutomationService } from "../Services/AutomationService.ts";
import {
  AutomationRunReactor,
  type AutomationRunReactorShape,
} from "../Services/AutomationRunReactor.ts";

// Orchestration domain events that can mean an automation-owned thread's turn changed
// outcome (completed / errored / interrupted / awaiting approval). Any of these triggers
// a reconcile against the authoritative thread state.
const RECONCILE_EVENT_TYPES: ReadonlySet<OrchestrationEvent["type"]> = new Set([
  "thread.turn-diff-completed",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.turn-interrupt-requested",
  "thread.reverted",
  "thread.conversation-rolled-back",
  "thread.session-set",
]);

function reconcileThreadIdOf(event: OrchestrationEvent): ThreadId | null {
  if (!RECONCILE_EVENT_TYPES.has(event.type)) {
    return null;
  }
  const payload = event.payload;
  return "threadId" in payload ? payload.threadId : null;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const automationService = yield* AutomationService;

  const reconcileSafely = (threadId: ThreadId) =>
    automationService.reconcileThread({ threadId }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("automation run reactor failed to reconcile thread", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(reconcileSafely);

  const start: AutomationRunReactorShape["start"] = Effect.fn(function* () {
    // Close out runs orphaned by a crash/restart before watching live events. Reconcile is
    // idempotent, so any overlap with the live stream is harmless.
    yield* automationService.recoverPendingRuns().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("automation run reactor recovery failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        const threadId = reconcileThreadIdOf(event);
        return threadId ? worker.enqueue(threadId) : Effect.void;
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies AutomationRunReactorShape;
});

export const AutomationRunReactorLive = Layer.effect(AutomationRunReactor, make);
