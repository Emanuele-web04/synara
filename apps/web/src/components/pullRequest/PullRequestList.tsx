// FILE: PullRequestList.tsx
// Purpose: The pull requests list body — renders entries as PullRequestRows, either flat or
//          under the involvement group headers produced by groupPullRequestEntriesByInvolvement
//          (the "All" tab). Rows use repository + number identity because the global list has
//          one row per remote PR; selection still retains project context for the detail panel.
// Layer: Pull request presentation
// Exports: PullRequestList

import type { ProjectId, PullRequestListEntry } from "@synara/contracts";
import {
  pullRequestListEntryKey,
  type PullRequestListGroup,
  type PullRequestWorkspaceAssociation,
} from "./pullRequestList.logic";
import { PullRequestRow } from "./PullRequestRow";
import {
  derivePullRequestRowContextMenuActions,
  type PullRequestRowContextMenuActionId,
} from "./PullRequestRowContextMenu";
import { PR_FINE_TEXT_CLASS_NAME, PR_QUIET_INK_CLASS_NAME } from "./pullRequestText";
import { cn } from "~/lib/utils";

export const PullRequestList = function PullRequestList({
  entries,
  grouped,
  selectedProjectId,
  selectedRepo,
  selectedNumber,
  showProjectTitle = false,
  workspaceAssociationByEntryKey,
  canArchiveWorkspaceByEntryKey,
  onSelect,
  onTogglePinned,
  onContextMenuAction,
}: {
  entries: PullRequestListEntry[];
  grouped: PullRequestListGroup[] | null;
  selectedProjectId: ProjectId | undefined;
  selectedRepo: string | undefined;
  selectedNumber: number | undefined;
  showProjectTitle?: boolean;
  workspaceAssociationByEntryKey?: Readonly<Record<string, PullRequestWorkspaceAssociation>>;
  canArchiveWorkspaceByEntryKey?: Readonly<Record<string, boolean>>;
  onSelect: (entry: PullRequestListEntry) => void;
  onTogglePinned: (entry: PullRequestListEntry) => void;
  onContextMenuAction?: (
    actionId: PullRequestRowContextMenuActionId,
    entry: PullRequestListEntry,
  ) => void;
}) {
  const renderEntry = (entry: PullRequestListEntry) => {
    const entryKey = pullRequestListEntryKey(entry);
    const workspaceAssociation = workspaceAssociationByEntryKey?.[entryKey] ?? null;
    return (
      <PullRequestRow
        key={entryKey}
        entry={entry}
        showProjectTitle={showProjectTitle}
        selected={
          selectedProjectId === entry.projectId &&
          selectedRepo === entry.repository &&
          selectedNumber === entry.number
        }
        workspaceAssociation={workspaceAssociation}
        contextMenuActions={derivePullRequestRowContextMenuActions({
          entry,
          association: workspaceAssociation,
          canArchiveAssociatedWorkspace: canArchiveWorkspaceByEntryKey?.[entryKey] === true,
        })}
        onClick={onSelect}
        onTogglePinned={onTogglePinned}
        {...(onContextMenuAction ? { onContextMenuAction } : {})}
      />
    );
  };
  if (grouped) {
    return (
      <div className="space-y-0.5">
        {grouped.flatMap((group, groupIndex) => [
          // Keep headers and keyed rows as direct siblings. When a pin moves a row between
          // groups, React can move the same DOM node instead of remounting it and losing focus.
          <h2
            key={`group:${group.key}`}
            className={cn(
              PR_FINE_TEXT_CLASS_NAME,
              PR_QUIET_INK_CLASS_NAME,
              "pb-0.5 font-medium",
              groupIndex > 0 && "pt-2.5",
            )}
          >
            {group.label}
          </h2>,
          ...group.entries.map(renderEntry),
        ])}
      </div>
    );
  }
  return <div className="space-y-0.5">{entries.map(renderEntry)}</div>;
};
