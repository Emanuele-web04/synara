import type {
  OrchestrationPendingInteraction,
  OrchestrationThreadActivity,
} from "@synara/contracts";
import { isStalePendingRequestFailureDetail, pendingRequestInstanceKey } from "./threadSummary";

/** index invalidations without mixing runtime and orchestration sequences */
export function createStalePendingInteractionMatcher(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload" | "createdAt">>,
): (
  interaction: Pick<
    OrchestrationPendingInteraction,
    "interactionKind" | "requestId" | "createdAt"
  > & {
    readonly lifecycleGeneration?: string | null;
  },
) => boolean {
  const staleAtByInstance = new Map<string, string>();
  const keyOf = (kind: string, requestId: string, generation?: string | null) =>
    `${kind}\u0000${pendingRequestInstanceKey(requestId, generation ?? undefined)}`;
  for (const activity of activities) {
    const kind =
      activity.kind === "provider.approval.respond.failed"
        ? "approval"
        : activity.kind === "provider.user-input.respond.failed"
          ? "userInput"
          : null;
    if (kind === null || activity.payload === null || typeof activity.payload !== "object") {
      continue;
    }
    const payload = activity.payload as Record<string, unknown>;
    if (
      typeof payload.requestId !== "string" ||
      !isStalePendingRequestFailureDetail(
        typeof payload.detail === "string" ? payload.detail : undefined,
      )
    ) {
      continue;
    }
    const generation =
      typeof payload.lifecycleGeneration === "string" && payload.lifecycleGeneration.length > 0
        ? payload.lifecycleGeneration
        : undefined;
    const key = keyOf(kind, payload.requestId, generation);
    const previous = staleAtByInstance.get(key);
    if (previous === undefined || activity.createdAt > previous) {
      staleAtByInstance.set(key, activity.createdAt);
    }
  }
  return (interaction) => {
    if (
      interaction.lifecycleGeneration != null &&
      staleAtByInstance.has(
        keyOf(interaction.interactionKind, interaction.requestId, interaction.lifecycleGeneration),
      )
    ) {
      return true;
    }
    const legacyStaleAt = staleAtByInstance.get(
      keyOf(interaction.interactionKind, interaction.requestId),
    );
    // a legacy marker can't identify a generation — it only closes requests that existed when the callback was invalidated
    return legacyStaleAt !== undefined && legacyStaleAt >= interaction.createdAt;
  };
}

export const RESPONDING_INTERACTION_RECLAIM_GRACE_MS = 30_000;

export function respondingInteractionReclaimCutoff(requestedAt: string): string {
  const requestedAtMs = Date.parse(requestedAt);
  return Number.isNaN(requestedAtMs)
    ? requestedAt
    : new Date(requestedAtMs - RESPONDING_INTERACTION_RECLAIM_GRACE_MS).toISOString();
}

export function respondingInteractionReclaimAt(responseRequestedAt: string): string {
  const responseRequestedAtMs = Date.parse(responseRequestedAt);
  return Number.isNaN(responseRequestedAtMs)
    ? responseRequestedAt
    : new Date(responseRequestedAtMs + RESPONDING_INTERACTION_RECLAIM_GRACE_MS).toISOString();
}

export function isPendingInteractionResponseClaimable(input: {
  readonly status: OrchestrationPendingInteraction["status"];
  readonly responseRequestedAt: string | null;
  readonly requestedAt: string;
}): boolean {
  if (input.status === "pending" || input.status === "retryable" || input.status === "uncertain") {
    return true;
  }
  if (input.status !== "responding") {
    return false;
  }
  return (
    input.responseRequestedAt === null ||
    input.responseRequestedAt <= respondingInteractionReclaimCutoff(input.requestedAt)
  );
}
