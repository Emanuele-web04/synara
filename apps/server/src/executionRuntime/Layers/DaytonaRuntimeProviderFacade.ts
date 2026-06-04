/**
 * DaytonaRuntimeProviderFacade - adapts the Daytona runtime adapter to the
 * provider-agnostic `ExecutionRuntimeProviderAdapterShape` the registry resolves.
 *
 * The Daytona adapter provisions from a Daytona-shaped input and fails with
 * `DaytonaApiError`; the common surface provisions from a public `RuntimePlan`
 * and carries narrower channels (no error on `provision`/`createTransport`,
 * `RuntimeInstanceUnknownError` on `execCollect`). This facade owns that
 * translation: it maps the plan onto the Daytona provision input, erases the
 * provider error on the channels the common shape declares as `never` (via
 * `Effect.orDie`), and converts the provider error to `RuntimeInstanceUnknownError`
 * on `execCollect`. Provider-only operations (exposePort/snapshot/refreshActivity/
 * stop) stay on the concrete adapter for the lease/ingress slices to call directly.
 *
 * Mirrors `FakeRuntimeProviderFacade`: the service never learns Daytona's input
 * shape or error types.
 *
 * @module DaytonaRuntimeProviderFacade
 */
import { Effect } from "effect";

import type { RuntimePlan } from "@t3tools/contracts";

import { RuntimeInstanceUnknownError } from "../Errors.ts";
import type { ExecutionRuntimeProviderAdapterShape } from "../Services/ExecutionRuntimeProviderAdapter.ts";
import type { DaytonaRuntimeAdapterShape } from "../providers/daytona/DaytonaRuntimeAdapter.ts";

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
      Effect.orDie,
    ),
  createTransport: (instanceId, spawn) =>
    daytona.createTransport(instanceId, spawn).pipe(Effect.orDie),
  execCollect: (instanceId, input) =>
    daytona
      .execCollect(instanceId, input)
      .pipe(
        Effect.mapError(() => new RuntimeInstanceUnknownError({ instanceId: String(instanceId) })),
      ),
  isAlive: daytona.isAlive,
  destroy: daytona.destroy,
});
