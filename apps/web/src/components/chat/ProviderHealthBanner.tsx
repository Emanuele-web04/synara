// FILE: ProviderHealthBanner.tsx
// Purpose: Surfaces provider availability warnings above the active chat.
// Layer: Chat status presentation
// Exports: ProviderHealthBanner

import { PROVIDER_DISPLAY_NAMES, type ServerProviderStatus } from "@t3tools/contracts";
import { memo } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { IconButton } from "../ui/icon-button";
import {
  EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME,
  NOTIFICATION_ICON_CLASS_NAME,
} from "../ui/notificationSurface";
import { CircleAlertIcon, TriangleAlertIcon, XIcon } from "~/lib/icons";
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
  const Icon = status.status === "error" ? CircleAlertIcon : TriangleAlertIcon;

  return (
    <div className={cn("pt-3", CHAT_COLUMN_GUTTER_CLASS_NAME)}>
      <div className={CHAT_COLUMN_FRAME_CLASS_NAME}>
        <Alert
          className={cn(EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME, "pr-10")}
          variant={status.status === "error" ? "error" : "warning"}
        >
          <Icon className={NOTIFICATION_ICON_CLASS_NAME} />
          <AlertTitle className="font-normal text-white">{title}</AlertTitle>
          <AlertDescription
            className="line-clamp-3 text-white/72"
            title={status.message ?? defaultMessage}
          >
            {status.message ?? defaultMessage}
          </AlertDescription>
          {onDismiss ? (
            <AlertAction className="absolute top-2 right-2">
              <IconButton
                className="size-6 rounded-full text-white/65 hover:bg-white/10 hover:text-white focus-visible:ring-white/35 sm:size-6"
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
