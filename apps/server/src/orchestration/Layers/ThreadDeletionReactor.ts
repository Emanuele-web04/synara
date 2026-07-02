import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { Cause, Effect, Layer, Stream } from "effect";

import { ProfileStatsArchive } from "../../profileStatsArchive";
import { ProviderService } from "../../provider/Services/ProviderService";
import { TerminalManager } from "../../terminal/Services/Manager";
import { THREAD_RETENTION_COMMAND_ID_PREFIX } from "../../threadRetention";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

// Crash recovery / backfill: threads soft-deleted before the purge could run
// (or before purge existed) are archived and purged shortly after startup.
const PURGE_STARTUP_SWEEP_DELAY_MS = 60 * 1000;

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const profileStatsArchive = yield* ProfileStatsArchive;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager;

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  // Retention deletes only hide the thread (its rows keep feeding profile
  // stats directly). Explicit deletes snapshot the stat aggregates and then
  // hard-delete the thread's rows so disk space is actually reclaimed.
  const purgeThreadData = (event: ThreadDeletedEvent) => {
    if (event.commandId?.startsWith(THREAD_RETENTION_COMMAND_ID_PREFIX)) {
      return Effect.void;
    }
    return profileStatsArchive
      .purgeThreadWithStatsSnapshot({ threadId: event.payload.threadId })
      .pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          // A failed purge leaves the thread soft-deleted; the startup sweep
          // retries it on the next boot.
          Effect.logWarning("thread deletion cleanup skipped stats archive purge", {
            threadId: event.payload.threadId,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
  };

  const processThreadDeleted = Effect.fn(function* (event: ThreadDeletedEvent) {
    const { threadId } = event.payload;
    yield* stopProviderSession(threadId);
    yield* closeThreadTerminals(threadId);
    yield* purgeThreadData(event);
  });

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) =>
    processThreadDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  const start: ThreadDeletionReactorShape["start"] = Effect.fn(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.deleted") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
    yield* Effect.forkScoped(
      Effect.sleep(PURGE_STARTUP_SWEEP_DELAY_MS).pipe(
        Effect.flatMap(() => profileStatsArchive.purgeSoftDeletedManualThreads()),
        Effect.flatMap((purgedCount) =>
          purgedCount > 0
            ? Effect.logInfo("purged soft-deleted threads after stats archive snapshot", {
                purgedCount,
              })
            : Effect.void,
        ),
        Effect.catch((error) =>
          Effect.logWarning("startup purge sweep for deleted threads failed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
