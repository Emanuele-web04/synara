// FILE: ThreadErrorBanner.tsx
// Purpose: Shows dismissible thread-level runtime errors above the transcript.
// Layer: Chat status presentation
// Exports: ThreadErrorBanner

import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { IconButton } from "../ui/icon-button";
import { CircleAlertIcon, XIcon } from "~/lib/icons";
import { ChatColumnBannerFrame } from "./ChatColumnBannerFrame";

export function ThreadErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  return (
    <ChatColumnBannerFrame>
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertDescription className="line-clamp-3" title={error}>
          {error}
        </AlertDescription>
        {onDismiss && (
          <AlertAction>
            <IconButton
              label="Dismiss error"
              className="size-6 text-destructive/60 hover:text-destructive sm:size-6"
              onClick={onDismiss}
            >
              <XIcon className="size-3.5" />
            </IconButton>
          </AlertAction>
        )}
      </Alert>
    </ChatColumnBannerFrame>
  );
}
