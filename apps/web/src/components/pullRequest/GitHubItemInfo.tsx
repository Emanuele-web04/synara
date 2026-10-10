// FILE: GitHubItemInfo.tsx
// Purpose: The status facts of a GitHub item's detail page, in two shapes of the same data: a
//          right-hand column of titled sections (wide panes) and compact label/value rows under
//          the header (narrow panes, or whenever the side chat dock takes the room). Pull
//          requests show Merge status, Comments, Reviews, Checks; issues show Assignees, Labels,
//          Comments. Either can lead with Threads, the item's side chats.
// Layer: Pull request presentation
// Exports: PullRequestInfo, IssueInfo, GitHubItemInfoThread, GitHubItemInfoVariant

import type { GitHubIssueDetail, PullRequestDetail, ThreadId } from "@synara/contracts";
import { useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { CentralIcon } from "~/lib/central-icons";
import {
  BotIcon,
  ChatBubbleIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  TagIcon,
  UsersIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { withStableCheckKeys } from "~/components/chat/environment/environmentPullRequest.logic";
import { GitHubLabelChips } from "./GitHubLabelChips";
import { PullRequestActorLabel } from "./PullRequestActorLabel";
import { PullRequestCheckStatusIcon } from "./PullRequestCheckStatusIcon";
import { PullRequestChecksRing } from "./PullRequestChecksRing";
import {
  describePullRequestChecksBrief,
  describePullRequestMergeStatus,
} from "./pullRequestDetail.logic";
import { PullRequestStateGlyph } from "./PullRequestStateGlyph";
import { PullRequestMetaRow } from "./PullRequestMetaRow";
import { PullRequestConflictIcon } from "./pullRequestStatePresentation";
import { PR_META_TEXT_CLASS_NAME, PR_FINE_TEXT_CLASS_NAME } from "./pullRequestText";

export interface GitHubItemInfoThread {
  id: ThreadId;
  title: string;
}

/** Checks listed before "View more". */
const CHECKS_VISIBLE_LIMIT = 6;

export type GitHubItemInfoVariant = "column" | "rows";
type InfoVariant = GitHubItemInfoVariant;

function InfoSection({
  variant,
  label,
  icon,
  action,
  children,
}: {
  variant: InfoVariant;
  label: string;
  icon?: ReactNode;
  /** Sits at the label's end in the column (the "Request" chip). */
  action?: ReactNode;
  children: ReactNode;
}) {
  if (variant === "rows") {
    return (
      <PullRequestMetaRow icon={icon} label={label}>
        {children}
      </PullRequestMetaRow>
    );
  }
  return (
    <section className="flex flex-col gap-2" aria-label={label}>
      <div className="flex h-6 items-center justify-between gap-2">
        <h2 className={cn(PR_META_TEXT_CLASS_NAME, "m-0 font-normal text-muted-foreground")}>
          {label}
        </h2>
        {action}
      </div>
      <div className={cn(PR_META_TEXT_CLASS_NAME, "flex min-w-0 flex-col gap-2")}>{children}</div>
    </section>
  );
}

function RequestChip({ url }: { url: string }) {
  return (
    <Button
      variant="secondary"
      size="xs"
      className="h-6 gap-0.5 rounded-full pr-1.5 pl-2.5 font-normal"
      onClick={() => void ensureNativeApi().shell.openExternal(url)}
    >
      Request
      <ChevronRightIcon aria-hidden />
    </Button>
  );
}

function ThreadsSection({
  variant,
  threads,
  onOpenThread,
}: {
  variant: InfoVariant;
  threads: ReadonlyArray<GitHubItemInfoThread>;
  onOpenThread: ((id: ThreadId) => void) | undefined;
}) {
  if (threads.length === 0) return null;
  return (
    <InfoSection variant={variant} label="Threads" icon={<BotIcon className="size-4" />}>
      {threads.map((thread) => (
        <button
          key={thread.id}
          type="button"
          onClick={() => onOpenThread?.(thread.id)}
          className="max-w-full truncate rounded-md text-left hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {thread.title.replace(/^Sidechat:\s*/, "")}
        </button>
      ))}
    </InfoSection>
  );
}

function CommentsSection({ variant, count }: { variant: InfoVariant; count: number }) {
  return (
    <InfoSection variant={variant} label="Comments" icon={<ChatBubbleIcon className="size-4" />}>
      <span className={count === 0 ? "text-muted-foreground" : undefined}>
        {count === 0 ? "No comments" : `${count} ${count === 1 ? "comment" : "comments"}`}
      </span>
    </InfoSection>
  );
}

function MergeStatusSection({ detail }: { detail: PullRequestDetail }) {
  const status = describePullRequestMergeStatus(detail);
  return (
    <InfoSection variant="column" label="Merge status">
      <span className="flex items-center gap-2">
        {status.tone === "success" ? (
          <CentralIcon name="circle-check" variant="fill" className="size-4 text-status-success" />
        ) : status.tone === "conflict" ? (
          <PullRequestConflictIcon className="size-4" />
        ) : (
          <PullRequestStateGlyph state={detail.state} isDraft={detail.isDraft} />
        )}
        {status.label}
      </span>
    </InfoSection>
  );
}

function ReviewsSection({ variant, detail }: { variant: InfoVariant; detail: PullRequestDetail }) {
  const requestable = detail.state === "open";
  const reviewCount = detail.comments.filter((comment) => comment.kind === "review").length;
  const hasReviews = detail.reviewers.length > 0 || reviewCount > 0 || detail.reviewDecision;
  const decision =
    detail.reviewDecision === "APPROVED"
      ? "Approved"
      : detail.reviewDecision === "CHANGES_REQUESTED"
        ? "Changes requested"
        : null;
  // GitHub has no request-review action here; its pull request page is where reviewers are picked.
  const request = requestable ? <RequestChip url={detail.url} /> : null;
  return (
    <InfoSection
      variant={variant}
      label="Reviews"
      icon={<UsersIcon className="size-4" />}
      action={variant === "column" ? request : undefined}
    >
      {hasReviews ? (
        <>
          {decision ? <span>{decision}</span> : null}
          {detail.reviewers.map((actor) => (
            <PullRequestActorLabel key={actor.login} actor={actor} className="max-w-full" />
          ))}
        </>
      ) : (
        <span className="text-muted-foreground">No reviews</span>
      )}
      {variant === "rows" ? request : null}
    </InfoSection>
  );
}

function CheckRows({ checks }: { checks: PullRequestDetail["checks"] }) {
  const [showAll, setShowAll] = useState(false);
  const rows = withStableCheckKeys(checks);
  const visible = showAll ? rows : rows.slice(0, CHECKS_VISIBLE_LIMIT);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {visible.map(({ key, check }) => (
        <button
          key={key}
          type="button"
          disabled={!check.url}
          onClick={() => check.url && void ensureNativeApi().shell.openExternal(check.url)}
          className="-mx-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-muted/50 disabled:hover:bg-transparent"
        >
          <PullRequestCheckStatusIcon status={check.status} />
          <span className="min-w-0 truncate">{check.name}</span>
        </button>
      ))}
      {rows.length > CHECKS_VISIBLE_LIMIT ? (
        <button
          type="button"
          onClick={() => setShowAll((current) => !current)}
          className={cn(
            PR_FINE_TEXT_CLASS_NAME,
            "w-fit rounded-md text-left text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
          {showAll ? "Show fewer" : "View more"}
        </button>
      ) : null}
    </div>
  );
}

function ChecksSection({ variant, detail }: { variant: InfoVariant; detail: PullRequestDetail }) {
  const [open, setOpen] = useState(false);
  const brief = describePullRequestChecksBrief(detail.checks);
  if (variant === "column") {
    return (
      <InfoSection variant="column" label="Checks">
        {detail.checks.length === 0 ? (
          <span className="text-muted-foreground">No checks</span>
        ) : (
          <CheckRows checks={detail.checks} />
        )}
      </InfoSection>
    );
  }
  return (
    <InfoSection
      variant="rows"
      label="Checks"
      icon={<PullRequestChecksRing checks={detail.checks} />}
    >
      {detail.checks.length === 0 ? (
        <span className="text-muted-foreground">No checks</span>
      ) : (
        <div className="flex w-full min-w-0 flex-col">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            className="flex w-fit items-center gap-1.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {brief.tone === "success" ? (
              <CircleCheckIcon className="size-4 text-status-success" aria-hidden />
            ) : null}
            {brief.label}
            <DisclosureChevron open={open} />
          </button>
          <DisclosureRegion open={open}>
            <div className="pt-1.5">
              <CheckRows checks={detail.checks} />
            </div>
          </DisclosureRegion>
        </div>
      )}
    </InfoSection>
  );
}

export function PullRequestInfo({
  detail,
  variant,
  threads,
  onOpenThread,
}: {
  detail: PullRequestDetail;
  variant: InfoVariant;
  threads: ReadonlyArray<GitHubItemInfoThread>;
  onOpenThread?: ((id: ThreadId) => void) | undefined;
}) {
  return (
    <div
      className={cn(variant === "column" ? "flex flex-col gap-7" : "flex flex-col")}
      data-info-variant={variant}
    >
      {variant === "column" ? <MergeStatusSection detail={detail} /> : null}
      <ThreadsSection variant={variant} threads={threads} onOpenThread={onOpenThread} />
      <CommentsSection variant={variant} count={detail.comments.length} />
      <ReviewsSection variant={variant} detail={detail} />
      <ChecksSection variant={variant} detail={detail} />
    </div>
  );
}

export function IssueInfo({
  detail,
  variant,
  threads,
  onOpenThread,
}: {
  detail: GitHubIssueDetail;
  variant: InfoVariant;
  threads: ReadonlyArray<GitHubItemInfoThread>;
  onOpenThread?: ((id: ThreadId) => void) | undefined;
}) {
  return (
    <div
      className={cn(variant === "column" ? "flex flex-col gap-7" : "flex flex-col")}
      data-info-variant={variant}
    >
      <ThreadsSection variant={variant} threads={threads} onOpenThread={onOpenThread} />
      <InfoSection variant={variant} label="Assignees" icon={<UsersIcon className="size-4" />}>
        {detail.assignees.length === 0 ? (
          <span className="text-muted-foreground">Unassigned</span>
        ) : (
          detail.assignees.map((actor) => (
            <PullRequestActorLabel key={actor.login} actor={actor} className="max-w-full" />
          ))
        )}
      </InfoSection>
      <InfoSection variant={variant} label="Labels" icon={<TagIcon className="size-4" />}>
        {detail.labels.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <GitHubLabelChips labels={detail.labels} className="flex-wrap" />
        )}
      </InfoSection>
      <CommentsSection variant={variant} count={detail.commentCount} />
    </div>
  );
}
