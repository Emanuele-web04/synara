// FILE: GitHubItemHeader.tsx
// Purpose: The header a GitHub item's detail opens with, the same for pull requests and issues:
//          state glyph, "PR #n" / "Issue #n", state word and repository; the title; author,
//          assignees, created and updated; labels; then the action row. Hosts that show the
//          detail as a page use it (the inbox); the chat dock keeps its compact header.
// Layer: Pull request presentation
// Exports: GitHubItemHeader, GitHubItemHeaderItem, GitHubItemBackButton

import type {
  GitHubIssueDetail,
  GitPullRequestMergeability,
  PullRequestActor,
  PullRequestDetail,
} from "@synara/contracts";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { IconButton } from "~/components/ui/icon-button";
import { ArrowLeftIcon, ExternalLinkIcon } from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { GitHubLabelChips } from "./GitHubLabelChips";
import { PullRequestActorLabel } from "./PullRequestActorLabel";
import { PullRequestMetaLine } from "./PullRequestMetaLine";
import {
  IssueStateGlyph,
  PullRequestStateGlyph,
  pullRequestStateLabel,
} from "./PullRequestStateGlyph";
import {
  resolveIssueStatePresentation,
  resolvePrStatePresentation,
} from "./pullRequestStatePresentation";
import { PR_FINE_TEXT_CLASS_NAME, PR_META_TEXT_CLASS_NAME } from "./pullRequestText";

type HeaderFields =
  | "number"
  | "repository"
  | "url"
  | "title"
  | "author"
  | "createdAt"
  | "updatedAt"
  | "labels";

/** What the header shows, from either detail. Pull request detail carries no assignees. */
export type GitHubItemHeaderItem =
  | ({ kind: "pullRequest"; mergeability?: GitPullRequestMergeability | undefined } & Pick<
      PullRequestDetail,
      HeaderFields | "state" | "isDraft"
    >)
  | ({ kind: "issue" } & Pick<
      GitHubIssueDetail,
      HeaderFields | "state" | "stateReason" | "assignees"
    >);

function relativeTimeAgo(iso: string): string {
  const relative = formatRelativeTime(iso);
  return relative === "now" ? "just now" : `${relative} ago`;
}

function AssigneesSegment({ assignees }: { assignees: ReadonlyArray<PullRequestActor> }) {
  if (assignees.length === 0) return <span>Unassigned</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0">Assigned to</span>
      {assignees.map((assignee) => (
        <PullRequestActorLabel key={assignee.login} actor={assignee} className="max-w-[10rem]" />
      ))}
    </span>
  );
}

/** Returns a narrow layout from the detail to the list. Also shown while the detail loads. */
export function GitHubItemBackButton({
  onBack,
  className,
}: {
  onBack: () => void;
  className?: string;
}) {
  return (
    <IconButton
      variant="chrome"
      label="Back to code review"
      tooltip="Back"
      className={cn("shrink-0", className)}
      onClick={onBack}
    >
      <ArrowLeftIcon />
    </IconButton>
  );
}

export function GitHubItemHeader({
  item,
  onBack,
  agentActions,
  className,
}: {
  item: GitHubItemHeaderItem;
  /** Narrow layouts show the detail in place of the list; this returns to it. */
  onBack?: () => void;
  /** Agent actions for this item (Send to agent, Ask), placed ahead of Open on GitHub. */
  agentActions?: ReactNode;
  className?: string;
}) {
  const state =
    item.kind === "pullRequest"
      ? {
          word: pullRequestStateLabel(item.state, item.isDraft, item.mergeability),
          colorClass: resolvePrStatePresentation(item).colorClass,
          glyph: (
            <PullRequestStateGlyph
              state={item.state}
              isDraft={item.isDraft}
              mergeability={item.mergeability}
            />
          ),
        }
      : {
          word: resolveIssueStatePresentation(item).shortLabel,
          colorClass: resolveIssueStatePresentation(item).colorClass,
          glyph: <IssueStateGlyph state={item.state} stateReason={item.stateReason} />,
        };
  const kindLabel = item.kind === "pullRequest" ? "PR" : "Issue";
  return (
    <header className={cn("shrink-0 px-5 pt-4 pb-3", className)}>
      <div className="flex min-w-0 items-center gap-2">
        {onBack ? <GitHubItemBackButton onBack={onBack} className="-ml-1.5" /> : null}
        <PullRequestMetaLine className={cn(PR_FINE_TEXT_CLASS_NAME, "text-muted-foreground")}>
          <span className="flex shrink-0 items-center gap-1.5 text-foreground">
            {state.glyph}
            <span className="tabular-nums">
              {kindLabel} #{item.number}
            </span>
          </span>
          <span className={cn("shrink-0", state.colorClass)}>{state.word}</span>
          <span className="truncate" title={item.repository}>
            {item.repository}
          </span>
        </PullRequestMetaLine>
      </div>
      {/* Large heading: one of the two places a fixed size is allowed. */}
      <h1 className="mt-1.5 text-lg font-semibold leading-snug break-words">{item.title}</h1>
      <PullRequestMetaLine
        className={cn(PR_META_TEXT_CLASS_NAME, "mt-1.5 flex-wrap text-muted-foreground")}
      >
        <PullRequestActorLabel actor={item.author} className="font-medium text-foreground" />
        {item.kind === "issue" ? <AssigneesSegment assignees={item.assignees} /> : null}
        <span title={new Date(item.createdAt).toLocaleString()}>
          Created {relativeTimeAgo(item.createdAt)}
        </span>
        <span title={new Date(item.updatedAt).toLocaleString()}>
          Updated {relativeTimeAgo(item.updatedAt)}
        </span>
      </PullRequestMetaLine>
      {item.labels.length > 0 ? (
        <GitHubLabelChips labels={item.labels} className="mt-2 flex-wrap" />
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {agentActions}
        <Button
          variant="ghost"
          size="sm"
          className={cn(agentActions ? undefined : "-ml-2.5")}
          onClick={() => void ensureNativeApi().shell.openExternal(item.url)}
        >
          <ExternalLinkIcon />
          Open on GitHub
        </Button>
      </div>
    </header>
  );
}
