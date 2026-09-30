// FILE: PullRequestRow.tsx
// Purpose: One row of the code review list, for a pull request or an issue, in three short
//          lines: state glyph + "PR · #n" / "Issue · #n" + relative time; the truncating title
//          (full title in a tooltip); then author or project, label chips, and the
//          diff stat (pull requests) or comment count (issues). A sibling pin control never
//          opens the detail.
// Layer: Pull request presentation
// Exports: PullRequestRow

import type { GitHubInboxItem } from "@synara/contracts";
import { pullRequestListProjectContexts } from "@synara/shared/githubRepository";
import type { ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ChatBubbleIcon } from "~/lib/icons";
import { PinStatusIcon, pinActionLabel } from "~/lib/pin";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import { GitHubLabelChips } from "./GitHubLabelChips";
import {
  PR_BODY_TEXT_CLASS_NAME,
  PR_FINE_TEXT_CLASS_NAME,
  PR_META_TEXT_CLASS_NAME,
  PR_QUIET_INK_CLASS_NAME,
} from "./pullRequestText";
import { PullRequestAvatar } from "./PullRequestAvatar";
import { PullRequestDiffStat } from "./PullRequestDiffStat";
import { GitHubItemStateGlyph } from "./PullRequestStateGlyph";
import { PullRequestStackPosition } from "./PullRequestStackPosition";

/** Rows show at most this many label chips; the rest collapse into "+N". */
const ROW_LABEL_LIMIT = 2;

function TruncatedTitle({ title, number }: { title: string; number: number }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              PR_BODY_TEXT_CLASS_NAME,
              "min-w-0 flex-1 truncate font-medium text-foreground",
            )}
          >
            {title}
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
        <p className={cn(PR_META_TEXT_CLASS_NAME)}>
          {title} <span className="text-muted-foreground">#{number}</span>
        </p>
      </TooltipPopup>
    </Tooltip>
  );
}

/** How a row names its item in accessible labels: "pull request #42", "issue #7". */
export function githubInboxItemLabel(item: Pick<GitHubInboxItem, "kind" | "number">): string {
  return `${item.kind === "issue" ? "issue" : "pull request"} #${item.number}`;
}

export const PullRequestRow = function PullRequestRow({
  entry,
  selected,
  showProjectTitle: showProjectTitleProp,
  projectIcon,
  showDiffColors: showDiffColorsProp,
  onClick,
  onTogglePinned,
}: {
  entry: GitHubInboxItem;
  selected: boolean;
  /** Several projects in view: identifies the preferred local context used to open the item. */
  showProjectTitle?: boolean;
  /** The preferred project's glyph, shown before its name when the project title is shown. */
  projectIcon?: ReactNode;
  showDiffColors?: boolean;
  onClick: (entry: GitHubInboxItem) => void;
  onTogglePinned: (entry: GitHubInboxItem) => void;
}) {
  const showProjectTitle = showProjectTitleProp ?? false;
  const showDiffColors = showDiffColorsProp ?? true;
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
        // The row bleeds past the column padding and pays the same amount back as its own
        // padding, so the hover surface keeps a halo while the glyph and the title still sit
        // on the filter bar's verticals. The width is explicit because the negative margin
        // shifts the row without widening it.
        "group -mx-3 flex w-[calc(100%+1.5rem)] items-stretch rounded-lg text-left transition-colors",
        selected
          ? "bg-[var(--color-background-elevated-secondary)]"
          : "hover:bg-[var(--color-background-elevated-secondary)]/70 focus-within:bg-[var(--color-background-elevated-secondary)]/70",
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
        onClick={() => onClick(entry)}
        className="flex min-w-0 flex-1 flex-col gap-1 rounded-lg py-2.5 pl-3 pr-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {/* Three short lines, because the column is narrow: what it is and when, the title on a
            line of its own, then where it lives and its labels. */}
        <span
          className={cn(
            PR_FINE_TEXT_CLASS_NAME,
            PR_QUIET_INK_CLASS_NAME,
            "flex min-w-0 items-center gap-1.5",
          )}
        >
          <GitHubItemStateGlyph item={entry} size="sm" />
          <span className="shrink-0 tabular-nums">
            {entry.kind === "issue" ? "Issue" : "PR"} · #{entry.number}
          </span>
          {entry.kind === "pullRequest" && entry.stack ? (
            <PullRequestStackPosition stack={entry.stack} />
          ) : null}
          <span className="ml-auto shrink-0 tabular-nums">
            {formatRelativeTime(entry.updatedAt)}
          </span>
        </span>
        <span className="flex min-w-0">
          <TruncatedTitle title={entry.title} number={entry.number} />
        </span>
        <span
          className={cn(
            PR_FINE_TEXT_CLASS_NAME,
            PR_QUIET_INK_CLASS_NAME,
            "flex min-w-0 items-center gap-1.5",
          )}
        >
          {/* With several projects in view the line leads with the project; otherwise with the
              author. The repository is in the detail, not repeated on every row. */}
          {showProjectTitle ? (
            <span
              className="flex min-w-0 max-w-[10rem] shrink items-center gap-1"
              title={projectTitle}
            >
              {projectIcon}
              <span className="truncate">{projectLabel}</span>
            </span>
          ) : (
            <PullRequestAvatar actor={entry.author} size="sm" className="shrink-0" />
          )}
          <GitHubLabelChips
            labels={entry.labels}
            limit={ROW_LABEL_LIMIT}
            className="min-w-0 shrink overflow-hidden"
          />
          <span className="ml-auto flex shrink-0 items-center pl-1 tabular-nums">
            {entry.kind === "pullRequest" ? (
              <PullRequestDiffStat
                additions={entry.additions}
                deletions={entry.deletions}
                tone={showDiffColors ? "diff" : "muted"}
              />
            ) : entry.commentCount > 0 ? (
              <span
                className="inline-flex items-center gap-1"
                title={`${entry.commentCount} ${entry.commentCount === 1 ? "comment" : "comments"}`}
              >
                <ChatBubbleIcon className="size-3" aria-hidden />
                {entry.commentCount}
              </span>
            ) : null}
          </span>
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
                "my-auto mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[color,opacity] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
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
