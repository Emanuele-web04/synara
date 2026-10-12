/**
 * providerRuntimeEventPump - Supervised adapter runtime-event ingestion.
 *
 * Owns retry, restart, and health tracking at the ProviderAdapter.streamEvents
 * seam. An event is retried in place until its canonical processing succeeds,
 * so transient persistence failures cannot consume and lose terminal events.
 *
 * @module providerRuntimeEventPump
 */
import type { ProviderKind, ProviderRuntimeEvent, ThreadId } from "@synara/contracts";
import { Cause, Effect, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import type {
  ProviderRuntimeEventPumpHealth,
  ProviderRuntimeEventPumpStatus,
} from "./Services/ProviderService.ts";
import {
  compatibleAssistantText,
  isBatchableAssistantText,
  PROVIDER_RUNTIME_TEXT_BATCH_MAX_BYTES,
  PROVIDER_RUNTIME_TEXT_BATCH_MAX_EVENTS,
  PROVIDER_RUNTIME_TEXT_BATCH_WINDOW_MS,
} from "./providerRuntimeTextBatch.ts";

const DEFAULT_RETRY_BASE_DELAY_MS = 25;
const DEFAULT_RETRY_MAX_DELAY_MS = 2_000;
// "Degraded" exists to say the pump may be missing events. After this many
// consecutive successfully processed events since the last quarantine, that
// claim is no longer supported by evidence, and staying degraded forever has
// a real cost: reconciliation refuses to settle stale turns for a provider
// whose pump is not healthy. Heal, and keep the lastQuarantined* fields as
// the durable forensic record.
const DEFAULT_DEGRADED_HEAL_AFTER_SUCCESSES = 100;

export interface ProviderRuntimeEventPumpOptions<R> {
  readonly provider: ProviderKind;
  readonly stream: Stream.Stream<ProviderRuntimeEvent>;
  readonly processEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void, unknown, R>;
  readonly updateHealth: (health: ProviderRuntimeEventPumpHealth) => void;
  readonly isPermanentFailure?: (cause: Cause.Cause<unknown>) => boolean;
  readonly quarantineEvent?: (
    event: ProviderRuntimeEvent,
    cause: string,
  ) => Effect.Effect<void, unknown, R>;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly degradedHealAfterSuccesses?: number;
  /** Only for an adapter declaring fresh-ids-once delivery, before durable acceptance. */
  readonly batchAssistantText?: boolean;
  /** Session owner flushes admitted text before retiring its lifecycle generation. */
  readonly onTextBatchFlusher?: (
    flush: ((threadId?: ThreadId) => Effect.Effect<void, never, R>) | undefined,
  ) => void;
}

export function makeProviderRuntimeEventPumpHealthRegistry(
  providers: ReadonlyArray<ProviderKind>,
): {
  readonly update: (health: ProviderRuntimeEventPumpHealth) => void;
  readonly snapshot: () => ReadonlyArray<ProviderRuntimeEventPumpHealth>;
} {
  const healthByProvider = new Map<ProviderKind, ProviderRuntimeEventPumpHealth>(
    providers.map((provider) => [
      provider,
      {
        provider,
        status: "starting",
        consecutiveFailures: 0,
        updatedAt: new Date().toISOString(),
      },
    ]),
  );

  return {
    update: (health) => {
      healthByProvider.set(health.provider, health);
    },
    snapshot: () =>
      providers.map((provider) => {
        const current = healthByProvider.get(provider);
        if (!current) {
          throw new Error(`Missing runtime-event pump health for provider '${provider}'.`);
        }
        return current;
      }),
  };
}

function retryDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponent = Math.min(8, Math.max(0, attempt - 1));
  return Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
}

function shouldLogRetry(attempt: number): boolean {
  return attempt === 1 || (attempt & (attempt - 1)) === 0;
}

function health(input: {
  readonly provider: ProviderKind;
  readonly status: ProviderRuntimeEventPumpStatus;
  readonly consecutiveFailures: number;
  readonly lastEventAt?: string;
  readonly lastError?: string;
  readonly quarantinedEvents?: number;
  readonly lastQuarantinedEventId?: string;
  readonly lastQuarantinedAt?: string;
}): ProviderRuntimeEventPumpHealth {
  return {
    provider: input.provider,
    status: input.status,
    consecutiveFailures: input.consecutiveFailures,
    updatedAt: new Date().toISOString(),
    ...(input.lastEventAt !== undefined ? { lastEventAt: input.lastEventAt } : {}),
    ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
    ...(input.quarantinedEvents !== undefined
      ? { quarantinedEvents: input.quarantinedEvents }
      : {}),
    ...(input.lastQuarantinedEventId !== undefined
      ? { lastQuarantinedEventId: input.lastQuarantinedEventId }
      : {}),
    ...(input.lastQuarantinedAt !== undefined
      ? { lastQuarantinedAt: input.lastQuarantinedAt }
      : {}),
  };
}

/**
 * Consume one Adapter stream forever.
 *
 * Per-event failures retry the same event before another queue item is taken.
 * Unexpected stream completion/defect restarts the subscription after backoff.
 * Scope interruption remains the only way this Effect completes.
 */
export function runProviderRuntimeEventPump<R>(
  options: ProviderRuntimeEventPumpOptions<R>,
): Effect.Effect<void, never, R> {
  const retryBaseDelayMs = Math.max(
    1,
    Math.floor(options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS),
  );
  const retryMaxDelayMs = Math.max(
    retryBaseDelayMs,
    Math.floor(options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS),
  );
  const degradedHealAfterSuccesses = Math.max(
    1,
    Math.floor(options.degradedHealAfterSuccesses ?? DEFAULT_DEGRADED_HEAL_AFTER_SUCCESSES),
  );
  let lastEventAt: string | undefined;
  let quarantinedEvents = 0;
  let successesSinceQuarantine = 0;
  let lastQuarantinedEventId: string | undefined;
  let lastQuarantinedAt: string | undefined;

  /** Returns true when this success flipped the pump from degraded to healed. */
  const noteSuccessAndMaybeHeal = (): boolean => {
    if (quarantinedEvents === 0) return false;
    successesSinceQuarantine += 1;
    if (successesSinceQuarantine < degradedHealAfterSuccesses) return false;
    quarantinedEvents = 0;
    successesSinceQuarantine = 0;
    return true;
  };

  const setHealth = (
    status: ProviderRuntimeEventPumpStatus,
    consecutiveFailures: number,
    lastError?: string,
  ) =>
    Effect.sync(() =>
      options.updateHealth(
        health({
          provider: options.provider,
          status,
          consecutiveFailures,
          ...(lastEventAt !== undefined ? { lastEventAt } : {}),
          ...(lastError !== undefined ? { lastError } : {}),
          quarantinedEvents,
          ...(lastQuarantinedEventId !== undefined ? { lastQuarantinedEventId } : {}),
          ...(lastQuarantinedAt !== undefined ? { lastQuarantinedAt } : {}),
        }),
      ),
    );

  const persistQuarantineReliably = (
    event: ProviderRuntimeEvent,
    detail: string,
    attempt = 1,
  ): Effect.Effect<void, never, R> =>
    Effect.suspend(() => {
      if (!options.quarantineEvent) {
        return Effect.void;
      }
      return options.quarantineEvent(event, detail).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          const delayMs = retryDelayMs(attempt, retryBaseDelayMs, retryMaxDelayMs);
          const quarantineDetail = Cause.pretty(cause);
          return setHealth("recovering", attempt, quarantineDetail).pipe(
            Effect.andThen(
              Effect.logWarning("provider.runtime_event_pump.retrying_quarantine", {
                provider: options.provider,
                eventId: event.eventId,
                eventType: event.type,
                attempt,
                delayMs,
                cause: quarantineDetail,
              }),
            ),
            Effect.andThen(Effect.sleep(delayMs)),
            Effect.andThen(persistQuarantineReliably(event, detail, attempt + 1)),
          );
        }),
      );
    });

  const processEventReliably = (
    event: ProviderRuntimeEvent,
    attempt = 1,
  ): Effect.Effect<void, never, R> =>
    Effect.suspend(() =>
      options.processEvent(event).pipe(
        Effect.tap(() =>
          Effect.suspend(() => {
            lastEventAt = event.createdAt;
            const healed = noteSuccessAndMaybeHeal();
            return (
              healed
                ? Effect.logInfo("provider.runtime_event_pump.recovered_from_degraded", {
                    provider: options.provider,
                    consecutiveSuccesses: degradedHealAfterSuccesses,
                  })
                : Effect.void
            ).pipe(Effect.andThen(setHealth(quarantinedEvents > 0 ? "degraded" : "healthy", 0)));
          }),
        ),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }

          const detail = Cause.pretty(cause);
          if (options.isPermanentFailure?.(cause) === true) {
            return persistQuarantineReliably(event, detail).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  quarantinedEvents += 1;
                  successesSinceQuarantine = 0;
                  lastQuarantinedEventId = event.eventId;
                  lastQuarantinedAt = new Date().toISOString();
                }),
              ),
              Effect.andThen(
                Effect.logError("provider.runtime_event_pump.quarantined_event", {
                  provider: options.provider,
                  eventId: event.eventId,
                  eventType: event.type,
                  threadId: event.threadId,
                  turnId: event.turnId,
                  cause: detail,
                }),
              ),
              Effect.andThen(setHealth("degraded", 0, detail)),
            );
          }

          const delayMs = retryDelayMs(attempt, retryBaseDelayMs, retryMaxDelayMs);
          const retryLog = shouldLogRetry(attempt)
            ? Effect.logWarning("provider.runtime_event_pump.retrying_event", {
                provider: options.provider,
                eventId: event.eventId,
                eventType: event.type,
                threadId: event.threadId,
                turnId: event.turnId,
                attempt,
                delayMs,
                cause: detail,
              })
            : Effect.void;
          return setHealth("recovering", attempt, detail).pipe(
            Effect.andThen(retryLog),
            Effect.andThen(Effect.sleep(delayMs)),
            Effect.andThen(processEventReliably(event, attempt + 1)),
          );
        }),
      ),
    );

  const runStreamOnce = () => {
    if (options.batchAssistantText !== true) {
      return Stream.runForEach(options.stream, processEventReliably);
    }
    return Effect.scoped(
      Effect.gen(function* () {
        const lock = yield* Semaphore.make(1);
        let pending: Extract<ProviderRuntimeEvent, { readonly type: "content.delta" }> | undefined;
        let pendingBytes = 0;
        let pendingCount = 0;
        let timerGeneration = 0;

        // Called under the lock. The exact envelope stays pending across uncertain
        // commits; retry never consumes new input or changes its identity/content.
        const flush = Effect.suspend(() => {
          const current = pending;
          if (current === undefined) return Effect.void;
          return processEventReliably(current).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                pending = undefined;
                pendingBytes = 0;
                pendingCount = 0;
                timerGeneration += 1;
              }),
            ),
          );
        });
        options.onTextBatchFlusher?.((threadId) =>
          lock.withPermits(1)(
            Effect.suspend(() =>
              threadId === undefined || pending?.threadId === threadId ? flush : Effect.void,
            ),
          ),
        );
        const accept = (event: ProviderRuntimeEvent) =>
          Effect.uninterruptible(
            lock.withPermits(1)(
              Effect.gen(function* () {
                const bytes =
                  event.type === "content.delta" ? Buffer.byteLength(event.payload.delta) : 0;
                if (
                  pending !== undefined &&
                  compatibleAssistantText(pending, event) &&
                  pendingBytes + bytes <= PROVIDER_RUNTIME_TEXT_BATCH_MAX_BYTES &&
                  pendingCount < PROVIDER_RUNTIME_TEXT_BATCH_MAX_EVENTS
                ) {
                  pending = {
                    ...pending,
                    payload: {
                      ...pending.payload,
                      delta: pending.payload.delta + event.payload.delta,
                    },
                  };
                  pendingBytes += bytes;
                  pendingCount += 1;
                } else {
                  yield* flush;
                  if (
                    !isBatchableAssistantText(event) ||
                    bytes >= PROVIDER_RUNTIME_TEXT_BATCH_MAX_BYTES
                  ) {
                    yield* processEventReliably(event);
                    return;
                  }
                  pending = event;
                  pendingBytes = bytes;
                  pendingCount = 1;
                  const generation = ++timerGeneration;
                  yield* Effect.sleep(PROVIDER_RUNTIME_TEXT_BATCH_WINDOW_MS).pipe(
                    Effect.andThen(
                      lock.withPermits(1)(
                        Effect.suspend(() =>
                          timerGeneration === generation ? flush : Effect.void,
                        ),
                      ),
                    ),
                    Effect.forkScoped,
                  );
                }
                if (
                  pendingBytes >= PROVIDER_RUNTIME_TEXT_BATCH_MAX_BYTES ||
                  pendingCount >= PROVIDER_RUNTIME_TEXT_BATCH_MAX_EVENTS
                )
                  yield* flush;
              }),
            ),
          );
        // End, defect, and graceful scope interruption settle every admitted delta
        // before subscription restart or producer shutdown. Controls flush inline.
        yield* Stream.runForEach(options.stream, accept).pipe(
          Effect.ensuring(lock.withPermits(1)(flush)),
          Effect.ensuring(Effect.sync(() => options.onTextBatchFlusher?.(undefined))),
        );
      }),
    );
  };

  const supervise = (restartAttempt = 0): Effect.Effect<void, never, R> =>
    setHealth(restartAttempt === 0 ? "healthy" : "recovering", restartAttempt).pipe(
      Effect.andThen(runStreamOnce()),
      Effect.matchCauseEffect({
        onFailure: (cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          const attempt = restartAttempt + 1;
          const delayMs = retryDelayMs(attempt, retryBaseDelayMs, retryMaxDelayMs);
          const detail = Cause.pretty(cause);
          return setHealth("recovering", attempt, detail).pipe(
            Effect.andThen(
              Effect.logError("provider.runtime_event_pump.stream_failed", {
                provider: options.provider,
                attempt,
                delayMs,
                cause: detail,
              }),
            ),
            Effect.andThen(Effect.sleep(delayMs)),
            Effect.andThen(supervise(attempt)),
          );
        },
        onSuccess: () => {
          const attempt = restartAttempt + 1;
          const delayMs = retryDelayMs(attempt, retryBaseDelayMs, retryMaxDelayMs);
          const detail = "Adapter runtime event stream ended unexpectedly.";
          return setHealth("recovering", attempt, detail).pipe(
            Effect.andThen(
              Effect.logWarning("provider.runtime_event_pump.stream_ended", {
                provider: options.provider,
                attempt,
                delayMs,
              }),
            ),
            Effect.andThen(Effect.sleep(delayMs)),
            Effect.andThen(supervise(attempt)),
          );
        },
      }),
    );

  return supervise();
}
