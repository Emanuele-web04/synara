import type { ReviewPullRequestDetail, ReviewPullRequestHeaderDetail } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { DiffStat } from "~/components/chat/DiffStatLabel";
import {
  ArrowLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  FileIcon,
  GitMergeIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  SparklesIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ReviewAvatar } from "./reviewPrPrimitives";
import {
  ReviewPill,
  type ReviewPillTone,
  formatRelativeReviewTime,
  prStatePill,
} from "./reviewPrimitives";

function repoSlug(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split("/").filter((segment) => segment.length > 0);
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
  } catch {
    return null;
  }
}

function DiffSquares(props: { additions: number; deletions: number }) {
  const total = props.additions + props.deletions;
  const greens =
    total === 0
      ? 0
      : Math.min(
          5,
          Math.max(props.additions > 0 ? 1 : 0, Math.round((props.additions / total) * 5)),
        );
  const reds =
    total === 0 ? 0 : Math.min(5 - greens, Math.max(props.deletions > 0 ? 1 : 0, 5 - greens));
  return (
    <span
      className="inline-flex items-center gap-0.5"
      aria-label={`${props.additions} additions, ${props.deletions} deletions`}
      title={`${props.additions} additions, ${props.deletions} deletions`}
    >
      {Array.from({ length: 5 }, (_, index) => (
        <span
          key={index}
          className={cn(
            "size-1.5 rounded-full",
            index < greens
              ? "bg-success"
              : index < greens + reds
                ? "bg-destructive"
                : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

function BranchChip(props: { name: string; compact?: boolean }) {
  return (
    <span
      className={cn(
        "min-w-0 truncate rounded-full border border-border/45 bg-muted/20 font-mono text-foreground",
        props.compact
          ? "max-w-[11rem] px-1.5 py-0 text-[10.5px] leading-5 text-muted-foreground"
          : "max-w-[18rem] px-2 py-0.5 text-[12px]",
      )}
      title={props.name}
    >
      {props.name}
    </span>
  );
}

function mergeReadiness(detail: ReviewPullRequestDetail | ReviewPullRequestHeaderDetail): {
  label: string;
  tone: "success" | "warning" | "danger" | "muted";
} {
  if (detail.state === "merged") {
    return { label: "Merged", tone: "success" };
  }
  if (detail.state === "closed") {
    return { label: "Closed", tone: "muted" };
  }
  if (detail.isDraft) {
    return { label: "Draft pull request", tone: "muted" };
  }
  if (detail.mergeable === "CONFLICTING") {
    return { label: "Conflicts must be resolved", tone: "danger" };
  }
  if (detail.checksStatus === undefined) {
    return { label: "Checks loading", tone: "warning" };
  }
  if (detail.checksStatus === "failing") {
    return { label: "Checks are failing", tone: "danger" };
  }
  if (detail.checksStatus === "pending") {
    return { label: "Checks are running", tone: "warning" };
  }
  if (detail.mergeable === "UNKNOWN") {
    return { label: "Mergeability unknown", tone: "warning" };
  }
  return { label: "Ready to merge", tone: "success" };
}

function MergeReadinessIcon(props: { tone: ReturnType<typeof mergeReadiness>["tone"] }) {
  if (props.tone === "success") {
    return <CircleCheckIcon className="size-4 text-success-foreground" />;
  }
  if (props.tone === "danger") {
    return <CircleAlertIcon className="size-4 text-destructive" />;
  }
  return <CircleAlertIcon className="size-4 text-warning-foreground" />;
}

export function ReviewPrHeader(props: {
  detail: ReviewPullRequestDetail | ReviewPullRequestHeaderDetail;
  variant?: "full" | "compact";
  reviewMode?: "conversation" | "files";
  contentClassName?: string;
  onReviewChanges?: () => void;
  onOverview?: () => void;
  onCommits?: () => void;
  commitsActive?: boolean;
  onWalkthrough?: () => void;
  walkthroughActive?: boolean;
  reviewAction?: ReactNode;
}) {
  const { detail } = props;
  const variant = props.variant ?? "full";
  const commitStat = (
    <>
      <GitCommitIcon className="size-3.5 opacity-75" />
      {detail.commitsCount === undefined ? (
        <span className="font-medium text-foreground">Loading commits</span>
      ) : (
        <>
          <span className="font-medium text-foreground tabular-nums">{detail.commitsCount}</span>
          commit{detail.commitsCount === 1 ? "" : "s"}
        </>
      )}
    </>
  );
  const [copiedBranches, setCopiedBranches] = useState(false);
  const copyResetTimeout = useRef<number | null>(null);
  const updatedAt = formatRelativeReviewTime(detail.updatedAt);
  const slug = repoSlug(detail.url);
  const state =
    detail.isDraft && detail.state === "open"
      ? { label: "Draft", tone: "muted" as ReviewPillTone }
      : prStatePill(detail.state);
  const StateIcon = detail.state === "merged" ? GitMergeIcon : GitPullRequestIcon;
  const readiness = mergeReadiness(detail);
  const isFilesMode = props.reviewMode === "files";

  useEffect(
    () => () => {
      if (copyResetTimeout.current !== null) {
        window.clearTimeout(copyResetTimeout.current);
      }
    },
    [],
  );

  const copyBranches = () => {
    void navigator.clipboard?.writeText(`${detail.baseBranch} <- ${detail.headBranch}`);
    setCopiedBranches(true);
    if (copyResetTimeout.current !== null) {
      window.clearTimeout(copyResetTimeout.current);
    }
    copyResetTimeout.current = window.setTimeout(() => setCopiedBranches(false), 700);
  };

  const primaryAction =
    props.reviewMode === "files" && props.onOverview ? (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 shrink-0 rounded-full px-3 text-[12px] transition-[transform,box-shadow] duration-150 motion-reduce:transition-none lg:gap-1.5"
        title="Back to pull request overview"
        aria-label="Back to pull request overview"
        onClick={props.onOverview}
      >
        <ArrowLeftIcon className="size-3.5" />
        <span className="hidden lg:inline">Overview</span>
      </Button>
    ) : props.onReviewChanges ? (
      <Button
        type="button"
        size="sm"
        variant="prominent"
        className="h-8 shrink-0 rounded-full px-4 text-[13px] transition-[transform,box-shadow] duration-150 motion-reduce:transition-none"
        title="Open files and inline comments"
        onClick={props.onReviewChanges}
      >
        Review changes
      </Button>
    ) : null;

  if (variant === "compact") {
    return (
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/55 bg-background px-3">
        <StateIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 flex-1 truncate font-medium text-[13px] text-foreground">
          {detail.title}
        </h1>
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          #{detail.number}
        </span>
        <ReviewPill tone={state.tone}>{state.label}</ReviewPill>
        {updatedAt ? (
          <span className="hidden shrink-0 text-[11px] text-muted-foreground/80 tabular-nums sm:inline">
            updated {updatedAt}
          </span>
        ) : null}
        <span
          className={cn(
            "hidden shrink-0 items-center gap-1 text-[11px] font-medium md:inline-flex",
            readiness.tone === "danger"
              ? "text-destructive"
              : readiness.tone === "success"
                ? "text-success-foreground"
                : "text-warning-foreground",
          )}
        >
          <MergeReadinessIcon tone={readiness.tone} />
          {readiness.label}
        </span>
        <div className="ms-auto flex shrink-0 items-center gap-3.5">
          {props.reviewAction}
          {primaryAction}
        </div>
      </div>
    );
  }

  return (
    <header
      className={cn(
        "flex shrink-0 flex-col border-b border-border/45 bg-background",
        isFilesMode ? "py-2.5" : "py-5",
      )}
    >
      <div className={cn("gap-2.5", props.contentClassName ?? "px-5 sm:px-7")}>
        <div className="flex min-w-0 items-start justify-between gap-4">
          <div className={cn("flex min-w-0 flex-col", isFilesMode ? "gap-1.5" : "gap-3")}>
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <span>Pull Requests</span>
              {slug ? (
                <>
                  <span className="text-muted-foreground/70">/</span>
                  <span className="truncate">{slug}</span>
                </>
              ) : null}
              <span className="text-muted-foreground/70">/</span>
              <span className="tabular-nums">#{detail.number}</span>
            </div>

            <div className="flex min-w-0 items-start gap-2.5">
              <StateIcon
                className={cn(
                  "shrink-0 text-success-foreground",
                  isFilesMode ? "mt-0.5 size-3.5" : "mt-1.5 size-5",
                )}
              />
              <h1
                className={cn(
                  "min-w-0 text-pretty font-semibold text-foreground leading-tight",
                  isFilesMode ? "text-[18px] sm:text-[19px]" : "text-[24px] sm:text-[26px]",
                )}
              >
                {detail.title}
              </h1>
            </div>
          </div>
        </div>

        <div
          className={cn(
            "mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground",
            isFilesMode ? "text-[12px]" : "text-[13px] sm:ps-7",
          )}
        >
          <ReviewPill
            tone={state.tone}
            className={cn(
              "rounded-full px-2 py-0.5 font-semibold text-[11px]",
              state.tone === "success" && "bg-success/14 text-success-foreground",
            )}
          >
            {state.label}
          </ReviewPill>
          <span className="inline-flex items-center gap-1.5">
            <ReviewAvatar
              login={detail.author}
              {...(detail.authorAvatarUrl !== undefined
                ? { avatarUrl: detail.authorAvatarUrl }
                : {})}
              className="size-4"
            />
            <span className="font-medium text-foreground">{detail.author || "unknown"}</span>
          </span>
          <span>wants to merge into</span>
          <span className="inline-flex min-w-0 items-center gap-2">
            <BranchChip name={detail.baseBranch} />
            <span>from</span>
            <BranchChip name={detail.headBranch} />
          </span>
          <button
            type="button"
            aria-label="Copy branch names"
            title={copiedBranches ? "Copied" : "Copy branch names"}
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none ring-1 ring-transparent transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100",
              copiedBranches && "bg-success/12 text-success-foreground ring-success/20",
            )}
            onClick={copyBranches}
          >
            {copiedBranches ? (
              <CheckIcon className="size-3.5" />
            ) : (
              <CopyIcon className="size-3.5" />
            )}
          </button>
        </div>

        <div
          className={cn(
            "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground",
            isFilesMode
              ? "mt-5 min-h-11 rounded-[1.45rem] border border-border/45 bg-muted/25 px-4 py-2 sm:ms-6"
              : "mt-7 min-h-12 rounded-[1.45rem] border border-border/45 bg-muted/25 px-4 py-2.5",
          )}
        >
          {props.onCommits ? (
            <button
              type="button"
              onClick={props.onCommits}
              aria-pressed={props.commitsActive}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                props.commitsActive && "text-foreground",
              )}
            >
              {commitStat}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5">{commitStat}</span>
          )}
          <span className="text-muted-foreground/70" aria-hidden="true">
            ·
          </span>
          <span className="inline-flex items-center gap-1.5">
            <FileIcon className="size-3.5 opacity-75" />
            <span className="font-medium text-foreground tabular-nums">{detail.changedFiles}</span>
            file{detail.changedFiles === 1 ? "" : "s"} changed
          </span>
          <span className="inline-flex items-center gap-1.5">
            <DiffStat
              additions={detail.additions}
              deletions={detail.deletions}
              className="text-[12px] tabular-nums"
            />
            <DiffSquares additions={detail.additions} deletions={detail.deletions} />
          </span>
          {props.onWalkthrough ? (
            <>
              <span className="text-muted-foreground/70" aria-hidden="true">
                ·
              </span>
              <button
                type="button"
                onClick={props.onWalkthrough}
                aria-pressed={props.walkthroughActive}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                  props.walkthroughActive && "text-foreground",
                )}
              >
                <SparklesIcon className="size-3.5 opacity-75" />
                Walkthrough
              </button>
            </>
          ) : null}
          <div className="ms-auto flex min-w-0 shrink-0 items-center gap-4">
            <span
              className={cn(
                "inline-flex min-w-0 items-center gap-1.5 text-[12px] transition-colors duration-150 motion-reduce:transition-none",
                readiness.tone === "danger"
                  ? "text-destructive"
                  : readiness.tone === "success"
                    ? "text-success-foreground"
                    : "text-warning-foreground",
              )}
            >
              <MergeReadinessIcon tone={readiness.tone} />
              <span className="truncate font-medium">{readiness.label}</span>
            </span>
            {props.reviewAction}
            {primaryAction}
          </div>
        </div>
      </div>
    </header>
  );
}
