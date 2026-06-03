/**
 * ExecutionRuntimePlanner - Validates a `RuntimePlan` against the resolved
 * provider descriptor *before* any provisioning, so unsupported plan/role
 * combinations fail early instead of after a remote instance exists.
 *
 * Validation only: it resolves the descriptor via `RuntimeProviderRegistry` and
 * checks the requested target kind, role, ports, persistence, and snapshot
 * against the descriptor's honest capabilities. It makes no provider calls.
 *
 * @module ExecutionRuntimePlanner
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { RuntimePlan, RuntimeRole } from "@t3tools/contracts";

import type { RuntimePlanRejectedError, RuntimeProviderUnsupportedError } from "../Errors.ts";

export interface ExecutionRuntimePlannerShape {
  /**
   * Validate the plan for a role against the provider descriptor. Succeeds with
   * the plan when valid; fails with every reason when not.
   */
  readonly validate: (
    plan: RuntimePlan,
    role: RuntimeRole,
  ) => Effect.Effect<RuntimePlan, RuntimePlanRejectedError | RuntimeProviderUnsupportedError>;
}

export class ExecutionRuntimePlanner extends ServiceMap.Service<
  ExecutionRuntimePlanner,
  ExecutionRuntimePlannerShape
>()("t3/executionRuntime/Services/ExecutionRuntimePlanner") {}
