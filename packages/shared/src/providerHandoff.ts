import {
  ProviderKind,
  type ModelSelection,
  type OrchestrationThreadActivity,
} from "@synara/contracts";
import { Schema } from "effect";

export const PROVIDER_HANDOFF_REQUESTED_ACTIVITY_KIND = "provider.handoff.requested";
export const PROVIDER_HANDOFF_COMPLETED_ACTIVITY_KIND = "provider.handoff.completed";
export const PROVIDER_HANDOFF_FAILED_ACTIVITY_KIND = "provider.handoff.failed";

export interface PendingProviderHandoff {
  readonly handoffCommandId: string;
  readonly sourceModelSelection: ModelSelection;
  readonly targetModelSelection: ModelSelection;
}

export function toProviderHandoffActivityModelSelection(
  modelSelection: ModelSelection,
): OrchestrationThreadActivity["payload"] {
  return JSON.parse(JSON.stringify(modelSelection)) as OrchestrationThreadActivity["payload"];
}

function readModelSelection(value: unknown): ModelSelection | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { readonly provider?: unknown; readonly model?: unknown };
  return Schema.is(ProviderKind)(candidate.provider) && typeof candidate.model === "string"
    ? (value as ModelSelection)
    : null;
}

function readHandoffPayload(activity: Pick<OrchestrationThreadActivity, "payload">): {
  readonly handoffCommandId: string;
  readonly sourceModelSelection: ModelSelection | null;
  readonly targetModelSelection: ModelSelection | null;
} | null {
  if (typeof activity.payload !== "object" || activity.payload === null) return null;
  const payload = activity.payload as {
    readonly handoffCommandId?: unknown;
    readonly sourceModelSelection?: unknown;
    readonly targetModelSelection?: unknown;
  };
  if (typeof payload.handoffCommandId !== "string") return null;
  return {
    handoffCommandId: payload.handoffCommandId,
    sourceModelSelection: readModelSelection(payload.sourceModelSelection),
    targetModelSelection: readModelSelection(payload.targetModelSelection),
  };
}

/**
 * Resolves the latest durable provider-switch request that has no matching
 * completion or failure activity yet. Commands are serialized per thread, so
 * at most one unresolved request can be admitted at a time.
 */
export function resolvePendingProviderHandoff(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>,
): PendingProviderHandoff | null {
  let pending: PendingProviderHandoff | null = null;

  for (const activity of activities) {
    if (
      activity.kind !== PROVIDER_HANDOFF_REQUESTED_ACTIVITY_KIND &&
      activity.kind !== PROVIDER_HANDOFF_COMPLETED_ACTIVITY_KIND &&
      activity.kind !== PROVIDER_HANDOFF_FAILED_ACTIVITY_KIND
    ) {
      continue;
    }

    const payload = readHandoffPayload(activity);
    if (!payload) continue;

    if (activity.kind === PROVIDER_HANDOFF_REQUESTED_ACTIVITY_KIND) {
      if (payload.sourceModelSelection && payload.targetModelSelection) {
        pending = {
          handoffCommandId: payload.handoffCommandId,
          sourceModelSelection: payload.sourceModelSelection,
          targetModelSelection: payload.targetModelSelection,
        };
      }
      continue;
    }

    if (pending?.handoffCommandId === payload.handoffCommandId) {
      pending = null;
    }
  }

  return pending;
}
