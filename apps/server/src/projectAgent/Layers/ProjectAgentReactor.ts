import type { OrchestrationEvent, ProjectId, ThreadId } from "@synara/contracts";
import { makeDrainableWorker, startDrainableWorkerProducers } from "@synara/shared/DrainableWorker";
import { Cause, Effect, Layer, Stream } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectAgentReactor } from "../Services/ProjectAgentReactor.ts";
import { ProjectAgentService } from "../Services/ProjectAgentService.ts";

const SETTLE_EVENT_TYPES: ReadonlySet<OrchestrationEvent["type"]> = new Set([
  "thread.turn-diff-completed",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.turn-interrupt-requested",
  "thread.session-set",
]);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectAgent = yield* ProjectAgentService;

  yield* projectAgent.reconcilePendingWakes().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("project agent wake reconciliation failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const worker = yield* makeDrainableWorker((event: OrchestrationEvent) =>
    Effect.gen(function* () {
      if (event.type === "project.deleted") {
        yield* projectAgent.onProjectDeleted(event.payload.projectId as ProjectId);
        return;
      }
      if (!SETTLE_EVENT_TYPES.has(event.type)) return;
      const payload = event.payload;
      if (!("threadId" in payload)) return;
      yield* projectAgent.ingestSettledThreadEvent({
        threadId: payload.threadId as ThreadId,
        sourceEventId: `${event.sequence}:${event.type}`,
        eventType: event.type,
        createdAt: new Date().toISOString(),
      });
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("project agent reactor failed", {
          cause: Cause.pretty(cause),
        });
      }),
    ),
  );

  yield* startDrainableWorkerProducers(
    worker,
    Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "project.deleted" || SETTLE_EVENT_TYPES.has(event.type)
          ? worker.enqueue(event).pipe(Effect.asVoid)
          : Effect.void,
      ),
    ).pipe(Effect.asVoid),
  );

  return { ready: true as const };
});

export const ProjectAgentReactorLive = Layer.effect(ProjectAgentReactor, make);
