// FILE: ThreadErrorBanner.tsx
// Purpose: Presents runtime errors and persistent turn failures with recovery actions.
// Layer: Chat status presentation
// Exports: ThreadErrorBanner
//
// Live session errors sit above the transcript; durable turn failures reuse
// the same banner inside the timeline. Threads off screen still toast live
// session errors via useThreadErrorToast.

import { isProviderDeliveryBlockDetail } from "@synara/shared/providerDeliveryBlock";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { CircleAlertIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export function ThreadErrorBanner({
  error,
  title,
  onContinue,
  onChangeModel,
  recoveryDisabled,
  onDismiss,
  onUnblock,
  unblocking,
  className,
}: {
  error: string | null;
  title?: string;
  onContinue?: () => void;
  onChangeModel?: () => void;
  recoveryDisabled?: boolean;
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
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      <AlertDescription className={title ? undefined : "line-clamp-3"} title={error}>
        {error}
        {onContinue ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={recoveryDisabled}
              onClick={onContinue}
            >
              Continue task
            </Button>
            {onChangeModel ? (
              <Button
                size="xs"
                variant="outline"
                disabled={recoveryDisabled}
                onClick={onChangeModel}
              >
                Change model
              </Button>
            ) : null}
          </div>
        ) : null}
      </AlertDescription>
      {canUnblock || onDismiss ? (
        <AlertAction className="items-center">
          {canUnblock ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={unblocking}
              onClick={() => onUnblock?.()}
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
