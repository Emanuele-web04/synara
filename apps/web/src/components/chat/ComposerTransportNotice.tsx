import { useEffect, useState } from "react";

import { CircleAlertIcon } from "~/lib/icons";
import { subscribeComposerTransportStatus } from "~/lib/composerTransportStatus";
import { ComposerStackedPanel } from "./ComposerStackedPanel";

/** Transport presentation stays local; it must not become a transcript activity signal. */
export function ComposerTransportNotice() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => subscribeComposerTransportStatus(setMessage), []);

  if (message === null) return null;

  // Like the other stacked notices, mount without motion and remove immediately on recovery.
  return (
    <ComposerStackedPanel>
      <div
        role="status"
        className="squircle flex items-center gap-3 rounded-[inherit] bg-info/8 px-5 py-3 text-ui-sm text-muted-foreground sm:px-6"
      >
        <CircleAlertIcon className="size-3.5 shrink-0 text-info" aria-hidden />
        <span>{message}</span>
      </div>
    </ComposerStackedPanel>
  );
}
