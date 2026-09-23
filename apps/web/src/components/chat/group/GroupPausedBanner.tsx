// FILE: GroupPausedBanner.tsx
// Purpose: Slim notice shown above the coordinator composer while its group is
//          paused; offers a one-click Resume that replays queued wakes server-side.
// Layer: Web component
// Exports: GroupPausedBanner

import type { ProjectId } from "@synara/contracts";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { PauseIcon } from "~/lib/icons";
import { Button } from "~/components/ui/button";

export function GroupPausedBanner(props: {
  readonly projectId: ProjectId;
  readonly onResume: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-2 rounded-md border border-[color:var(--color-border-light)]",
        "bg-[var(--sidebar-accent)]/40 px-3 py-2 text-ui text-muted-foreground",
      )}
    >
      <PauseIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">This group is paused.</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        className="h-6 shrink-0 px-2 text-ui"
        aria-label={`Resume group ${props.projectId}`}
        onClick={() => {
          setBusy(true);
          void props.onResume().finally(() => setBusy(false));
        }}
      >
        Resume
      </Button>
    </div>
  );
}
