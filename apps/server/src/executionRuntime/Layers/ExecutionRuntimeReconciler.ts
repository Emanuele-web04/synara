/**
 * ExecutionRuntimeReconcilerLive - Partial-failure recovery for remote runtimes.
 *
 * Each sweep lists the operational instances the DB still believes are live
 * (everything not already `destroyed`/`failed`/`lost`) and resolves each one
 * deterministically against the partial-failure matrix:
 *
 * - DB row exists but the provider has no record of it (crash after create,
 *   event-appended-but-provision-failed, divergence) → `probeInstance` reports
 *   `absent` → mark `lost`.
 * - Provider cannot reconnect after a restart at all (`supportsReconnect:false`)
 *   → the instance is unrecoverable → mark `lost`.
 * - Provider re-attaches (`alive`) and the instance is within TTL/idle policy →
 *   leave it. The provider call that records the resolved fact is provider-
 *   agnostic: the reconciler only ever calls `ExecutionRuntimeService`.
 * - Instance stuck mid-teardown (`destroying`/`stopping`) → retry destroy.
 * - Instance past its TTL or idle threshold → destroy (and record the resolved
 *   state through the same seam).
 *
 * Provider-agnostic by construction: the reconciler reads capability flags and a
 * liveness verdict from `ExecutionRuntimeService.probeInstance`; it never names
 * Daytona/Vercel/Modal/Cloudflare, mirroring how the orchestration seam stays
 * agent-provider-agnostic today.
 *
 * @module ExecutionRuntimeReconcilerLive
 */
import { Cause, Duration, Effect, Layer, Option, Schedule } from "effect";

import { ProjectionThreadRuntimeRepository } from "../../persistence/Services/ProjectionThreadRuntime.ts";
import type { ExecutionRuntimeInstance } from "../../persistence/Services/ProjectionThreadRuntime.ts";
import { ExecutionRuntimeService } from "../Services/ExecutionRuntimeService.ts";
import {
  ExecutionRuntimeReconciler,
  type ExecutionRuntimeReconcileSummary,
  type ExecutionRuntimeReconcilerShape,
} from "../Services/ExecutionRuntimeReconciler.ts";

const DEFAULT_INSTANCE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface ExecutionRuntimeReconcilerLiveOptions {
  /** Max instance age before it is destroyed regardless of activity. */
  readonly instanceTtlMs?: number;
  /** Idle window (no recorded activity) before an instance is destroyed. */
  readonly idleThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  /** Clock injection point for deterministic TTL/idle tests. */
  readonly now?: () => number;
}

// Statuses that mean the provider is mid-teardown: a destroy was requested but
// not confirmed (the "destroy timed out" matrix entry). Retrying destroy is safe
// because destroy is idempotent and dedupes on its stable commandId.
const PENDING_DESTROY_STATUSES: ReadonlySet<string> = new Set(["destroying", "stopping"]);

const makeExecutionRuntimeReconciler = (options?: ExecutionRuntimeReconcilerLiveOptions) =>
  Effect.gen(function* () {
    const repository = yield* ProjectionThreadRuntimeRepository;
    const service = yield* ExecutionRuntimeService;

    const instanceTtlMs = Math.max(1, options?.instanceTtlMs ?? DEFAULT_INSTANCE_TTL_MS);
    const idleThresholdMs = Math.max(1, options?.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS);
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const now = options?.now ?? Date.now;

    const parseMs = (value: string | null): number | null => {
      if (value === null) return null;
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? null : parsed;
    };

    // The instance's last recorded activity, used for idle enforcement. Falls
    // back to the read-model's `lastActivityAt`, then the instance's `updatedAt`.
    const resolveLastActivityMs = (instance: ExecutionRuntimeInstance) =>
      repository.getReadModelByThreadId({ threadId: instance.threadId }).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.catchCause(() => Effect.succeed(undefined)),
        Effect.map((readModel) => {
          const fromReadModel = readModel ? parseMs(readModel.lastActivityAt) : null;
          return fromReadModel ?? parseMs(instance.updatedAt) ?? now();
        }),
      );

    const markLost = (instance: ExecutionRuntimeInstance, reason: string) =>
      service
        .recordInstanceState({
          threadId: instance.threadId,
          instanceId: instance.instanceId,
          status: "lost",
          failureReason: reason,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("execution-runtime reconciler failed to mark instance lost", {
              instanceId: instance.instanceId,
              threadId: instance.threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        );

    const retryDestroy = (instance: ExecutionRuntimeInstance) =>
      service.destroy(instance.threadId, instance.instanceId, instance.provider).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("execution-runtime reconciler failed to retry destroy", {
            instanceId: instance.instanceId,
            threadId: instance.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );

    const reconcileInstance = (
      instance: ExecutionRuntimeInstance,
    ): Effect.Effect<{
      readonly markedLost: boolean;
      readonly retriedDestroy: boolean;
      readonly expired: boolean;
    }> =>
      Effect.gen(function* () {
        // A destroy that never confirmed: re-issue it. Idempotent + commandId
        // dedupe make this safe to repeat every sweep until it lands.
        if (PENDING_DESTROY_STATUSES.has(instance.status)) {
          yield* retryDestroy(instance);
          return { markedLost: false, retriedDestroy: true, expired: false };
        }

        const probe = yield* service
          .probeInstance({ provider: instance.provider, instanceId: instance.instanceId })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("execution-runtime reconciler probe failed", {
                instanceId: instance.instanceId,
                threadId: instance.threadId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as({ supportsReconnect: false, liveness: "absent" as const })),
            ),
          );

        // Provider cannot reconnect, or reconnect succeeded but the instance is
        // gone: either way the DB row is unrecoverable. Mark it lost so the
        // read-model and operational table converge on a terminal state.
        if (!probe.supportsReconnect) {
          yield* markLost(instance, "provider does not support reconnect after restart");
          return { markedLost: true, retriedDestroy: false, expired: false };
        }
        if (probe.liveness === "absent") {
          yield* markLost(instance, "provider has no record of instance");
          return { markedLost: true, retriedDestroy: false, expired: false };
        }

        // Re-attached and live. Enforce TTL/idle: a stale instance is destroyed
        // through the same provider-agnostic seam.
        const createdMs = parseMs(instance.createdAt) ?? now();
        const ageMs = now() - createdMs;
        if (ageMs >= instanceTtlMs) {
          yield* retryDestroy(instance);
          return { markedLost: false, retriedDestroy: false, expired: true };
        }
        const lastActivityMs = yield* resolveLastActivityMs(instance);
        if (now() - lastActivityMs >= idleThresholdMs) {
          yield* retryDestroy(instance);
          return { markedLost: false, retriedDestroy: false, expired: true };
        }

        return { markedLost: false, retriedDestroy: false, expired: false };
      });

    const reconcileOnce: ExecutionRuntimeReconcilerShape["reconcileOnce"] = () =>
      Effect.gen(function* () {
        const instances = yield* repository
          .listActiveInstances()
          .pipe(
            Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<ExecutionRuntimeInstance>)),
          );

        let markedLost = 0;
        let retriedDestroy = 0;
        let expired = 0;
        for (const instance of instances) {
          const outcome = yield* reconcileInstance(instance);
          if (outcome.markedLost) markedLost += 1;
          if (outcome.retriedDestroy) retriedDestroy += 1;
          if (outcome.expired) expired += 1;
        }
        return {
          examined: instances.length,
          markedLost,
          retriedDestroy,
          expired,
        } satisfies ExecutionRuntimeReconcileSummary;
      });

    const runSweepSafely = reconcileOnce().pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("execution-runtime reconciler sweep failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

    const start: ExecutionRuntimeReconcilerShape["start"] = () =>
      Effect.forkScoped(
        runSweepSafely.pipe(Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs)))),
      ).pipe(Effect.asVoid);

    return { reconcileOnce, start } satisfies ExecutionRuntimeReconcilerShape;
  });

export const makeExecutionRuntimeReconcilerLive = (
  options?: ExecutionRuntimeReconcilerLiveOptions,
) => Layer.effect(ExecutionRuntimeReconciler, makeExecutionRuntimeReconciler(options));

export const ExecutionRuntimeReconcilerLive = makeExecutionRuntimeReconcilerLive();
