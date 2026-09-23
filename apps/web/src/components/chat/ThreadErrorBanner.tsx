// FILE: ThreadErrorBanner.tsx
// Purpose: Shows dismissible thread-level runtime errors inline over the transcript.
// Layer: Chat status presentation
// Exports: ThreadErrorBanner
//
// The banner renders as a floating overlay at the top of the transcript pane —
// never in normal flow — so surfacing an error cannot push the transcript or
// composer down (the layout shift that moved this surface to a toast in
// 6c1cfe73). This row is the home for the visible thread's live error; threads
// off screen still toast via useThreadErrorToast.

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
    // The transcript overlay wrapper is pointer-events-none so its margins do
    // not swallow clicks; the banner itself must re-enable them or Dismiss and
    // Unblock can never be pressed.
    <Alert
      variant="error"
      className={cn("pointer-events-auto w-full max-w-[36rem] shadow-sm", className)}
    >
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
