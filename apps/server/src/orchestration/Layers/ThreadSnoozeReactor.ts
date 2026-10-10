import { CommandId, type OrchestrationEvent, type ThreadId } from "@synara/contracts";
import { Cause, Duration, Effect, Layer, Queue, Schedule, Stream } from "effect";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadSnoozeReactor,
  type ThreadSnoozeReactorShape,
} from "../Services/ThreadSnoozeReactor.ts";

const RECHECK_INTERVAL_MS = 60_000;
const RETRY_INTERVAL_MS = 5_000;

function changesSnooze(event: OrchestrationEvent): boolean {
  return (
    event.type === "thread.archived" ||
    event.type === "thread.deleted" ||
    (event.type === "thread.meta-updated" && event.payload.snoozedUntil !== undefined)
  );
}

export const makeThreadSnoozeReactorLive = () =>
  Layer.effect(
    ThreadSnoozeReactor,
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery;
      const deadlines = new Map<ThreadId, string>();

      const runPass = Effect.gen(function* () {
        let delayMs = RECHECK_INTERVAL_MS;
        // Event consumption can change the map while dispatch yields; each pass
        // processes only the deadlines it observed at its start.
        const currentDeadlines = Array.from(deadlines);
        for (const [threadId, deadline] of currentDeadlines) {
          const dueInMs = Date.parse(deadline) - Date.now();
          if (!Number.isFinite(dueInMs)) continue;
          if (dueInMs > 0) {
            delayMs = Math.min(delayMs, dueInMs);
            continue;
          }
          const expired = yield* engine
            .dispatch({
              type: "thread.meta.update",
              commandId: CommandId.makeUnsafe(`server:thread-snooze:${crypto.randomUUID()}`),
              threadId,
              snoozedUntil: null,
              expectedSnoozedUntil: deadline,
            })
            .pipe(
              Effect.as(true),
              // A newer schedule, cancellation or archive can win before dispatch.
              Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.succeed(false)),
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
                delayMs = Math.min(delayMs, RETRY_INTERVAL_MS);
                return Effect.logWarning("failed to expire thread snooze", {
                  threadId,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(false));
              }),
            );
          if (expired && deadlines.get(threadId) === deadline) deadlines.delete(threadId);
          if (!expired) delayMs = Math.min(delayMs, RETRY_INTERVAL_MS);
        }
        return Math.max(1, delayMs);
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          return Effect.logWarning("thread snooze scheduler pass failed", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(RETRY_INTERVAL_MS));
        }),
      );

      const runSession = Effect.scoped(
        Effect.gen(function* () {
          const wakeups = yield* Queue.sliding<void>(1);
          // Attach before the initial snapshot so scheduling cannot fall into a gap.
          const events = yield* engine.subscribeDomainEvents;
          const snapshot = yield* query.getShellSnapshot().pipe(
            Effect.tapError((error) =>
              Effect.logWarning("failed to restore thread snoozes", { error }),
            ),
            Effect.retry(Schedule.spaced(Duration.millis(RETRY_INTERVAL_MS))),
          );
          deadlines.clear();
          for (const thread of snapshot.threads) {
            if (thread.archivedAt == null && thread.snoozedUntil != null) {
              deadlines.set(thread.id, thread.snoozedUntil);
            }
          }
          const consumeEvents = events.pipe(
            Stream.filter((event) => event.sequence > snapshot.snapshotSequence),
            Stream.filter(changesSnooze),
            Stream.runForEach((event) => {
              if (event.type === "thread.meta-updated" && event.payload.snoozedUntil != null) {
                deadlines.set(event.payload.threadId, event.payload.snoozedUntil);
              } else if ("threadId" in event.payload) {
                deadlines.delete(event.payload.threadId);
              }
              return Queue.offer(wakeups, undefined).pipe(Effect.asVoid);
            }),
          );
          const scheduleDeadlines = Effect.gen(function* () {
            while (true) {
              const delayMs = yield* runPass;
              // Bound the sleep to re-read wall time after suspension or clock changes.
              yield* Effect.sleep(Duration.millis(delayMs)).pipe(
                Effect.raceFirst(Queue.take(wakeups)),
                Effect.asVoid,
              );
            }
          });
          // Losing the event consumer would leave the cache stale indefinitely.
          // Recover the entire subscription/snapshot boundary if either side stops.
          yield* scheduleDeadlines.pipe(Effect.raceFirst(consumeEvents));
        }),
      );
      const start: ThreadSnoozeReactorShape["start"] = () =>
        Effect.forkScoped(
          Effect.forever(
            runSession.pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
                return Effect.logWarning(
                  "thread snooze event consumer stopped; restoring deadlines",
                  { cause: Cause.pretty(cause) },
                );
              }),
              Effect.andThen(Effect.sleep(Duration.millis(RETRY_INTERVAL_MS))),
            ),
          ),
        ).pipe(Effect.asVoid);

      return { start } satisfies ThreadSnoozeReactorShape;
    }),
  );

export const ThreadSnoozeReactorLive = makeThreadSnoozeReactorLive();
