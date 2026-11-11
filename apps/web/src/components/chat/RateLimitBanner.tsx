// FILE: RateLimitBanner.tsx
// Purpose: Renders blocking provider rate limits near the active chat composer.
// Layer: Chat status presentation
// Exports: RateLimitBanner.

import { formatRateLimitMessage, type RateLimitStatus } from "~/lib/rateLimitStatus";
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
  const { t, formatLocale } = useTranslation();

  if (!rateLimitStatus || rateLimitStatus.status !== "rejected") return null;
  const message = formatRateLimitMessage(rateLimitStatus, t, formatLocale);

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
