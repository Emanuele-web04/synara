import { t } from "~/i18n";
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

const BLOCKED_DETAIL_KEYS: Readonly<Record<string, string>> = {
  extra_usage_disabled: "chat:fastModeUnavailable_extra_usage_disabled",
  free: "chat:fastModeUnavailable_free",
  not_first_party: "chat:fastModeUnavailable_not_first_party",
  disabled_by_env: "chat:fastModeUnavailable_disabled_by_env",
  model_not_allowed: "chat:fastModeUnavailable_model_not_allowed",
  network_error: "chat:fastModeUnavailable_network_error",
};

export const FAST_MODE_STATE_ACTIVITY_KIND = "fast-mode.state";

// Read the fast-mode state the provider last reported for the thread. Returns
// null when fast mode is serving requests or nothing contradicts the request.
export function deriveFastModeNotice(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  translate: typeof t = t,
): FastModeNotice | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    // A successful handoff starts a different session/account. An older SDK
    // may never report its state, so the previous account is no longer evidence.
    if (activity.kind === "provider.handoff") return null;
    if (activity.kind === FAST_MODE_STATE_ACTIVITY_KIND)
      return fastModeNoticeFromActivity(activity, translate);
  }
  return null;
}

export function fastModeNoticeFromActivity(
  activity: OrchestrationThreadActivity | null | undefined,
  translate: typeof t = t,
): FastModeNotice | null {
  const payload =
    activity?.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (payload?.state === "cooldown") {
    return {
      kind: "cooldown",
      label: translate("chat:fastModePaused"),
      detail: translate("chat:fastModePausedDescription"),
    };
  }
  if (payload?.state !== "off") {
    return null;
  }
  const reason = typeof payload.disabledReason === "string" ? payload.disabledReason : null;
  if (reason === null || NOT_REQUESTED_REASONS.has(reason)) {
    return null;
  }
  const detailKey = Object.hasOwn(BLOCKED_DETAIL_KEYS, reason)
    ? BLOCKED_DETAIL_KEYS[reason]!
    : "chat:fastModeUnavailableUnknown";
  return {
    kind: "blocked",
    label: translate("chat:fastModeUnavailable"),
    detail: translate(detailKey),
  };
}
