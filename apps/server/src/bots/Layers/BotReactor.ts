// FILE: BotReactor.ts (layer)
// Purpose: Drives SynBot from orchestration events: settles delegations and delivers reports when
//          a bot's turns or tasks move, refreshes bot status, offers bots for new projects, runs
//          the one-time Beta fresh start, and sweeps every few seconds as a restart-safe backstop.
// Layer: Server reactor
// Notes: All work is idempotent (deterministic ids), so a missed or repeated event is harmless.

import type { OrchestrationEvent, ProjectId, ThreadId } from "@synara/contracts";
import { makeDrainableWorker, startDrainableWorkerProducers } from "@synara/shared/DrainableWorker";
import { Cause, Duration, Effect, Layer, Schedule, Stream } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { BotReactor } from "../Services/BotReactor.ts";
import { BotService } from "../Services/BotService.ts";
import { isServerSynbotEnabled } from "../synbotGate.ts";

/** Backstop for missed events and the settle grace window. */
const SWEEP_INTERVAL_MS = 10_000;

const THREAD_EVENT_TYPES: ReadonlySet<OrchestrationEvent["type"]> = new Set([
  "thread.turn-start-requested",
  "thread.turn-diff-completed",
  "thread.turn-interrupt-requested",
  "thread.session-set",
  "thread.session-stop-requested",
]);

/** Activities that change whether a bot waits on the user; tool activity is ignored. */
const STATUS_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "approval.requested",
  "approval.resolved",
  "user-input.requested",
  "user-input.resolved",
]);

const isRelevant = (event: OrchestrationEvent) => {
  if (event.type === "project.created" || THREAD_EVENT_TYPES.has(event.type)) return true;
  if (event.type !== "thread.activity-appended") return false;
  const activity = (event.payload as { readonly activity?: { readonly kind?: unknown } }).activity;
  return typeof activity?.kind === "string" && STATUS_ACTIVITY_KINDS.has(activity.kind);
};

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const bots = yield* BotService;

  if (isServerSynbotEnabled()) {
    yield* bots.freshStart();
    yield* bots.evaluateDelegations({});
    yield* bots
      .evaluateDelegations({})
      .pipe(Effect.repeat(Schedule.spaced(Duration.millis(SWEEP_INTERVAL_MS))), Effect.forkScoped);
  }

  const worker = yield* makeDrainableWorker((event: OrchestrationEvent) =>
    Effect.gen(function* () {
      if (event.type === "project.created") {
        yield* bots.onProjectCreated(event.payload.projectId as ProjectId);
        return;
      }
      const payload = event.payload as { readonly threadId?: unknown };
      if (typeof payload.threadId !== "string") return;
      const threadId = payload.threadId as ThreadId;
      yield* bots.refreshThread(threadId);
      yield* bots.evaluateDelegations({ threadId });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("SynBot reactor failed", { cause: Cause.pretty(cause) }),
      ),
    ),
  );

  if (isServerSynbotEnabled()) {
    yield* startDrainableWorkerProducers(
      worker,
      Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
          isRelevant(event) ? worker.enqueue(event).pipe(Effect.asVoid) : Effect.void,
        ),
      ).pipe(Effect.asVoid),
    );
  }

  return { ready: true as const };
});

export const BotReactorLive = Layer.effect(BotReactor, make);
