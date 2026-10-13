import { ModelSelection, type OrchestrationThreadActivity } from "@synara/contracts";
import { Schema } from "effect";
import { resolveModelSelectionInstanceId } from "./providerInstances";

export const PROVIDER_HANDOFF_REQUESTED_ACTIVITY_KIND = "provider.handoff.requested";
export const PROVIDER_HANDOFF_COMPLETED_ACTIVITY_KIND = "provider.handoff";
export const PROVIDER_HANDOFF_FAILED_ACTIVITY_KIND = "provider.handoff.failed";

export interface PendingProviderHandoff {
  readonly handoffCommandId: string;
  readonly sourceModelSelection: ModelSelection;
  readonly targetModelSelection: ModelSelection;
  readonly cancellationRequestedAt?: string;
}

const modelSelectionsEqual = Schema.toEquivalence(ModelSelection);

export function providerHandoffModelSelectionsEqual(
  left: ModelSelection,
  right: ModelSelection,
): boolean {
  // Decoding a persisted selection materializes the default instance ID. An
  // admission payload can still contain the equivalent legacy omission.
  return modelSelectionsEqual(
    { ...left, instanceId: resolveModelSelectionInstanceId(left) },
    { ...right, instanceId: resolveModelSelectionInstanceId(right) },
  );
}

export function toProviderHandoffActivityModelSelection(
  modelSelection: ModelSelection,
): OrchestrationThreadActivity["payload"] {
  return JSON.parse(JSON.stringify(modelSelection)) as OrchestrationThreadActivity["payload"];
}

/** Provider transitions are conversation metadata, outside the ordinary work-log cap. */
export function isProviderHandoffActivity(activity: { readonly kind: string }): boolean {
  return (
    activity.kind === PROVIDER_HANDOFF_REQUESTED_ACTIVITY_KIND ||
    activity.kind === PROVIDER_HANDOFF_COMPLETED_ACTIVITY_KIND ||
    activity.kind === "provider.handoff.completed" ||
    activity.kind === PROVIDER_HANDOFF_FAILED_ACTIVITY_KIND
  );
}

/**
 * Resolves the latest durable request that has no matching server outcome.
 * Activities are in projection sequence order; serialized command admission
 * allows at most one unresolved request. Public appends reserve both these
 * activity kinds and their IDs, so they cannot forge or overwrite this state.
 */
export function resolvePendingProviderHandoff(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>,
): PendingProviderHandoff | null {
  let pending: PendingProviderHandoff | null = null;
  for (const activity of activities) {
    if (!isProviderHandoffActivity(activity)) continue;
    if (typeof activity.payload !== "object" || activity.payload === null) continue;
    const payload = activity.payload as {
      readonly handoffCommandId?: unknown;
      readonly sourceModelSelection?: unknown;
      readonly targetModelSelection?: unknown;
      readonly cancellationRequestedAt?: unknown;
    };
    if (typeof payload.handoffCommandId !== "string") continue;
    if (activity.kind === PROVIDER_HANDOFF_REQUESTED_ACTIVITY_KIND) {
      if (
        Schema.is(ModelSelection)(payload.sourceModelSelection) &&
        Schema.is(ModelSelection)(payload.targetModelSelection)
      ) {
        pending = {
          handoffCommandId: payload.handoffCommandId,
          sourceModelSelection: payload.sourceModelSelection,
          targetModelSelection: payload.targetModelSelection,
          ...(typeof payload.cancellationRequestedAt === "string"
            ? { cancellationRequestedAt: payload.cancellationRequestedAt }
            : {}),
        };
      }
    } else if (pending?.handoffCommandId === payload.handoffCommandId) {
      pending = null;
    }
  }
  return pending;
}

export function retainProviderHandoffHistory<T extends { readonly kind: string }>(
  activities: readonly T[],
  maxActivities: number,
): readonly T[] {
  if (activities.length <= maxActivities) return activities;
  const tailStart = activities.length - maxActivities;
  return activities.filter(
    (activity, index) => index >= tailStart || isProviderHandoffActivity(activity),
  );
}
