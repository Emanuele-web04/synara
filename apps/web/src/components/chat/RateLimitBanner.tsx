// FILE: RateLimitBanner.tsx
// Purpose: Derives and renders provider rate-limit warnings for the active chat.
// Layer: Chat status presentation
// Exports: RateLimitBanner and rate-limit derivation helpers.

import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { IconButton } from "../ui/icon-button";
import { CircleAlertIcon, XIcon } from "~/lib/icons";
import { ChatColumnBannerFrame } from "./ChatColumnBannerFrame";

export type RateLimitStatus = {
  status: "rejected" | "allowed_warning";
  resetsAt?: string;
  utilization?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function deriveLatestRateLimitStatus(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): RateLimitStatus | null {
  const now = Date.now();
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    if (!activity || activity.kind !== "account.rate-limited") continue;
    const payload = asRecord(activity.payload);
    if (!payload) continue;
    const status = payload.status;
    if (status !== "rejected" && status !== "allowed_warning") continue;
    // If resetsAt is in the past, the limit has expired — skip
    if (typeof payload.resetsAt === "string") {
      const resetsAtMs = Date.parse(payload.resetsAt);
      if (!Number.isNaN(resetsAtMs) && resetsAtMs < now) continue;
    }
    return {
      status,
      ...(typeof payload.resetsAt === "string" ? { resetsAt: payload.resetsAt } : {}),
      ...(typeof payload.utilization === "number" ? { utilization: payload.utilization } : {}),
    };
  }
  return null;
}

export const RateLimitBanner = memo(function RateLimitBanner({
  onDismiss,
  rateLimitStatus,
}: {
  onDismiss?: () => void;
  rateLimitStatus: RateLimitStatus | null;
}) {
  const { t } = useTranslation();
  if (!rateLimitStatus) return null;

  const { status, resetsAt, utilization } = rateLimitStatus;
  const isRejected = status === "rejected";

  const buildResetText = (iso: string): string => {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return "";
    const secondsLeft = Math.max(0, Math.ceil((ms - Date.now()) / 1000));
    if (secondsLeft < 60) return t("chat.rateLimit.resetsInSeconds", { seconds: secondsLeft });
    const minutesLeft = Math.ceil(secondsLeft / 60);
    return t("chat.rateLimit.resetsInMinutes", { minutes: minutesLeft });
  };

  const resetText = resetsAt ? buildResetText(resetsAt) : "";

  const message = isRejected
    ? `${t("chat.rateLimit.rateLimitReached")}${resetText}`
    : `${t("chat.rateLimit.approachingRateLimit")}${utilization !== undefined ? ` (${Math.round(utilization * 100)}% used)` : ""}.${resetText}`;

  return (
    <ChatColumnBannerFrame>
      <Alert variant={isRejected ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertDescription>{message}</AlertDescription>
        {onDismiss ? (
          <AlertAction>
            <IconButton
              label={t("chat.rateLimit.dismissStatus")}
              title={t("chat.rateLimit.dismissStatus")}
              onClick={onDismiss}
            >
              <XIcon className="size-3.5" />
            </IconButton>
          </AlertAction>
        ) : null}
      </Alert>
    </ChatColumnBannerFrame>
  );
});
