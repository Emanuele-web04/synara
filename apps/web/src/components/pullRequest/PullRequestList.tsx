// FILE: PullRequestList.tsx
// Purpose: The GitHub inbox list body — renders pull request and issue rows, either flat or
//          under the involvement group headers produced by groupPullRequestEntriesByInvolvement
//          (the Everything view). Rows use repository + number identity because the list has
//          one row per remote item; selection still retains project context for the detail.
// Layer: Pull request presentation
// Exports: PullRequestList

import type { GitHubInboxItem, ProjectId } from "@synara/contracts";
import type { ReactNode } from "react";

import { pullRequestListEntryKey, type PullRequestListGroup } from "./pullRequestList.logic";
import { PullRequestRow } from "./PullRequestRow";
import { PR_FINE_TEXT_CLASS_NAME, PR_QUIET_INK_CLASS_NAME } from "./pullRequestText";
import { cn } from "~/lib/utils";

export const PullRequestList = function PullRequestList({
  entries,
  grouped,
  isSelected,
  showProjectTitle: showProjectTitleProp,
  projectIconFor,
  showDiffColors: showDiffColorsProp,
  onSelect,
  onTogglePinned,
}: {
  entries: GitHubInboxItem[];
  grouped: PullRequestListGroup[] | null;
  isSelected: (entry: GitHubInboxItem) => boolean;
  showProjectTitle?: boolean;
  projectIconFor?: (projectId: ProjectId) => ReactNode;
  showDiffColors?: boolean;
  onSelect: (entry: GitHubInboxItem) => void;
  onTogglePinned: (entry: GitHubInboxItem) => void;
}) {
  const showProjectTitle = showProjectTitleProp ?? false;
  const showDiffColors = showDiffColorsProp ?? true;
  const renderEntry = (entry: GitHubInboxItem) => (
    <PullRequestRow
      key={pullRequestListEntryKey(entry)}
      entry={entry}
      showProjectTitle={showProjectTitle}
      {...(showProjectTitle && projectIconFor
        ? { projectIcon: projectIconFor(entry.projectId) }
        : {})}
      showDiffColors={showDiffColors}
      selected={isSelected(entry)}
      onClick={onSelect}
      onTogglePinned={onTogglePinned}
    />
  );
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
