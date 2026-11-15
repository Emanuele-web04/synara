// FILE: RateLimitBanner.tsx
// Purpose: Renders provider rate limits near the active chat composer.
// Layer: Chat status presentation
// Exports: RateLimitBanner.

import type { RateLimitStatus } from "~/lib/rateLimitStatus";
import { formatRateLimitResetCountdown } from "~/lib/rateLimits";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { IconButton } from "../ui/icon-button";
import { CircleAlertIcon, XIcon } from "~/lib/icons";
import { useTranslation } from "~/i18n";

export const RateLimitBanner = function RateLimitBanner({
  onDismiss,
  rateLimitStatus,
}: {
  onDismiss?: () => void;
  rateLimitStatus: RateLimitStatus | null;
}) {
  const { t } = useTranslation();

  if (!rateLimitStatus) return null;
  const { resetsAt, status, utilization } = rateLimitStatus;
  const isRejected = status === "rejected";
  const countdown = resetsAt ? formatRateLimitResetCountdown(resetsAt, t) : "";
  const resetSuffix = countdown ? ` ${countdown}.` : "";
  const message = isRejected
    ? t("chat:rateLimitReached", { value0: resetSuffix })
    : t("chat:approachingRateLimit", {
        value0: utilization !== undefined ? ` (${Math.round(utilization * 100)}% used)` : "",
        value1: resetSuffix,
      });

  return (
    <Alert variant={isRejected ? "error" : "warning"}>
      <CircleAlertIcon />
      <AlertDescription>{message}</AlertDescription>
      {onDismiss ? (
        <AlertAction>
          <IconButton
            label={t("chat:rateLimit_dismissStatus")}
            title={t("chat:rateLimit_dismissStatus")}
            onClick={onDismiss}
          >
            <XIcon className="size-3.5" />
          </IconButton>
        </AlertAction>
      ) : null}
    </Alert>
  );
};
