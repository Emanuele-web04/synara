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
import { useId, useState } from "react";

import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CopyTextButton } from "../ui/copyTextButton";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { IconButton } from "../ui/icon-button";
import { CircleAlertIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

type ThreadErrorBannerProps = {
  error: string | null;
  onDismiss?: () => void;
  /** Recovery action offered only when the error is a provider-delivery quarantine. */
  onUnblock?: () => void;
  unblocking?: boolean;
  className?: string;
};

export function ThreadErrorBanner(props: ThreadErrorBannerProps) {
  if (!props.error) return null;
  // A different failure starts collapsed, with fresh copy feedback.
  return <ThreadErrorBannerContent key={props.error} {...props} error={props.error} />;
}

function ThreadErrorBannerContent({
  error,
  onDismiss,
  onUnblock,
  unblocking,
  className,
}: ThreadErrorBannerProps & { error: string }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const canUnblock = onUnblock !== undefined && isProviderDeliveryBlockDetail(error);
  return (
    <Alert variant="error" className={cn("w-full max-w-[36rem] shadow-sm", className)}>
      <CircleAlertIcon />
      <AlertDescription className="min-w-0">
        <div className="[overflow-wrap:anywhere]">
          {!expanded ? <p className="line-clamp-3 whitespace-pre-wrap">{error}</p> : null}
          <div id={detailsId}>
            <DisclosureRegion open={expanded}>
              <p className="max-h-60 overflow-y-auto whitespace-pre-wrap" tabIndex={0}>
                {error}
              </p>
            </DisclosureRegion>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((value) => !value)}
          >
            <DisclosureChevron open={expanded} />
            {expanded ? "Hide details" : "Show details"}
          </Button>
          <CopyTextButton text={error} label="error" />
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
        </div>
      </AlertDescription>
      {onDismiss ? (
        <AlertAction className="items-center">
          <IconButton
            label="Dismiss error"
            className="size-6 text-destructive/60 hover:text-destructive sm:size-6"
            onClick={onDismiss}
          >
            <XIcon className="size-3.5" />
          </IconButton>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
