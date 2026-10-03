// FILE: PullRequestRow.tsx
// Purpose: One row of the code review list, for a pull request or an issue, in two lines: the
//          title (up to two lines, full title on hover), then a kind/state glyph, the author (the
//          same label as the detail header), the relative time, and the number muted at the
//          end. A sibling pin control never opens the detail.
// Layer: Pull request presentation
// Exports: PullRequestRow, githubInboxItemLabel

import type { GitHubInboxItem, GitHubInboxSort } from "@synara/contracts";
import { pullRequestListProjectContexts } from "@synara/shared/githubRepository";
import type { ReactNode } from "react";

import { PinStatusIcon, pinActionLabel } from "~/lib/pin";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import { SIDEBAR_ROW_HOVER_CLASS_NAME } from "~/sidebarRowStyles";
import {
  PR_BODY_TEXT_CLASS_NAME,
  PR_FINE_TEXT_CLASS_NAME,
  PR_QUIET_INK_CLASS_NAME,
} from "./pullRequestText";
import { PullRequestActorLabel } from "./PullRequestActorLabel";
import { GitHubItemStateGlyph } from "./PullRequestStateGlyph";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/** How a row names its item in accessible labels: "pull request #42", "issue #7". */
export function githubInboxItemLabel(item: Pick<GitHubInboxItem, "kind" | "number">): string {
  return `${item.kind === "issue" ? "issue" : "pull request"} #${item.number}`;
}

export const PullRequestRow = function PullRequestRow({
  entry,
  sort = "created",
  selected,
  showProjectTitle: showProjectTitleProp,
  projectIcon,
  onClick,
  onTogglePinned,
}: {
  entry: GitHubInboxItem;
  sort?: GitHubInboxSort;
  selected: boolean;
  /** Several projects in view: adds the preferred local context to the second line. */
  showProjectTitle?: boolean;
  /** The preferred project's glyph, shown before its name when the project title is shown. */
  projectIcon?: ReactNode;
  onClick: (entry: GitHubInboxItem) => void;
  onTogglePinned: (entry: GitHubInboxItem) => void;
}) {
  const showProjectTitle = showProjectTitleProp ?? false;
  const timestamp = sort === "created" ? entry.createdAt : entry.updatedAt;
  const isPinned = entry.isPinned === true;
  const projectContexts = pullRequestListProjectContexts(entry);
  const projectLabel =
    projectContexts.length > 1 ? `${projectContexts.length} projects` : entry.projectTitle;
  const projectTitle = projectContexts.map((context) => context.projectTitle).join(", ");
  const itemLabel = githubInboxItemLabel(entry);
  const pinLabel = pinActionLabel(
    showProjectTitle ? `${itemLabel} in ${projectLabel}` : itemLabel,
    isPinned,
  );
  return (
    <div
      className={cn(
        // The list bleeds past the column padding and this padding pays it back, so the hover
        // surface keeps a halo while the title still sits on the filter bar's vertical.
        "group flex w-full items-stretch rounded-lg text-left transition-colors",
        selected
          ? "bg-[color-mix(in_srgb,var(--color-text-foreground)_7%,transparent)]"
          : cn(SIDEBAR_ROW_HOVER_CLASS_NAME, "focus-within:bg-[var(--sidebar-accent)]"),
      )}
    >
      <button
        type="button"
        data-pull-request-row
        data-item-kind={entry.kind}
        data-project-id={entry.projectId}
        data-repository={entry.repository}
        data-pull-request-number={entry.number}
        aria-current={selected ? "true" : undefined}
        title={`${entry.title} #${entry.number}`}
        onClick={() => onClick(entry)}
        className="flex min-w-0 flex-1 flex-col gap-1 rounded-lg py-2 pl-3 pr-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span
          className={cn(
            PR_BODY_TEXT_CLASS_NAME,
            "line-clamp-2 min-w-0 break-words font-medium leading-snug text-foreground",
          )}
        >
          {entry.title}
        </span>
        <span
          className={cn(
            PR_FINE_TEXT_CLASS_NAME,
            PR_QUIET_INK_CLASS_NAME,
            "flex min-w-0 items-center gap-1.5",
          )}
        >
          <GitHubItemStateGlyph item={entry} size="sm" className="size-3.5" />
          {showProjectTitle ? (
            <span
              className="flex min-w-0 max-w-[6rem] shrink-0 items-center gap-1"
              title={projectTitle}
            >
              {projectIcon}
              <span className="truncate">{projectLabel}</span>
            </span>
          ) : null}
          <PullRequestActorLabel actor={entry.author} />
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <time
            dateTime={timestamp}
            title={sort === "created" ? "Opened" : "Updated"}
            className="shrink-0 tabular-nums"
          >
            {formatRelativeTime(timestamp)}
          </time>
          <span className="ml-auto shrink-0 pl-1 tabular-nums opacity-80">#{entry.number}</span>
        </span>
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={pinLabel}
              aria-pressed={entry.isPinned}
              onClick={() => onTogglePinned(entry)}
              className={cn(
                "mt-1 mr-1 inline-flex size-7 shrink-0 self-start items-center justify-center rounded-md text-muted-foreground transition-[color,opacity] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                isPinned
                  ? "text-foreground opacity-100"
                  : "opacity-70 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100",
              )}
            >
              <PinStatusIcon pinned={isPinned} className="size-3.5" aria-hidden />
            </button>
          }
        />
        <TooltipPopup side="top">{pinLabel}</TooltipPopup>
      </Tooltip>
    </div>
  );
};
