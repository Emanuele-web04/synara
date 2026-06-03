/**
 * ExecutionRuntimePlannerLive - Pre-provision plan validation.
 *
 * Resolves the provider descriptor via `RuntimeProviderRegistry`, then checks
 * the `RuntimePlan` + `RuntimeRole` against the descriptor's honest
 * capabilities. Every violation is collected so callers see all reasons at
 * once. Validation only — no provisioning, no provider calls.
 *
 * @module ExecutionRuntimePlannerLive
 */
import { Effect, Layer } from "effect";

import type { RuntimePlan, RuntimeRole } from "@t3tools/contracts";

import { RuntimePlanRejectedError } from "../Errors.ts";
import {
  ExecutionRuntimePlanner,
  type ExecutionRuntimePlannerShape,
} from "../Services/ExecutionRuntimePlanner.ts";
import type { RuntimeProviderDescriptor } from "../Services/RuntimeProviderDescriptor.ts";
import { RuntimeProviderRegistry } from "../Services/RuntimeProviderRegistry.ts";

const collectRejectionReasons = (
  plan: RuntimePlan,
  role: RuntimeRole,
  descriptor: RuntimeProviderDescriptor,
): ReadonlyArray<string> => {
  const reasons: string[] = [];
  const { capabilities } = descriptor;
  const ports = plan.ports ?? [];

  if (!descriptor.targetKinds.includes(plan.targetKind)) {
    reasons.push(
      `provider does not back target kind "${plan.targetKind}" (supports: ${descriptor.targetKinds.join(", ")})`,
    );
  }

  if (!capabilities.exec.roles.includes(role)) {
    reasons.push(
      `provider cannot host role "${role}" (supports: ${capabilities.exec.roles.join(", ")})`,
    );
  }

  if (ports.length > 0 && !capabilities.ingress.exposePort) {
    reasons.push("provider does not support exposing ports");
  }

  if (capabilities.ingress.maxRoutes !== null && ports.length > capabilities.ingress.maxRoutes) {
    reasons.push(
      `plan requests ${ports.length} ports but provider allows at most ${capabilities.ingress.maxRoutes}`,
    );
  }

  if (plan.persistent && !capabilities.fs.persistent) {
    reasons.push("provider filesystem is not persistent");
  }

  if (plan.snapshotId !== null && !capabilities.persistence.snapshots) {
    reasons.push("provider does not support snapshots");
  }

  return reasons;
};

const makeExecutionRuntimePlanner = Effect.gen(function* () {
  const registry = yield* RuntimeProviderRegistry;

  const validate: ExecutionRuntimePlannerShape["validate"] = (plan, role) =>
    registry.getDescriptor(plan.provider).pipe(
      Effect.flatMap((descriptor) => {
        const reasons = collectRejectionReasons(plan, role, descriptor);
        if (reasons.length > 0) {
          return Effect.fail(
            new RuntimePlanRejectedError({
              provider: plan.provider,
              targetKind: plan.targetKind,
              reasons,
            }),
          );
        }
        return Effect.succeed(plan);
      }),
    );

  return { validate } satisfies ExecutionRuntimePlannerShape;
});

export const ExecutionRuntimePlannerLive = Layer.effect(
  ExecutionRuntimePlanner,
  makeExecutionRuntimePlanner,
);
