// FILE: GitHubItemHeader.tsx
// Purpose: The header a GitHub item's detail opens with, the same for pull requests and issues:
//          a state pill (its chevron opens the host's state menu) beside "repo #n"; the large
//          title; author, time, and (pull requests) head to base; then the labels. The actions
//          (and, on a narrow window, the back control) live in the page's top bar. Hosts that
//          show the detail as a page use it (the inbox); the chat dock keeps its compact header.
// Layer: Pull request presentation
// Exports: GitHubItemHeader, GitHubItemHeaderItem, GitHubItemBackButton

import type {
  GitHubIssueDetail,
  GitPullRequestMergeability,
  PullRequestDetail,
} from "@synara/contracts";
import type { ReactNode } from "react";

import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { IconButton } from "~/components/ui/icon-button";
import { Menu, MenuTrigger } from "~/components/ui/menu";
import { ArrowLeftIcon, ArrowRightIcon, ChevronDownIcon } from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
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
  | ({
      kind: "pullRequest";
      mergeability?: GitPullRequestMergeability | undefined;
    } & Pick<PullRequestDetail, HeaderFields | "state" | "isDraft" | "headBranch" | "baseBranch">)
  | ({ kind: "issue" } & Pick<
      GitHubIssueDetail,
      HeaderFields | "state" | "stateReason" | "assignees"
    >);

function relativeTimeAgo(iso: string): string {
  const relative = formatRelativeTime(iso);
  return relative === "now" ? "just now" : `${relative} ago`;
}

/** Returns a narrow layout from the detail to the list; leads the detail page's top bar. */
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
  stateMenu,
  className,
}: {
  item: GitHubItemHeaderItem;
  /** The entries of the state pill's menu (Draft / Ready for review). Absent: a plain pill. */
  stateMenu?: ReactNode;
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
              className="size-3.5"
            />
          ),
        }
      : {
          word: resolveIssueStatePresentation(item).shortLabel,
          colorClass: resolveIssueStatePresentation(item).colorClass,
          glyph: (
            <IssueStateGlyph
              state={item.state}
              stateReason={item.stateReason}
              className="size-3.5"
            />
          ),
        };
  const repositoryName = item.repository.split("/").pop() ?? item.repository;
  const pillClassName = cn(
    PR_META_TEXT_CLASS_NAME,
    "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 font-medium",
    "bg-[color-mix(in_srgb,currentColor_12%,transparent)]",
    state.colorClass,
  );
  const pillContent = (
    <>
      {state.glyph}
      <span>{state.word}</span>
    </>
  );
  return (
    <header className={cn("shrink-0 pb-4", className)}>
      <div className="flex min-w-0 items-center gap-2">
        {stateMenu ? (
          <Menu>
            <MenuTrigger
              aria-label={`State: ${state.word}. Change state`}
              className={cn(
                pillClassName,
                "cursor-pointer pr-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
            >
              {pillContent}
              <ChevronDownIcon aria-hidden className="size-3" />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="start" side="bottom" className="w-48 min-w-48">
              {stateMenu}
            </ComposerPickerMenuPopup>
          </Menu>
        ) : (
          <span className={pillClassName}>{pillContent}</span>
        )}
        <span
          className={cn(PR_META_TEXT_CLASS_NAME, "min-w-0 truncate text-muted-foreground")}
          title={item.repository}
        >
          {repositoryName} #{item.number}
        </span>
      </div>
      {/* Large heading: one of the two places a fixed size is allowed. */}
      <h1 className="mt-3 text-[1.75rem] leading-tight font-semibold tracking-tight break-words">
        {item.title}
      </h1>
      <PullRequestMetaLine
        className={cn(PR_META_TEXT_CLASS_NAME, "mt-3 flex-wrap text-muted-foreground")}
      >
        <PullRequestActorLabel actor={item.author} className="font-medium text-foreground" />
        <span title={new Date(item.createdAt).toLocaleString()}>
          {relativeTimeAgo(item.createdAt)}
        </span>
        {item.kind === "pullRequest" ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(PR_FINE_TEXT_CLASS_NAME, "min-w-0 truncate")}
              title={item.headBranch}
            >
              {item.headBranch}
            </span>
            <ArrowRightIcon aria-hidden className="size-3.5 shrink-0" />
            <span className={cn(PR_FINE_TEXT_CLASS_NAME, "shrink-0")}>{item.baseBranch}</span>
          </span>
        ) : null}
      </PullRequestMetaLine>
      {item.kind === "pullRequest" && item.labels.length > 0 ? (
        <GitHubLabelChips labels={item.labels} className="mt-3 flex-wrap" />
      ) : null}
    </header>
  );
}
