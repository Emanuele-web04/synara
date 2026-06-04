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
import type { ExecutionRuntimeProviderAdapterShape } from "../Services/ExecutionRuntimeProviderAdapter.ts";
import type { DaytonaRuntimeAdapterShape } from "../providers/daytona/DaytonaRuntimeAdapter.ts";

const toRemoteOperationFailed = (error: DaytonaApiError): RuntimeRemoteOperationFailedError =>
  new RuntimeRemoteOperationFailedError({
    provider: "daytona",
    operation: error.operation,
    detail: error.detail,
  });

const provisionInput = (
  threadId: string,
  plan: RuntimePlan,
): {
  readonly threadId: string;
  readonly ports: ReadonlyArray<number>;
  readonly snapshotId: string | null;
} => ({
  threadId,
  ports: plan.ports ?? [],
  snapshotId: plan.snapshotId == null ? null : String(plan.snapshotId),
});

export const makeDaytonaRuntimeProviderFacade = (
  daytona: DaytonaRuntimeAdapterShape,
): ExecutionRuntimeProviderAdapterShape => ({
  provision: ({ threadId, plan }) =>
    daytona.provision(provisionInput(String(threadId), plan)).pipe(
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
  isAlive: daytona.isAlive,
  destroy: daytona.destroy,
});
