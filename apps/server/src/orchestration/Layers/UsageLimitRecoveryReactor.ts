// FILE: UsageLimitRecoveryReactor.ts
// Purpose: Restore durable usage-limit waits and ask the command model to resume due work.
// Layer: Orchestration deadline scheduling; provider execution stays in its delivery lane.

import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@synara/contracts";
import { Cause, Duration, Effect, Layer, Option, Queue, Schedule, Stream } from "effect";

import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  UsageLimitRecoveryReactor,
  type UsageLimitRecoveryReactorShape,
} from "../Services/UsageLimitRecoveryReactor.ts";

const RECHECK_INTERVAL_MS = 60_000;
const RETRY_INTERVAL_MS = 5_000;
type Recovery = NonNullable<OrchestrationThreadShell["usageLimitRecovery"]>;

function changesRecovery(event: OrchestrationEvent): boolean {
  return (
    event.type === "thread.archived" ||
    event.type === "thread.deleted" ||
    (event.type === "thread.meta-updated" && event.payload.usageLimitRecovery !== undefined)
  );
}

export const makeUsageLimitRecoveryReactorLive = () =>
  Layer.effect(
    UsageLimitRecoveryReactor,
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery;
      const serverSettings = yield* ServerSettingsService;
      const providerCommands = yield* Effect.serviceOption(ProviderCommandReactor);

      const runSession = Effect.scoped(
        Effect.gen(function* () {
          const recoveries = new Map<ThreadId, Recovery>();
          const cancellations = new Map<string, { threadId: ThreadId; recovery: Recovery }>();
          const wakeups = yield* Queue.sliding<void>(1);
          // Attach both streams before reading state; settings toggles and new waits
          // cannot fall into the startup snapshot gap.
          const events = yield* engine.subscribeDomainEvents;
          const settingsChanges = yield* serverSettings.subscribeChanges;
          const snapshot = yield* query.getShellSnapshot().pipe(
            Effect.tapError((error) =>
              Effect.logWarning("failed to restore usage-limit waits", { error }),
            ),
            Effect.retry(Schedule.spaced(Duration.millis(RETRY_INTERVAL_MS))),
          );
          for (const thread of snapshot.threads) {
            if (thread.archivedAt == null && thread.usageLimitRecovery != null) {
              recoveries.set(thread.id, thread.usageLimitRecovery);
            }
          }

          const cancellationKey = (threadId: ThreadId, recoveryId: string) =>
            JSON.stringify([threadId, recoveryId]);
          const cancelRecovery = (threadId: ThreadId, recovery: Recovery) =>
            cancellations.set(cancellationKey(threadId, recovery.id), { threadId, recovery });
          const consumeEvents = events.pipe(
            Stream.filter((event) => event.sequence > snapshot.snapshotSequence),
            Stream.filter(changesRecovery),
            Stream.runForEach((event) => {
              if (
                event.type === "thread.meta-updated" &&
                event.payload.usageLimitRecovery != null
              ) {
                recoveries.set(event.payload.threadId, event.payload.usageLimitRecovery);
              } else if ("threadId" in event.payload) {
                recoveries.delete(event.payload.threadId);
              }
              return Queue.offer(wakeups, undefined).pipe(Effect.asVoid);
            }),
          );
          const consumeSettings = settingsChanges.pipe(
            Stream.runForEach((settings) =>
              Effect.gen(function* () {
                if (!settings.autoResumeAfterUsageLimits) {
                  for (const [threadId, recovery] of recoveries) cancelRecovery(threadId, recovery);
                  // A committed wait may still be buffered in the domain stream.
                  // Retain explicit cancellations even if a later toggle enables the setting.
                  const current = yield* engine.getReadModel();
                  for (const thread of current.threads) {
                    if (thread.usageLimitRecovery != null) {
                      cancelRecovery(thread.id, thread.usageLimitRecovery);
                    }
                  }
                }
                yield* Queue.offer(wakeups, undefined);
              }),
            ),
          );

          const runPass = Effect.gen(function* () {
            let delayMs = RECHECK_INTERVAL_MS;
            const settings = yield* serverSettings.getSettings;
            for (const [threadId, recovery] of recoveries) {
              if (
                !settings.autoResumeAfterUsageLimits ||
                recovery.policyEpoch !== settings.usageLimitRecoveryEpoch
              ) {
                cancelRecovery(threadId, recovery);
              }
            }
            // Cancellation is processed before any resume, including a fast off/on toggle.
            for (const [id, { threadId, recovery }] of Array.from(cancellations)) {
              const cancelled = yield* engine
                .dispatch({
                  type: "thread.usage-limit.cancel",
                  commandId: CommandId.makeUnsafe(
                    `server:usage-limit-cancel:${crypto.randomUUID()}`,
                  ),
                  threadId,
                  recoveryId: recovery.id,
                  createdAt: new Date().toISOString(),
                })
                .pipe(
                  Effect.as(true),
                  Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.succeed(true)),
                  Effect.catchCause((cause) => {
                    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
                    return Effect.logWarning("failed to cancel usage-limit wait", {
                      threadId,
                      cause: Cause.pretty(cause),
                    }).pipe(Effect.as(false));
                  }),
                );
              if (cancelled) {
                cancellations.delete(id);
                if (recoveries.get(threadId)?.id === recovery.id) recoveries.delete(threadId);
              } else {
                delayMs = Math.min(delayMs, RETRY_INTERVAL_MS);
              }
            }
            if (!settings.autoResumeAfterUsageLimits) return delayMs;
            for (const [threadId, recovery] of Array.from(recoveries)) {
              if (
                cancellations.has(cancellationKey(threadId, recovery.id)) ||
                recovery.state === "resuming"
              ) {
                continue;
              }
              const dueInMs = Date.parse(recovery.resetAt) - Date.now();
              if (!Number.isFinite(dueInMs)) continue;
              if (dueInMs > 0) {
                delayMs = Math.min(delayMs, dueInMs);
                continue;
              }
              if (Option.isSome(providerCommands)) {
                const blocked = yield* providerCommands.value
                  .listBlockingDeliveries({ threadId, limit: 1 })
                  .pipe(
                    Effect.map((deliveries) => deliveries.length > 0),
                    Effect.catch(() => Effect.succeed(true)),
                  );
                if (blocked) {
                  delayMs = Math.min(delayMs, RETRY_INTERVAL_MS);
                  continue;
                }
              }
              yield* engine
                .dispatch({
                  type: "thread.usage-limit.resume",
                  commandId: CommandId.makeUnsafe(
                    `server:usage-limit-resume:${crypto.randomUUID()}`,
                  ),
                  threadId,
                  recoveryId: recovery.id,
                  policyEpoch: settings.usageLimitRecoveryEpoch,
                  createdAt: new Date().toISOString(),
                })
                .pipe(
                  Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.void),
                  Effect.catchCause((cause) => {
                    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
                    return Effect.logWarning("failed to resume usage-limited task", {
                      threadId,
                      cause: Cause.pretty(cause),
                    });
                  }),
                );
              // The committed event, not dispatch completion, changes the cache.
              // A temporary blocker is reconsidered without a tight due-time loop.
              delayMs = Math.min(delayMs, RETRY_INTERVAL_MS);
            }
            return Math.max(1, delayMs);
          }).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
              return Effect.logWarning("usage-limit scheduler pass failed", {
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(RETRY_INTERVAL_MS));
            }),
          );
          const scheduleDeadlines = Effect.gen(function* () {
            while (true) {
              const delayMs = yield* runPass;
              // Bound wall-time rechecks after system suspension or clock changes.
              yield* Effect.sleep(Duration.millis(delayMs)).pipe(
                Effect.raceFirst(Queue.take(wakeups)),
                Effect.asVoid,
              );
            }
          });
          // A lost consumer invalidates the cache. Restore the subscription/snapshot
          // boundary rather than continuing indefinitely with stale state.
          yield* scheduleDeadlines.pipe(
            Effect.raceFirst(consumeEvents),
            Effect.raceFirst(consumeSettings),
          );
        }),
      );
      const start: UsageLimitRecoveryReactorShape["start"] = () =>
        Effect.forkScoped(
          Effect.forever(
            runSession.pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
                return Effect.logWarning("usage-limit event consumer stopped; restoring waits", {
                  cause: Cause.pretty(cause),
                });
              }),
              Effect.andThen(Effect.sleep(Duration.millis(RETRY_INTERVAL_MS))),
            ),
          ),
        ).pipe(Effect.asVoid);

      return { start } satisfies UsageLimitRecoveryReactorShape;
    }),
  );

export const UsageLimitRecoveryReactorLive = makeUsageLimitRecoveryReactorLive();
