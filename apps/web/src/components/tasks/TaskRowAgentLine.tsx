// FILE: TaskRowAgentLine.tsx
// Purpose: The second line of a delegated task row — provider icon, model, where the agent
//          works, and what it is doing.
// Layer: Tasks UI component
// Exports: TaskRowAgentLine

import { formatModelDisplayName } from "@synara/shared/model";

import { ProviderIcon } from "~/components/ProviderIcon";
import type { SidebarThreadSummary } from "../../types";

export function TaskRowAgentLine({
  thread,
  location,
  activity,
}: {
  thread: SidebarThreadSummary;
  /** Folder or project the agent works in, when known. */
  location: string | null;
  /** What it is doing right now ("Working · 4m"), when it says something. */
  activity: string | null;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-ui-sm text-muted-foreground">
      <ProviderIcon provider={thread.modelSelection.provider} className="size-3 shrink-0" />
      <span className="shrink-0 text-foreground/80">
        {formatModelDisplayName(thread.modelSelection.model) ?? thread.modelSelection.model}
      </span>
      {location ? (
        <>
          <span className="shrink-0">in</span>
          <span className="min-w-0 shrink truncate font-mono text-ui-xs text-foreground/70">
            {location}
          </span>
        </>
      ) : null}
      {activity ? (
        <>
          <span className="shrink-0">·</span>
          <span className="min-w-0 truncate">{activity}</span>
        </>
      ) : null}
    </div>
  );
}
