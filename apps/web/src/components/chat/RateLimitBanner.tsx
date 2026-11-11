// FILE: RateLimitBanner.tsx
// Purpose: Renders blocking provider rate limits near the active chat composer.
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

  if (!rateLimitStatus || rateLimitStatus.status !== "rejected") return null;
  const countdown = rateLimitStatus.resetsAt
    ? formatRateLimitResetCountdown(rateLimitStatus.resetsAt, t)
    : "";
  const message = t("chat:rateLimitReached", { value0: countdown ? ` ${countdown}.` : "" });

  return (
    <Alert variant="error">
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
