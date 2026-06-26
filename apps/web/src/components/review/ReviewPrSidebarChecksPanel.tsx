import type {
  ReviewCheck,
  ReviewCheckState,
  ReviewPullRequestDetail,
  ReviewPullRequestHeaderDetail,
} from "@t3tools/contracts";
import type { ReactElement } from "react";

import { ArrowUpRightIcon, CircleCheckIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { CheckStateIcon, checkStateLabel } from "./reviewPrPrimitives";
import { EmptyState } from "./reviewPrimitives";

export type ReviewChecksStatus =
  | ReviewPullRequestDetail["checksStatus"]
  | ReviewPullRequestHeaderDetail["checksStatus"];

export type ChecksTone = "danger" | "warning" | "success" | "muted";

export interface ReviewChecksSummary {
  readonly total: number;
  readonly passed: number;
  readonly failing: number;
  readonly running: number;
}

const PASSING_CHECK_STATES = new Set<ReviewCheckState>(["success", "skipped", "neutral"]);
const FAILING_CHECK_STATES = new Set<ReviewCheckState>(["failure", "cancelled"]);

const CHECK_STATE_SORT_ORDER: Record<ReviewCheckState, number> = {
  failure: 0,
  cancelled: 1,
  pending: 2,
  success: 3,
  skipped: 4,
  neutral: 5,
};

const PANEL_TONE_CLASS: Record<ChecksTone, string> = {
  danger: "border-border/40 bg-destructive/10",
  warning: "border-border/40 bg-warning/10",
  success: "border-border/40 bg-success/8",
  muted: "border-border/40 bg-muted/40",
};

const SUMMARY_TONE_CLASS: Record<ChecksTone, string> = {
  danger: "text-destructive",
  warning: "text-warning-foreground",
  success: "text-success-foreground",
  muted: "text-foreground",
};

const ROW_TONE_CLASS: Record<ReviewCheckState, string> = {
  failure: "border-destructive/24 bg-destructive/8",
  cancelled: "border-destructive/18 bg-destructive/5",
  pending: "border-warning/24 bg-warning/8",
  success: "border-border/18 bg-background/24",
  skipped: "border-border/18 bg-background/16",
  neutral: "border-border/18 bg-background/16",
};

export function summarizeReviewChecks(checks: ReadonlyArray<ReviewCheck>): ReviewChecksSummary {
  let passed = 0;
  let failing = 0;
  let running = 0;
  for (const check of checks) {
    if (PASSING_CHECK_STATES.has(check.state)) {
      passed += 1;
    } else if (FAILING_CHECK_STATES.has(check.state)) {
      failing += 1;
    } else if (check.state === "pending") {
      running += 1;
    }
  }
  return {
    total: checks.length,
    passed,
    failing,
    running,
  };
}

export function reviewChecksTone(
  summary: ReviewChecksSummary,
  status: ReviewChecksStatus,
): ChecksTone {
  if (summary.failing > 0 || status === "failing") {
    return "danger";
  }
  if (summary.running > 0 || status === "pending" || status === undefined) {
    return "warning";
  }
  if (summary.total > 0 || status === "passing") {
    return "success";
  }
  return "muted";
}

export function reviewChecksHeadline(
  summary: ReviewChecksSummary,
  status: ReviewChecksStatus,
): string {
  if (summary.total === 0) {
    switch (status) {
      case "failing":
        return "Checks failing";
      case "pending":
        return "Checks running";
      case "passing":
        return "Checks passed";
      case "none":
        return "No CI checks";
      case undefined:
        return "Loading checks";
    }
  }
  if (summary.failing > 0) {
    return `${summary.failing} failing`;
  }
  if (summary.running > 0) {
    return `${summary.running} running`;
  }
  if (summary.passed === summary.total) {
    return "All checks passed";
  }
  return `${summary.passed}/${summary.total} passed`;
}

export function reviewChecksDetail(
  summary: ReviewChecksSummary,
  status: ReviewChecksStatus,
): string {
  if (summary.total === 0) {
    switch (status) {
      case "failing":
        return "Detailed job list is still loading.";
      case "pending":
        return "Detailed job list is still loading.";
      case "passing":
        return "Detailed job list is still loading.";
      case "none":
        return "No checks reported for this PR.";
      case undefined:
        return "CI details are still syncing.";
    }
  }
  if (summary.failing > 0) {
    return "CI is blocking this PR.";
  }
  if (summary.running > 0) {
    return `${summary.running} check${summary.running === 1 ? "" : "s"} still running.`;
  }
  return `${summary.total} check${summary.total === 1 ? "" : "s"} passing.`;
}

function sortChecks(checks: ReadonlyArray<ReviewCheck>): ReadonlyArray<ReviewCheck> {
  return checks
    .map((check, index) => ({ check, index }))
    .sort((left, right) => {
      const stateOrder =
        CHECK_STATE_SORT_ORDER[left.check.state] - CHECK_STATE_SORT_ORDER[right.check.state];
      if (stateOrder !== 0) {
        return stateOrder;
      }
      return left.index - right.index;
    })
    .map(({ check }) => check);
}

function CheckStat(props: { label: string; value: number }): ReactElement {
  return (
    <div className="min-w-0 px-2 py-1.5">
      <dt className="truncate font-medium text-[10px] text-muted-foreground">{props.label}</dt>
      <dd className="mt-0.5 font-semibold text-[13px] text-foreground tabular-nums">
        {props.value}
      </dd>
    </div>
  );
}

export function CheckRow(props: {
  check: ReviewCheck;
  variant: "card" | "inspector";
}): ReactElement {
  const subtitle = props.check.description ?? props.check.workflow ?? null;
  const isInspector = props.variant === "inspector";
  const content = (
    <>
      <span className="inline-flex w-5 shrink-0 items-center justify-center self-stretch">
        <CheckStateIcon
          state={props.check.state}
          className={isInspector ? "size-3.5" : "size-4"}
        />
      </span>
      <div className="min-w-0 self-center">
        <div
          className={cn(
            "grid min-w-0 items-baseline gap-2",
            isInspector
              ? "grid-cols-[minmax(0,1fr)_5.75rem]"
              : "grid-cols-[minmax(0,1fr)_5.5rem]",
          )}
        >
          <p
            className={cn(
              "min-w-0 truncate font-medium text-foreground",
              isInspector ? "text-[12px]" : "text-[12.5px]",
            )}
            title={props.check.name}
          >
            {props.check.name}
          </p>
          <p
            className={cn(
              "justify-self-end whitespace-nowrap text-right text-muted-foreground/75",
              isInspector ? "text-[10.5px]" : "text-[10px]",
            )}
          >
            {checkStateLabel(props.check.state)}
          </p>
        </div>
        {subtitle ? (
          <p
            className={cn(
              "truncate text-muted-foreground/75",
              isInspector ? "mt-1 text-[10.5px]" : "mt-0.5 text-[10.5px]",
            )}
            title={subtitle}
          >
            {subtitle}
          </p>
        ) : null}
      </div>
      {props.check.url ? (
        <ArrowUpRightIcon
          className="size-3.5 shrink-0 self-center text-muted-foreground/70"
          aria-hidden="true"
        />
      ) : null}
    </>
  );
  const className = cn(
    "grid min-w-0 outline-none transition-colors",
    props.variant === "card"
      ? cn(
          "min-h-12 grid-cols-[1.25rem_minmax(0,1fr)_0.875rem] gap-2 rounded-lg border px-2.5 py-2",
          ROW_TONE_CLASS[props.check.state],
        )
      : cn(
          "min-h-12 grid-cols-[1.25rem_minmax(0,1fr)_0.875rem] gap-2 rounded-md px-2 py-2.5",
          props.check.state === "failure" && "bg-destructive/10",
          props.check.state === "pending" && "bg-warning/10",
        ),
    props.check.url &&
      "hover:bg-muted/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
  );
  if (!props.check.url) {
    return <div className={className}>{content}</div>;
  }
  return (
    <a
      href={props.check.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${props.check.name} check details in a new tab`}
      className={className}
    >
      {content}
    </a>
  );
}

export function ReviewPrSidebarChecksPanel(props: {
  checks: ReadonlyArray<ReviewCheck>;
  checksStatus: ReviewChecksStatus;
  className?: string;
  maxRowsClassName?: string;
  variant?: "card" | "inspector";
}): ReactElement {
  const summary = summarizeReviewChecks(props.checks);
  const tone = reviewChecksTone(summary, props.checksStatus);
  const orderedChecks = sortChecks(props.checks);
  const variant = props.variant ?? "card";

  if (variant === "inspector") {
    return (
      <section className={cn("flex min-h-0 flex-col", props.className)}>
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-medium text-[12px] text-foreground">Checks</h3>
            <p className={cn("mt-0.5 text-[12px] tabular-nums", SUMMARY_TONE_CLASS[tone])}>
              {reviewChecksHeadline(summary, props.checksStatus)}
            </p>
          </div>
          {summary.total > 0 ? (
            <div className="shrink-0 rounded-full border border-border/28 bg-muted/16 px-2 py-0.5 font-medium text-[11px] text-foreground tabular-nums">
              {summary.passed}/{summary.total}
            </div>
          ) : null}
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground/75">
          {reviewChecksDetail(summary, props.checksStatus)}
        </p>

        {orderedChecks.length > 0 ? (
          <ul
            className={cn(
              "mt-3 flex min-h-0 scroll-pb-2 flex-col overflow-y-auto pb-1 pr-2 [scrollbar-gutter:stable]",
              props.maxRowsClassName ?? "max-h-56",
            )}
            role="list"
          >
            {orderedChecks.map((check) => (
              <li
                key={`${check.name}:${check.workflow ?? ""}:${check.url ?? ""}`}
                className="min-w-0 border-t border-border/18 first:border-t-0"
              >
                <CheckRow check={check} variant={variant} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    );
  }

  return (
    <section className={cn("flex min-h-0 flex-col gap-2", props.className)}>
      <div className={cn("rounded-lg border px-3 py-3", PANEL_TONE_CLASS[tone])}>
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-medium text-[11px] text-muted-foreground">Checks</h3>
            <p
              className={cn(
                "mt-1 font-semibold text-[15px] tabular-nums",
                SUMMARY_TONE_CLASS[tone],
              )}
            >
              {reviewChecksHeadline(summary, props.checksStatus)}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground/75">
              {reviewChecksDetail(summary, props.checksStatus)}
            </p>
          </div>
          {summary.total > 0 ? (
            <div className="shrink-0 rounded-full border border-border/30 bg-background/34 px-2 py-1 font-medium text-[11px] text-foreground tabular-nums">
              {summary.passed}/{summary.total}
            </div>
          ) : null}
        </div>
        {summary.total > 0 ? (
          <dl className="mt-3 grid grid-cols-3 divide-x divide-border/25 overflow-hidden rounded-lg border border-border/24 bg-background/22">
            <CheckStat label="Failed" value={summary.failing} />
            <CheckStat label="Running" value={summary.running} />
            <CheckStat label="Passed" value={summary.passed} />
          </dl>
        ) : null}
      </div>

      {orderedChecks.length > 0 ? (
        <ul
          className={cn(
            "flex min-h-0 scroll-pb-2 flex-col gap-1 overflow-y-auto pb-1 pr-2 [scrollbar-gutter:stable]",
            props.maxRowsClassName ?? "max-h-56",
          )}
          role="list"
        >
          {orderedChecks.map((check) => (
            <li
              key={`${check.name}:${check.workflow ?? ""}:${check.url ?? ""}`}
              className="min-w-0"
            >
              <CheckRow check={check} variant={variant} />
            </li>
          ))}
        </ul>
      ) : summary.total === 0 ? (
        <EmptyState icon={<CircleCheckIcon />} title="No checks">
          No CI checks reported for this pull request.
        </EmptyState>
      ) : null}
    </section>
  );
}
