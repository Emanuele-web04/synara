import { PROVIDER_DISPLAY_NAMES, type ServerProviderStatus } from "@t3tools/contracts";
import { memo } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "~/lib/icons";

export const ProviderHealthBanner = memo(function ProviderHealthBanner({
  onDismiss,
  status,
}: {
  onDismiss?: () => void;
  status: ServerProviderStatus | null;
}) {
  if (!status || status.status === "ready") {
    return null;
  }

  const providerLabel = PROVIDER_DISPLAY_NAMES[status.provider] ?? status.provider;
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = `${providerLabel} provider status`;

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="line-clamp-3" title={status.message ?? defaultMessage}>
          {status.message ?? defaultMessage}
        </AlertDescription>
        {onDismiss ? (
          <AlertAction>
            <Button
              aria-label="Dismiss provider status"
              size="icon-xs"
              title="Dismiss provider status"
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
