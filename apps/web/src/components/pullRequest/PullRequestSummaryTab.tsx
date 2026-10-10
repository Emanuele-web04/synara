// FILE: PullRequestSummaryTab.tsx
// Purpose: The Summary tab of the pull request detail surface — title + author line (unless the
//          host shows a GitHubItemHeader), plain meta rows (branch, reviewers, comments, checks),
//          and the Description / Checks / Comments disclosure sections. Presentation over an
//          already-loaded detail plus the comment mutation; the detail query, actions, and tab
//          switching stay in PullRequestDetailPanel.
// Layer: Pull request presentation
// Exports: PullRequestSummaryTab, PullRequestPageSummary, GitHubItemPageSummary, GitHubItemComments

import type { PullRequestComment, PullRequestDetail } from "@synara/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";

import {
  PULL_REQUEST_CHECK_STATUS_LABELS,
  summarizePullRequestChecks,
  summarizePullRequestComments,
  withStableCheckKeys,
} from "~/components/chat/environment/environmentPullRequest.logic";
import { ChatBubbleIcon, GitBranchIcon, UsersIcon } from "~/lib/icons";
import { pullRequestCommentMutationOptions } from "~/lib/pullRequestReactQuery";
import { formatRelativeTime } from "~/lib/relativeTime";
import { ensureNativeApi } from "~/nativeApi";
import { describePullRequestState } from "./pullRequestDetail.logic";
import { PullRequestActorLabel } from "./PullRequestActorLabel";
import { PullRequestCheckStatusIcon } from "./PullRequestCheckStatusIcon";
import { PullRequestConflictIcon } from "./pullRequestStatePresentation";
import { PullRequestMetaLine } from "./PullRequestMetaLine";
import { PullRequestMetaRow } from "./PullRequestMetaRow";
import { PullRequestChecksRing } from "./PullRequestChecksRing";
import { PullRequestCommentCard } from "./PullRequestCommentCard";
import {
  PullRequestCommentComposer,
  type GitHubCommentMutation,
  type GitHubCommentTarget,
} from "./PullRequestCommentComposer";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestDiffStat } from "./PullRequestDiffStat";
import { PullRequestDisclosureSection } from "./PullRequestDisclosureSection";
import { PullRequestWarningNote } from "./PullRequestWarningNote";
import {
  PR_BODY_TEXT_CLASS_NAME,
  PR_FINE_TEXT_CLASS_NAME,
  PR_META_TEXT_CLASS_NAME,
} from "./pullRequestText";
import { cn } from "~/lib/utils";

/** A branch name in the Branch meta row (head and base render identically). Plain text at the
 *  row's own size — no chip, no width cap: it gives up characters only once the row genuinely
 *  runs out of room, and then shrinks proportionally, so the long head branch yields before a
 *  short base like `main`. The title carries the full name for the truncated case. */
function BranchName({ name }: { name: string }) {
  return (
    <span className="min-w-0 truncate" title={name}>
      {name}
    </span>
  );
}

/**
 * The Summary body on the code review page, the same for pull requests and issues: the
 * description as plain markdown, then the comments. The facts (branch, reviewers, checks,
 * assignees) are the page's info column instead.
 */
export function GitHubItemPageSummary({
  body,
  workspaceRoot,
  commentCount,
  children,
}: {
  body: string;
  workspaceRoot: string;
  commentCount: number;
  /** The comments section's content, usually a GitHubItemComments. */
  children: ReactNode;
}) {
  return (
    <div>
      <PullRequestMarkdown text={body} fallback="_No description provided._" cwd={workspaceRoot} />
      <div className="mt-6">
        <PullRequestDisclosureSection flush label="Comments" count={commentCount}>
          {children}
        </PullRequestDisclosureSection>
      </div>
    </div>
  );
}

/** A GitHub item's comments, oldest first (the last two open), then the comment composer. */
export function GitHubItemComments({
  comments,
  itemUrl,
  workspaceRoot,
  warning,
  target,
  mutation,
}: {
  comments: ReadonlyArray<PullRequestComment>;
  itemUrl: string;
  workspaceRoot: string;
  /** Why some comments are missing, when they are. */
  warning: string | null;
  target: GitHubCommentTarget;
  mutation: GitHubCommentMutation;
}) {
  return (
    <div className="space-y-2">
      {warning ? <PullRequestWarningNote>{warning}</PullRequestWarningNote> : null}
      {comments.length === 0 ? (
        <p className={cn(PR_BODY_TEXT_CLASS_NAME, "py-4 text-center text-muted-foreground")}>
          No comments
        </p>
      ) : (
        <div>
          {comments.map((comment, index) => (
            <PullRequestCommentCard
              key={comment.id}
              comment={comment}
              prUrl={itemUrl}
              workspaceRoot={workspaceRoot}
              defaultOpen={index >= comments.length - 2}
            />
          ))}
        </div>
      )}
      <PullRequestCommentComposer target={target} mutation={mutation} />
    </div>
  );
}

function PullRequestComments({ detail }: { detail: PullRequestDetail }) {
  const commentMutation = usePullRequestCommentMutation();
  return (
    <GitHubItemComments
      comments={detail.comments}
      itemUrl={detail.url}
      workspaceRoot={detail.workspaceRoot}
      warning={
        detail.commentsIncomplete
          ? "Some unresolved review comments could not be loaded. Check GitHub for the complete review."
          : detail.commentsTruncated
            ? "More unresolved review comments may be available on GitHub."
            : null
      }
      target={detail}
      mutation={commentMutation}
    />
  );
}

/** The pull request's Summary body on the code review page. */
export function PullRequestPageSummary({ detail }: { detail: PullRequestDetail }) {
  return (
    <GitHubItemPageSummary
      body={detail.body}
      workspaceRoot={detail.workspaceRoot}
      commentCount={detail.comments.length}
    >
      <PullRequestComments detail={detail} />
    </GitHubItemPageSummary>
  );
}

function usePullRequestCommentMutation() {
  const queryClient = useQueryClient();
  return useMutation(pullRequestCommentMutationOptions(queryClient));
}

export function PullRequestSummaryTab({
  detail,
  showHeading: showHeadingProp,
}: {
  detail: PullRequestDetail;
  /** The title and author line. Off when the host already shows them in a GitHubItemHeader. */
  showHeading?: boolean;
}) {
  const showHeading = showHeadingProp ?? true;
  return (
    <div className="h-full overflow-y-auto">
      <section className={cn("space-y-4 px-5", showHeading ? "py-5" : "py-3")}>
        {showHeading ? (
          <div className="min-w-0">
            <h1 className="text-lg font-semibold leading-snug">{detail.title}</h1>
            {/* Muted line, with the author the one thing lifted out of it. */}
            <PullRequestMetaLine
              className={cn(PR_META_TEXT_CLASS_NAME, "mt-1.5 flex-wrap text-muted-foreground")}
            >
              <PullRequestActorLabel
                actor={detail.author}
                className="font-medium text-foreground"
              />
              <span>{formatRelativeTime(detail.updatedAt)}</span>
              <span>{describePullRequestState(detail.state, detail.isDraft)}</span>
            </PullRequestMetaLine>
          </div>
        ) : null}
        <div>
          <PullRequestMetaRow icon={<GitBranchIcon className="size-4" />} label="Branch">
            {/* One line: the branch names absorb every pixel the row has spare, and only the
                separator and the counts are pinned. */}
            <span className="flex min-w-0 items-center gap-1.5">
              <BranchName name={detail.headBranch} />
              <span className="shrink-0 text-muted-foreground">›</span>
              <BranchName name={detail.baseBranch} />
              <PullRequestDiffStat
                additions={detail.additions}
                deletions={detail.deletions}
                tone="diff"
                className="ml-1 shrink-0"
              />
            </span>
          </PullRequestMetaRow>
          {/* Conflicts are a merge signal, not a state: git keeps draft/open orthogonal to
              mergeability. Red stays on the glyph only — the row text reads like the other
              meta rows, and the call to action lives in the header (a disabled Merge pill
              that says why, plus "Resolve conflicts" in its "…" menu). */}
          {detail.state === "open" && detail.mergeability === "conflicting" ? (
            <PullRequestMetaRow icon={<PullRequestConflictIcon className="size-4" />} label="Merge">
              Conflicts with {detail.baseBranch}
            </PullRequestMetaRow>
          ) : null}
          <PullRequestMetaRow icon={<UsersIcon className="size-4" />} label="Reviewers">
            {detail.reviewers.length === 0 ? (
              <span className="text-muted-foreground">None</span>
            ) : (
              <span className="flex flex-wrap items-center gap-1.5">
                {detail.reviewers.map((actor) => (
                  <PullRequestActorLabel
                    key={actor.login}
                    actor={actor}
                    className={cn(PR_FINE_TEXT_CLASS_NAME, "max-w-[8rem]")}
                  />
                ))}
              </span>
            )}
          </PullRequestMetaRow>
          <PullRequestMetaRow icon={<ChatBubbleIcon className="size-4" />} label="Comments">
            {summarizePullRequestComments(detail.comments.length)}
          </PullRequestMetaRow>
          {/* Tone tinting intentionally omitted: the summary reads as plain metadata
              here, matching the muted meta rows around it. */}
          <PullRequestMetaRow
            icon={<PullRequestChecksRing checks={detail.checks} />}
            label="Checks"
          >
            {summarizePullRequestChecks(detail.checks).label}
          </PullRequestMetaRow>
        </div>
      </section>
      {/* No edit pencil here: there is no backend "edit PR description" action to back it. */}
      <PullRequestDisclosureSection label="Description">
        <PullRequestMarkdown
          text={detail.body}
          fallback="_No description provided._"
          cwd={detail.workspaceRoot}
        />
      </PullRequestDisclosureSection>
      <PullRequestDisclosureSection label="Checks" count={detail.checks.length}>
        <div className="space-y-1">
          {detail.checks.length === 0 ? (
            <p className={cn(PR_META_TEXT_CLASS_NAME, "text-muted-foreground")}>
              No checks reported.
            </p>
          ) : (
            withStableCheckKeys(detail.checks).map(({ key, check }) => (
              <button
                key={key}
                type="button"
                disabled={!check.url}
                onClick={() => check.url && void ensureNativeApi().shell.openExternal(check.url)}
                className={cn(
                  PR_META_TEXT_CLASS_NAME,
                  // the row bleeds past the panel padding and pays it back as its own padding; width explicit because a button sizes to fit-content
                  "-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/50 disabled:hover:bg-transparent",
                )}
              >
                <PullRequestCheckStatusIcon status={check.status} />
                <span className="min-w-0 flex-1 truncate">{check.name}</span>
                <span className="text-muted-foreground">
                  {PULL_REQUEST_CHECK_STATUS_LABELS[check.status]}
                </span>
              </button>
            ))
          )}
        </div>
      </PullRequestDisclosureSection>
      {/* Open by default so the comment composer is immediately reachable. */}
      <PullRequestDisclosureSection label="Comments" count={detail.comments.length}>
        <PullRequestComments detail={detail} />
      </PullRequestDisclosureSection>
    </div>
  );
}
