/**
 * DaytonaRuntimeProviderFacade - adapts the Daytona runtime adapter to the
 * provider-agnostic `ExecutionRuntimeProviderAdapterShape` the registry resolves.
 *
 * The Daytona adapter provisions from a Daytona-shaped input and fails with
 * `DaytonaApiError`; the common surface provisions from a public `RuntimePlan`
 * and carries provider-neutral channels (`RuntimeRemoteOperationFailedError` on
 * `provision`/`createTransport`, `RuntimeInstanceUnknownError` on `execCollect`).
 * This facade owns that translation: it maps the plan onto the Daytona provision
 * input, converts the `DaytonaApiError` to `RuntimeRemoteOperationFailedError` on
 * `provision`/`createTransport` so a real outage surfaces as a recoverable typed
 * failure, and converts the provider error to `RuntimeInstanceUnknownError` on
 * `execCollect`. Provider-only operations (exposePort/snapshot/refreshActivity/
 * stop) stay on the concrete adapter for the lease/ingress slices to call directly.
 *
 * Mirrors `FakeRuntimeProviderFacade`: the service never learns Daytona's input
 * shape or error types.
 *
 * @module DaytonaRuntimeProviderFacade
 */
import { Effect } from "effect";

import type { RuntimePlan } from "@t3tools/contracts";

import { RuntimeInstanceUnknownError, RuntimeRemoteOperationFailedError } from "../Errors.ts";
import type { DaytonaApiError } from "../providers/daytona/DaytonaErrors.ts";
import type {
  ExecutionRuntimeProviderAdapterShape,
  ExecutionRuntimeProvisionInput,
} from "../Services/ExecutionRuntimeProviderAdapter.ts";
import type {
  DaytonaProvisionInput,
  DaytonaRuntimeAdapterShape,
} from "../providers/daytona/DaytonaRuntimeAdapter.ts";

const toRemoteOperationFailed = (error: DaytonaApiError): RuntimeRemoteOperationFailedError =>
  new RuntimeRemoteOperationFailedError({
    provider: "daytona",
    operation: error.operation,
    detail: error.detail,
  });

const provisionInput = (
  threadId: string,
  plan: RuntimePlan,
  repoSource: ExecutionRuntimeProvisionInput["repoSource"],
): DaytonaProvisionInput => ({
  threadId,
  ports: plan.ports ?? [],
  snapshotId: plan.snapshotId == null ? null : String(plan.snapshotId),
  ...(repoSource !== undefined ? { repoSource } : {}),
});

export const makeDaytonaRuntimeProviderFacade = (
  daytona: DaytonaRuntimeAdapterShape,
): ExecutionRuntimeProviderAdapterShape => ({
  provision: ({ threadId, plan, repoSource }) =>
    daytona.provision(provisionInput(String(threadId), plan, repoSource)).pipe(
      Effect.map((context) => ({ instance: context.instance, rootPath: context.rootPath })),
      Effect.mapError(toRemoteOperationFailed),
    ),
  createTransport: (instanceId, spawn) =>
    daytona.createTransport(instanceId, spawn).pipe(Effect.mapError(toRemoteOperationFailed)),
  execCollect: (instanceId, input) =>
    daytona
      .execCollect(instanceId, input)
      .pipe(
        Effect.mapError(() => new RuntimeInstanceUnknownError({ instanceId: String(instanceId) })),
      ),
  // Refresh the injected host codex auth on resume so an expired ChatGPT token is
  // rewritten before the next turn. Best-effort: a failed rewrite never blocks the
  // resume (codex surfaces its own auth error on first turn instead).
  reinjectCredentials: (instanceId) =>
    daytona
      .reinjectCredentials(instanceId)
      .pipe(
        Effect.catchCause(() =>
          Effect.logWarning(
            `Daytona credential reinjection failed for ${String(instanceId)}; the agent may hit a stale-auth error on its first turn after resume.`,
          ),
        ),
      ),
  // Route the activity-lease keepalive to Daytona's auto-stop refresh. Daytona
  // auto-stops an idle sandbox, so the service renews this on a timer under a live
  // turn. Best-effort: a failed refresh never breaks the renew loop (the next tick
  // retries, and the reconciler's idle-skip already protects a live transport).
  refreshActivity: (instanceId) => daytona.refreshActivity(instanceId).pipe(Effect.ignore),
  isAlive: daytona.isAlive,
  livenessProbe: daytona.livenessProbe,
  // Resume a stopped sandbox (reuse its disk) instead of re-provisioning. Returns
  // false when the provider reclaimed it, so the caller provisions fresh.
  start: daytona.start,
  destroy: daytona.destroy,
  // Surface Daytona's native stop/snapshot through the common surface. The
  // service drives these from user-initiated runtime actions, so a provider
  // outage degrades to a no-op (the service still records the requested state)
  // rather than failing the action.
  stop: (instanceId) => daytona.stop(instanceId).pipe(Effect.ignore),
  snapshot: (instanceId, label) =>
    daytona.snapshot(instanceId, label).pipe(
      Effect.map((result) => result.snapshotId),
      Effect.orElseSucceed(() => null),
    ),
});
