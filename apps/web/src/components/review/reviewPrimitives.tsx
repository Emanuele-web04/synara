import type { ReviewFindingSeverity, ReviewPullRequestSummary } from "@t3tools/contracts";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { ArrowRightIcon, GitBranchIcon } from "~/lib/icons";
import { DiffStat } from "../chat/DiffStatLabel";
import { Skeleton } from "../ui/skeleton";
import { ReviewAvatar } from "./reviewPrPrimitives";

const DEFAULT_BASE_BRANCHES = new Set(["main", "master"]);

const CONVENTIONAL_COMMIT_PREFIX = /^([a-z]+(?:\([^)]*\))?!?:)\s+(.*)$/i;

export function splitConventionalCommitTitle(title: string): {
  prefix: string | null;
  rest: string;
} {
  const match = CONVENTIONAL_COMMIT_PREFIX.exec(title);
  if (!match || match[2]!.length === 0) {
    return { prefix: null, rest: title };
  }
  return { prefix: match[1]!, rest: match[2]! };
}

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const RELATIVE_TIME_THRESHOLDS: ReadonlyArray<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "week", ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
];

export function formatRelativeReviewTime(isoDate: string): string | null {
  const timestamp = Date.parse(isoDate);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  const deltaMs = timestamp - Date.now();
  const absMs = Math.abs(deltaMs);
  for (const { unit, ms } of RELATIVE_TIME_THRESHOLDS) {
    if (absMs >= ms) {
      return RELATIVE_TIME_FORMATTER.format(Math.round(deltaMs / ms), unit);
    }
  }
  return RELATIVE_TIME_FORMATTER.format(Math.round(deltaMs / 1000), "second");
}

export type ReviewPillTone = "neutral" | "success" | "warning" | "danger" | "info" | "muted";

const PILL_TONE_CLASS: Record<ReviewPillTone, string> = {
  neutral: "bg-muted text-foreground",
  muted: "bg-muted/60 text-muted-foreground",
  success: "bg-emerald-500/12 text-emerald-700 dark:bg-emerald-400/16 dark:text-emerald-300",
  warning: "bg-amber-500/14 text-amber-700 dark:bg-amber-400/16 dark:text-amber-300",
  danger: "bg-destructive/12 text-destructive dark:bg-destructive/18",
  info: "bg-info/12 text-info-foreground dark:bg-info/18",
};

export interface ReviewPillDescriptor {
  label: string;
  tone: ReviewPillTone;
}

export function ReviewPill(props: {
  tone: ReviewPillTone;
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={props.title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-medium text-[10px] leading-none",
        PILL_TONE_CLASS[props.tone],
        props.className,
      )}
    >
      {props.icon ? (
        <span className="-ms-0.5 inline-flex shrink-0 [&_svg]:size-3" aria-hidden="true">
          {props.icon}
        </span>
      ) : null}
      {props.children}
    </span>
  );
}

interface ReviewRailResize {
  bounds: { min: number; max: number };
  width: number;
  handleResizeStart: (event: PointerEvent<HTMLElement>) => void;
  handleResizeKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  resetWidth: () => void;
}

export function ReviewRailResizer(props: {
  resize: ReviewRailResize;
  edge: "left" | "right";
  label: string;
  className?: string;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuemin={props.resize.bounds.min}
      aria-valuemax={props.resize.bounds.max}
      aria-valuenow={props.resize.width}
      tabIndex={0}
      onDoubleClick={props.resize.resetWidth}
      onPointerDown={props.resize.handleResizeStart}
      onKeyDown={props.resize.handleResizeKeyDown}
      className={cn(
        "relative z-10 w-1 shrink-0 cursor-col-resize bg-border/40 outline-none",
        "before:absolute before:-inset-x-1.5 before:inset-y-0 before:content-['']",
        "transition-colors duration-150 hover:bg-[var(--sidebar-accent)] focus-visible:bg-primary/30",
        props.edge === "right" ? "-me-px" : "-ms-px",
        props.className,
      )}
    />
  );
}

export function ReviewLoadingRows(props: { rows?: number; className?: string }) {
  return (
    <ul className={cn("flex flex-col divide-y divide-border/60", props.className)} aria-busy="true">
      {Array.from({ length: props.rows ?? 6 }, (_, index) => (
        <li key={index} className="flex min-w-0 items-center gap-2 px-4 py-2.5">
          <Skeleton className="size-3.5 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-2.5 w-24" />
          </div>
          <Skeleton className="h-3 w-12 shrink-0" />
        </li>
      ))}
    </ul>
  );
}

export function ReviewPullRequestMeta(props: {
  pullRequest: ReviewPullRequestSummary;
  showState?: boolean;
  showDecision?: boolean;
  className?: string;
}) {
  const { pullRequest } = props;
  const relativeUpdatedAt = formatRelativeReviewTime(pullRequest.updatedAt);
  const state = prStatePill(pullRequest.state);
  const decision = reviewDecisionPill(pullRequest.reviewDecision);
  const showBaseBranch = !DEFAULT_BASE_BRANCHES.has(pullRequest.baseBranch.toLowerCase());

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", props.className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <span
          className="flex min-w-0 items-center gap-1 text-muted-foreground"
          title={`${pullRequest.headBranch} -> ${pullRequest.baseBranch}`}
        >
          <GitBranchIcon className="size-3 shrink-0 opacity-60" />
          <span className="truncate font-mono">{pullRequest.headBranch}</span>
          {showBaseBranch ? (
            <>
              <ArrowRightIcon className="size-3 shrink-0 opacity-60" />
              <span className="truncate font-mono">{pullRequest.baseBranch}</span>
            </>
          ) : null}
        </span>
        {relativeUpdatedAt ? (
          <span className="text-muted-foreground/70 tabular-nums">updated {relativeUpdatedAt}</span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]">
        <DiffStat additions={pullRequest.additions} deletions={pullRequest.deletions} />
        {props.showState === true && pullRequest.state !== "open" ? (
          <ReviewPill tone={state.tone}>{state.label}</ReviewPill>
        ) : null}
        {pullRequest.isDraft ? <ReviewPill tone="muted">Draft</ReviewPill> : null}
        {props.showDecision !== false && decision ? (
          <ReviewPill tone={decision.tone}>{decision.label}</ReviewPill>
        ) : null}
        {pullRequest.author.trim().length > 0 ? (
          <span className="ms-auto inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
            <ReviewAvatar
              login={pullRequest.author}
              {...(pullRequest.authorAvatarUrl !== undefined
                ? { avatarUrl: pullRequest.authorAvatarUrl }
                : {})}
            />
            <span className="max-w-28 truncate">{pullRequest.author}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function titleCaseDecision(decision: string): string {
  return decision
    .toLowerCase()
    .split("_")
    .map((segment) => (segment.length > 0 ? segment[0]!.toUpperCase() + segment.slice(1) : segment))
    .join(" ");
}

export function reviewDecisionPill(decision: string | null): ReviewPillDescriptor | null {
  if (!decision) {
    return null;
  }
  switch (decision) {
    case "APPROVED":
      return { label: "Approved", tone: "success" };
    case "CHANGES_REQUESTED":
      return { label: "Changes requested", tone: "warning" };
    case "REVIEW_REQUIRED":
      return { label: "Review required", tone: "muted" };
    default:
      return { label: titleCaseDecision(decision), tone: "muted" };
  }
}

export function checksPill(
  status: ReviewPullRequestSummary["checksStatus"],
): ReviewPillDescriptor | null {
  switch (status) {
    case "passing":
      return { label: "Checks", tone: "success" };
    case "failing":
      return { label: "Checks", tone: "danger" };
    case "pending":
      return { label: "Checks", tone: "warning" };
    case "none":
      return null;
  }
}

export function prStatePill(state: ReviewPullRequestSummary["state"]): ReviewPillDescriptor {
  switch (state) {
    case "merged":
      return { label: "Merged", tone: "info" };
    case "closed":
      return { label: "Closed", tone: "danger" };
    case "open":
      return { label: "Open", tone: "success" };
  }
}

const SEVERITY_PILL: Record<ReviewFindingSeverity, ReviewPillDescriptor> = {
  blocker: { label: "Blocker", tone: "danger" },
  major: { label: "Major", tone: "warning" },
  minor: { label: "Minor", tone: "info" },
  nit: { label: "Nit", tone: "muted" },
};

export function severityPill(severity: ReviewFindingSeverity): ReviewPillDescriptor {
  return SEVERITY_PILL[severity];
}

export function CountChip(props: { count: number; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-4 items-center justify-center rounded-full bg-muted px-1 font-medium text-[10px] text-foreground tabular-nums",
        props.className,
      )}
    >
      {props.count}
    </span>
  );
}

export const reviewTextareaClassName =
  "w-full resize-y rounded-lg border border-input bg-background/80 px-3 py-2 font-system-ui text-[12px] text-foreground outline-none transition-[border-color,box-shadow,background-color] duration-150 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 disabled:opacity-64 motion-reduce:transition-none";

export function EmptyState(props: {
  children: ReactNode;
  title?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 px-3 py-6 text-center text-[11px] text-muted-foreground/70",
        props.className,
      )}
    >
      {props.icon ? (
        <span className="inline-flex shrink-0 opacity-60 [&_svg]:size-4" aria-hidden="true">
          {props.icon}
        </span>
      ) : null}
      {props.title ? (
        <span className="flex flex-col gap-0.5">
          <span className="text-balance font-medium text-muted-foreground">{props.title}</span>
          <span className="text-balance text-muted-foreground/75">{props.children}</span>
        </span>
      ) : (
        <span className="text-balance">{props.children}</span>
      )}
      {props.action ? <span className="mt-1.5 inline-flex shrink-0">{props.action}</span> : null}
    </div>
  );
}

export function reviewCardShellClassName(opts?: {
  dragging?: boolean;
  className?: string | undefined;
}): string {
  return cn(
    "group/card flex w-full flex-col gap-1.5 rounded-[0.625rem] border border-border/70 bg-card px-3.5 py-3 text-left",
    "hover:border-border/90 hover:bg-[var(--sidebar-accent)]",
    "active:bg-[var(--sidebar-accent)]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
    opts?.dragging && "z-10 opacity-80 shadow-md",
    opts?.className,
  );
}

interface ReviewCardShellProps extends useRender.ComponentProps<"button"> {
  dragging?: boolean;
}

export function ReviewCardShell({
  className,
  dragging = false,
  render,
  ...props
}: ReviewCardShellProps) {
  const defaultProps = {
    ...(render ? {} : { type: "button" as const }),
    className: reviewCardShellClassName({ dragging, className }),
    "data-slot": "review-card-shell",
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

export function ReviewColumn(props: {
  label: string;
  count: number;
  children: ReactNode;
  action?: ReactNode;
  isEmpty?: boolean;
  empty?: ReactNode;
  className?: string;
  isOver?: boolean;
  innerRef?: (node: HTMLElement | null) => void;
}) {
  return (
    <section
      ref={props.innerRef}
      className={cn(
        "flex h-full w-full shrink-0 flex-col gap-2 rounded-xl border border-border/55 bg-card/40 p-2.5 md:w-72",
        props.isOver && "bg-primary/[0.04] ring-2 ring-ring ring-inset",
        props.className,
      )}
    >
      <header className="flex shrink-0 items-center gap-2 px-1">
        <span
          className="min-w-0 truncate font-medium text-[11px] text-muted-foreground uppercase tracking-wide"
          title={props.label}
        >
          {props.label}
        </span>
        {props.count > 0 ? <CountChip count={props.count} /> : null}
        {props.action ? <span className="ms-auto shrink-0">{props.action}</span> : null}
      </header>
      {props.isEmpty ? (
        (props.empty ?? <EmptyState>No items in this column.</EmptyState>)
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain">
          {props.children}
        </ul>
      )}
    </section>
  );
}
