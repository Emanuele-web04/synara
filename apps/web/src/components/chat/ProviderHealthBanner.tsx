// FILE: ProviderHealthBanner.tsx
// Purpose: Surfaces provider availability warnings above the active chat.
// Layer: Chat status presentation
// Exports: ProviderHealthBanner

import { PROVIDER_DISPLAY_NAMES, type ServerProviderStatus } from "@t3tools/contracts";
import { memo } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { IconButton } from "../ui/icon-button";
import { CircleAlertIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  CHAT_COLUMN_FRAME_CLASS_NAME,
  CHAT_COLUMN_GUTTER_CLASS_NAME,
} from "./composerPickerStyles";

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
    <div className={cn("pt-3", CHAT_COLUMN_GUTTER_CLASS_NAME)}>
      <div className={CHAT_COLUMN_FRAME_CLASS_NAME}>
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="line-clamp-3" title={status.message ?? defaultMessage}>
          {status.message ?? defaultMessage}
        </AlertDescription>
        {onDismiss ? (
          <AlertAction>
            <IconButton
              label="Dismiss provider status"
              title="Dismiss provider status"
              onClick={onDismiss}
            >
              <XIcon className="size-3.5" />
            </IconButton>
          </AlertAction>
        ) : null}
      </Alert>
      </div>
    </div>
  );
});
