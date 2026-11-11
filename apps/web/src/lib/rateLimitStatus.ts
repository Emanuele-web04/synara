// FILE: rateLimitStatus.ts
// Purpose: Current provider quota state and shared warning copy for Usage and chat status.

import type { OrchestrationThreadActivity, ProviderKind } from "@synara/contracts";
import { t } from "~/i18n";

export type RateLimitStatus = {
  status: "rejected" | "allowed_warning";
  resetsAt?: string;
  utilization?: number;
};

export function deriveLatestRateLimitStatus(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  now = Date.now(),
  scope?: { provider: ProviderKind; instanceId: string },
): RateLimitStatus | null {
  const seenWindows = new Set<string>();
  let warning: RateLimitStatus | null = null;
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    if (
      !activity ||
      (activity.kind !== "account.rate-limited" && activity.kind !== "account.rate-limits.updated")
    )
      continue;
    const rawPayload = activity.payload;
    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) continue;
    const payload = rawPayload as Record<string, unknown>;
    if (
      scope &&
      ((typeof payload.provider === "string" && payload.provider !== scope.provider) ||
        (payload.providerInstanceId ?? payload.provider ?? scope.provider) !== scope.instanceId)
    )
      continue;
    const status = payload.status;
    // Recovery frames supersede a previous warning. Other usage updates (e.g. Codex
    // window snapshots) carry no Claude admission status and must not clear it.
    if (status !== "allowed" && status !== "rejected" && status !== "allowed_warning") continue;
    const window = typeof payload.rateLimitType === "string" ? payload.rateLimitType : "account";
    if (seenWindows.has(window)) continue;
    seenWindows.add(window);
    if (status === "allowed") {
      if (window === "account") return warning;
      continue;
    }
    if (typeof payload.resetsAt === "string" && Date.parse(payload.resetsAt) <= now) continue;
    const current: RateLimitStatus = {
      status,
      ...(typeof payload.resetsAt === "string" ? { resetsAt: payload.resetsAt } : {}),
      ...(typeof payload.utilization === "number" && Number.isFinite(payload.utilization)
        ? { utilization: payload.utilization }
        : {}),
    };
    if (status === "rejected") return current;
    warning ??= current;
  }
  return warning;
}

export function formatRateLimitMessage(
  rateLimitStatus: RateLimitStatus,
  translate: typeof t,
  formatLocale: string,
): string {
  const resetAt = rateLimitStatus.resetsAt
    ? new Date(rateLimitStatus.resetsAt).toLocaleTimeString(formatLocale)
    : null;
  if (rateLimitStatus.status === "rejected") {
    return resetAt
      ? translate("chat:rateLimitReachedReset", { resetAt })
      : translate("chat:rateLimitReachedNoReset");
  }
  const usage =
    typeof rateLimitStatus.utilization === "number"
      ? new Intl.NumberFormat(formatLocale, { style: "percent", maximumFractionDigits: 0 }).format(
          rateLimitStatus.utilization,
        )
      : null;
  if (usage !== null) {
    return resetAt
      ? translate("chat:rateLimitApproachingUsageReset", { usage, resetAt })
      : translate("chat:rateLimitApproachingUsage", { usage });
  }
  return resetAt
    ? translate("chat:rateLimitApproachingReset", { resetAt })
    : translate("chat:rateLimitApproaching");
}
