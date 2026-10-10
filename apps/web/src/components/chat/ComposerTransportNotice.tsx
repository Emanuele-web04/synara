import { useEffect, useState } from "react";

import { StatusChip } from "~/components/ui/status-chip";
import { subscribeComposerTransportStatus } from "~/lib/composerTransportStatus";
import { ComposerStackedPanel } from "./ComposerStackedPanel";
import { ComposerStackedPanelRow } from "./ComposerStackedPanelContent";

/** Transport presentation stays local; it must not become a transcript activity signal. */
export function ComposerTransportNotice() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => subscribeComposerTransportStatus(setMessage), []);

  if (message === null) return null;

  // Like the other stacked notices, mount without motion and remove immediately on recovery.
  return (
    <ComposerStackedPanel>
      <ComposerStackedPanelRow role="status">
        <StatusChip dotClassName="bg-amber-500" className="text-muted-foreground">
          {message}
        </StatusChip>
      </ComposerStackedPanelRow>
    </ComposerStackedPanel>
  );
}
