import { memo } from "react";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "~/lib/icons";

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

function formatResetsAt(resetsAt: string): string {
  const ms = Date.parse(resetsAt);
  if (Number.isNaN(ms)) return "";
  const secondsLeft = Math.max(0, Math.ceil((ms - Date.now()) / 1000));
  if (secondsLeft < 60) return ` Resets in ${secondsLeft}s.`;
  const minutesLeft = Math.ceil(secondsLeft / 60);
  return ` Resets in ${minutesLeft}m.`;
}

export const RateLimitBanner = memo(function RateLimitBanner({
  onDismiss,
  rateLimitStatus,
}: {
  onDismiss?: () => void;
  rateLimitStatus: RateLimitStatus | null;
}) {
  if (!rateLimitStatus) return null;

  const { status, resetsAt, utilization } = rateLimitStatus;
  const isRejected = status === "rejected";

  const message = isRejected
    ? `Rate limit reached.${resetsAt ? formatResetsAt(resetsAt) : ""}`
    : `Approaching rate limit${utilization !== undefined ? ` (${Math.round(utilization * 100)}% used)` : ""}.${resetsAt ? formatResetsAt(resetsAt) : ""}`;

  return (
    <div className="pt-3 mx-auto max-w-3xl px-4">
      <Alert variant={isRejected ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertDescription>{message}</AlertDescription>
        {onDismiss ? (
          <AlertAction>
            <Button
              aria-label="Dismiss rate limit status"
              size="icon-xs"
              title="Dismiss rate limit status"
              variant="ghost"
              onClick={onDismiss}
            >
              <XIcon className="size-3.5" />
            </Button>
          </AlertAction>
        ) : null}
      </Alert>
    </div>
  );
});
