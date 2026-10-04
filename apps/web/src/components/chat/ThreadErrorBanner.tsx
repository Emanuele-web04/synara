// FILE: ThreadErrorBanner.tsx
// Purpose: Shows dismissible thread-level runtime errors above the transcript.
// Layer: Chat status presentation
// Exports: ThreadErrorBanner
//
// The banner renders in flow at the top of the transcript pane so it can never
// cover message content; the transcript shrinks to make room for it. This row
// is the home for the visible thread's live error; threads off screen still
// toast via useThreadErrorToast.

import { isProviderDeliveryBlockDetail } from "@synara/shared/providerDeliveryBlock";

import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { CircleAlertIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export function ThreadErrorBanner({
  error,
  onDismiss,
  onUnblock,
  unblocking,
  className,
}: {
  error: string | null;
  onDismiss?: () => void;
  /** Recovery action offered only when the error is a provider-delivery quarantine. */
  onUnblock?: () => void;
  unblocking?: boolean;
  className?: string;
}) {
  if (!error) return null;
  const canUnblock = onUnblock !== undefined && isProviderDeliveryBlockDetail(error);
  return (
    <Alert variant="error" className={cn("w-full max-w-[36rem] shadow-sm", className)}>
      <CircleAlertIcon />
      <AlertDescription className="line-clamp-3" title={error}>
        {error}
      </AlertDescription>
      {canUnblock || onDismiss ? (
        <AlertAction className="items-center">
          {canUnblock ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={unblocking}
              onClick={onUnblock}
            >
              {unblocking ? "Unblocking…" : "Unblock thread"}
            </Button>
          ) : null}
          {onDismiss ? (
            <IconButton
              label="Dismiss error"
              className="size-6 text-destructive/60 hover:text-destructive sm:size-6"
              onClick={onDismiss}
            >
              <XIcon className="size-3.5" />
            </IconButton>
          ) : null}
        </AlertAction>
      ) : null}
    </Alert>
  );
}
