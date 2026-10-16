import { useEffect, useState } from "react";

import { StatusDot } from "~/components/ui/status-chip";
import { subscribeComposerTransportStatus } from "~/lib/composerTransportStatus";
import { ComposerCapsule } from "./ComposerCapsule";

/** Transport presentation stays local; it must not become a transcript activity signal. */
export function ComposerTransportNotice() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => subscribeComposerTransportStatus(setMessage), []);

  if (message === null) return null;

  // Like the other capsules, mount without motion and remove immediately on recovery.
  return (
    <ComposerCapsule role="status" icon={<StatusDot aria-hidden className="bg-amber-500" />}>
      <span className="text-muted-foreground">{message}</span>
    </ComposerCapsule>
  );
}
