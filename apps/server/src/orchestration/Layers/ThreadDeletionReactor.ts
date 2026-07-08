import { ThreadId, type OrchestrationEvent } from "@synara/contracts";
import { makeDrainableWorker } from "@synara/shared/DrainableWorker";
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

const MISSING_PROVIDER_BINDING_DETAIL = "no persisted provider binding exists";

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

export const cleanupSucceededUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<boolean, E, R> =>
  effect.pipe(
    Effect.as(true),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(false));
    }),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const profileStatsArchive = yield* ProfileStatsArchive;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager;

  const refreshCommandReadModelAfterPurge = (threadId: string) =>
    orchestrationEngine.refreshCommandReadModel().pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion cleanup could not refresh command read model", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const stopProviderSessionWithoutBinding = (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
    cause: Cause.Cause<unknown>,
  ) =>
    Effect.logDebug("thread deletion cleanup found no provider session to stop", {
      threadId,
      cause: Cause.pretty(cause),
    }).pipe(Effect.as(true));

  const stopProviderSession = Effect.fn(function* (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
  ) {
    return yield* providerService.stopSession({ threadId }).pipe(
      Effect.as(true),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        if (Cause.pretty(cause).includes(MISSING_PROVIDER_BINDING_DETAIL)) {
          return stopProviderSessionWithoutBinding(threadId, cause);
        }
        return Effect.logDebug("thread deletion cleanup skipped provider session stop", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false));
      }),
    );
  });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    cleanupSucceededUnlessInterrupted({
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
        Effect.flatMap((purged) =>
          purged ? refreshCommandReadModelAfterPurge(event.payload.threadId) : Effect.void,
        ),
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

  const cleanupThreadBeforePurge = Effect.fn(function* (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
  ) {
    const providerCleanupSucceeded = yield* stopProviderSession(threadId);
    const terminalCleanupSucceeded = yield* closeThreadTerminals(threadId);
    return providerCleanupSucceeded && terminalCleanupSucceeded;
  });

  const processThreadDeleted = Effect.fn(function* (event: ThreadDeletedEvent) {
    const { threadId } = event.payload;
    const cleanupSucceeded = yield* cleanupThreadBeforePurge(threadId);
    if (!cleanupSucceeded) {
      yield* Effect.logWarning("thread deletion cleanup deferred stats archive purge", {
        threadId,
      });
      return;
    }
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
        Effect.flatMap(() =>
          profileStatsArchive.purgeSoftDeletedManualThreads({
            beforePurge: (threadId) => cleanupThreadBeforePurge(ThreadId.makeUnsafe(threadId)),
          }),
        ),
        Effect.tap((purgedCount) =>
          purgedCount > 0 ? refreshCommandReadModelAfterPurge("startup-sweep") : Effect.void,
        ),
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
