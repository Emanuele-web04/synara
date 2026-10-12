import type { OrchestrationThreadActivity } from "@synara/contracts";

/** Why a requested fast mode is not the speed the thread is getting. */
export interface FastModeNotice {
  readonly kind: "blocked" | "cooldown";
  /** Short value shown where the selection would read "Fast". */
  readonly label: string;
  /** Full sentence for tooltips and menu notes. */
  readonly detail: string;
}

// These reasons mean "not requested yet" rather than "refused": the last report
// predates the toggle, so the requested option is still the best signal.
const NOT_REQUESTED_REASONS = new Set(["sdk_opt_in_required", "preference", "pending"]);

const BLOCKED_DETAIL_BY_REASON: Record<string, string> = {
  extra_usage_disabled: "usage credits are turned off for this Claude account",
  free: "this Claude plan does not include it",
  not_first_party: "it needs a first-party Anthropic account",
  disabled_by_env: "it is disabled in this environment",
  model_not_allowed: "this model does not support it",
  network_error: "Claude could not check its availability",
};

export const FAST_MODE_STATE_ACTIVITY_KIND = "fast-mode.state";

// Read the fast-mode state the provider last reported for the thread. Returns
// null when fast mode is serving requests or nothing contradicts the request.
export function deriveFastModeNotice(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): FastModeNotice | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    // A successful handoff starts a different session/account. An older SDK
    // may never report its state, so the previous account is no longer evidence.
    if (activity.kind === "provider.handoff") return null;
    if (activity.kind === FAST_MODE_STATE_ACTIVITY_KIND)
      return fastModeNoticeFromActivity(activity);
  }
  return null;
}

export function fastModeNoticeFromActivity(
  activity: OrchestrationThreadActivity | null | undefined,
): FastModeNotice | null {
  const payload =
    activity?.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (payload?.state === "cooldown") {
    return {
      kind: "cooldown",
      label: "Fast paused",
      detail: "Fast mode is paused after a rate limit. Requests run at standard speed for now.",
    };
  }
  if (payload?.state !== "off") {
    return null;
  }
  const reason = typeof payload.disabledReason === "string" ? payload.disabledReason : null;
  if (reason === null || NOT_REQUESTED_REASONS.has(reason)) {
    return null;
  }
  const cause = BLOCKED_DETAIL_BY_REASON[reason] ?? "Claude reported it as unavailable";
  return {
    kind: "blocked",
    label: "Fast unavailable",
    detail: `Fast mode is not active: ${cause}. Requests run at standard speed.`,
  };
}
