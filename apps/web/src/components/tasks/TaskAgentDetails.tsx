// FILE: TaskAgentDetails.tsx
// Purpose: The agent card in the task inspector — which model the delegated chat runs, where
//          it works, and a link to the chat itself — plus the short list of what it did last.
// Layer: Tasks UI component
// Exports: TaskAgentDetails, TaskAgentActivityList

import { PROVIDER_DISPLAY_NAMES } from "@synara/contracts";
import { formatModelDisplayName } from "@synara/shared/model";

import { ProviderIcon } from "~/components/ProviderIcon";
import { ArrowUpRightIcon, FolderIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { WorkLogEntry } from "../../session-logic";
import type { SidebarThreadSummary } from "../../types";
import {
  TASK_PROPERTY_ICON_CLASS,
  TaskPropertyRow,
  TaskSectionLabel,
} from "./TaskInspectorPrimitives";

export function TaskAgentDetails({
  summary,
  location,
  fullPath,
  onOpenChat,
}: {
  summary: SidebarThreadSummary;
  /** Short "where it runs" label (folder or project name). */
  location: string | null;
  /** The full directory, shown as the row's tooltip. */
  fullPath: string | null;
  onOpenChat: () => void;
}) {
  const provider = summary.modelSelection.provider;
  return (
    <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-2.5 rounded-xl border border-border px-3 py-2.5 text-ui">
      <TaskPropertyRow label="Model" className="flex min-w-0 items-center gap-1.5">
        <ProviderIcon provider={provider} className="size-3.5 shrink-0" />
        <span className="shrink-0 text-muted-foreground">{PROVIDER_DISPLAY_NAMES[provider]}</span>
        <span className="min-w-0 truncate">
          {formatModelDisplayName(summary.modelSelection.model) ?? summary.modelSelection.model}
        </span>
      </TaskPropertyRow>
      <TaskPropertyRow
        label="Runs in"
        className="flex min-w-0 items-center gap-1.5"
        title={fullPath ?? undefined}
      >
        <FolderIcon aria-hidden className={TASK_PROPERTY_ICON_CLASS} />
        <span className="min-w-0 truncate font-mono text-ui-sm">{location ?? "Unknown"}</span>
        {summary.envMode === "worktree" && summary.branch ? (
          <span className="min-w-0 truncate rounded-md bg-muted px-1.5 font-mono text-ui-xs text-muted-foreground">
            {summary.branch}
          </span>
        ) : null}
      </TaskPropertyRow>
      <TaskPropertyRow label="Chat" className="min-w-0">
        <button
          type="button"
          onClick={onOpenChat}
          className="flex max-w-full items-center gap-1 text-left text-foreground hover:underline"
        >
          <span className="min-w-0 truncate">{summary.title}</span>
          <ArrowUpRightIcon aria-hidden className="size-3.5 shrink-0 opacity-60" />
        </button>
      </TaskPropertyRow>
    </dl>
  );
}

/** What the agent did last, one line per tool call or step; a failing one gets a red dot. */
export function TaskAgentActivityList({ entries }: { entries: readonly WorkLogEntry[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <TaskSectionLabel>Activity</TaskSectionLabel>
      <ol className="flex flex-col gap-1">
        {entries.map((entry) => (
          <li key={entry.id} className="flex min-w-0 items-baseline gap-2 text-ui-sm">
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 translate-y-[-1px] rounded-full",
                entry.tone === "error" ? "bg-status-failure" : "bg-muted-foreground/50",
              )}
            />
            <span className="shrink-0 text-foreground/85">{entry.toolTitle ?? entry.label}</span>
            {(entry.command ?? entry.detail) ? (
              <span className="min-w-0 truncate font-mono text-ui-xs text-muted-foreground">
                {entry.command ?? entry.detail}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
