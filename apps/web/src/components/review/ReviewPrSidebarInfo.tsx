import type {
  ReviewCheck,
  ReviewPullRequestDetail,
  ReviewPullRequestHeaderDetail,
  ReviewTimelineEvent,
} from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";

import { GitCommitIcon, MessageCircleIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { LabelPill, ReviewAvatar, reviewerStatePill } from "./reviewPrPrimitives";
import {
  ReviewPrSidebarChecksPanel,
  type ChecksTone,
  reviewChecksDetail,
  reviewChecksHeadline,
  reviewChecksTone,
  summarizeReviewChecks,
} from "./ReviewPrSidebarChecksPanel";
import {
  type ReviewPillTone,
  ReviewPill,
  formatRelativeReviewTime,
  reviewDecisionPill,
} from "./reviewPrimitives";

export type ReviewSidebarDetail = ReviewPullRequestDetail | ReviewPullRequestHeaderDetail;

type ReviewPrSidebarInfoPanelProps = {
  detail: ReviewSidebarDetail;
  checks: ReadonlyArray<ReviewCheck>;
  events: ReadonlyArray<ReviewTimelineEvent>;
  mode: "conversation" | "files";
};

type SidebarCounts = {
  readonly commits: string;
  readonly comments: number;
  readonly reviews: number;
};

type ReadinessTone = "danger" | "warning" | "success" | "muted";

type ReadinessState = {
  readonly title: string;
  readonly description: string;
  readonly tone: ReadinessTone;
};

type LedgerRowData = {
  readonly key: "checks" | "review" | "merge";
  readonly label: string;
  readonly value: ReactNode;
  readonly description: ReactNode;
  readonly tone: ReadinessTone;
  readonly trailing?: ReactNode;
};

const MERGEABLE_LABEL: Record<ReviewSidebarDetail["mergeable"], string> = {
  MERGEABLE: "Clean",
  CONFLICTING: "Has conflicts",
  UNKNOWN: "Mergeability unknown",
};

const READINESS_CLASS: Record<ReadinessTone, string> = {
  danger: "border-destructive/24 bg-destructive/6",
  warning: "border-warning/24 bg-warning/6",
  success: "border-success/24 bg-success/6",
  muted: "border-border/24 bg-muted/10",
};

const READINESS_DOT_CLASS: Record<ReadinessTone, string> = {
  danger: "bg-destructive",
  warning: "bg-warning",
  success: "bg-success",
  muted: "bg-muted-foreground/55",
};

const CHECK_TONE_TO_PILL_TONE: Record<ChecksTone, ReadinessTone> = {
  danger: "danger",
  warning: "warning",
  success: "success",
  muted: "muted",
};

function sidebarCounts(
  detail: ReviewSidebarDetail,
  events: ReadonlyArray<ReviewTimelineEvent>,
): SidebarCounts {
  let comments = 0;
  let reviews = 0;
  for (const event of events) {
    if (event._tag === "comment") {
      comments += 1;
    } else if (event._tag === "review") {
      reviews += 1;
    }
  }
  return {
    commits: detail.commitsCount === undefined ? "Syncing" : String(detail.commitsCount),
    comments,
    reviews,
  };
}

function readinessState(
  detail: ReviewSidebarDetail,
  checks: ReadonlyArray<ReviewCheck>,
): ReadinessState {
  const checksSummary = summarizeReviewChecks(checks);
  const checksTone = reviewChecksTone(checksSummary, detail.checksStatus);
  if (checksTone === "danger") {
    return {
      title: "Blocked by checks",
      description: reviewChecksDetail(checksSummary, detail.checksStatus),
      tone: "danger",
    };
  }
  if (detail.mergeable === "CONFLICTING") {
    return {
      title: "Merge conflicts",
      description: "Resolve conflicts before merging.",
      tone: "danger",
    };
  }
  if (detail.reviewDecision === "CHANGES_REQUESTED") {
    return {
      title: "Changes requested",
      description: "Address requested changes.",
      tone: "warning",
    };
  }
  if (checksTone === "warning") {
    return {
      title: "Checks in progress",
      description: reviewChecksDetail(checksSummary, detail.checksStatus),
      tone: "warning",
    };
  }
  if (detail.reviewDecision === "APPROVED" && detail.mergeable === "MERGEABLE") {
    return {
      title: "Ready to merge",
      description: "Approved with no conflicts.",
      tone: "success",
    };
  }
  return {
    title: detail.isDraft ? "Draft PR" : "Review open",
    description: detail.isDraft ? "Not ready for review yet." : "No blocking status found.",
    tone: "muted",
  };
}

function InspectorSection(props: {
  title: string;
  children: ReactNode;
  className?: string;
  trailing?: ReactNode;
}): ReactElement {
  return (
    <section className={cn("min-w-0 border-t border-border/24 px-4 py-3", props.className)}>
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <h3 className="truncate font-medium text-[11px] text-muted-foreground">{props.title}</h3>
        {props.trailing}
      </div>
      {props.children}
    </section>
  );
}

function LineDelta(props: { detail: ReviewSidebarDetail; compact?: boolean }): ReactElement {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 overflow-hidden",
        props.compact ? "text-[11px] text-muted-foreground" : "text-[12px] text-foreground",
      )}
    >
      <span className="truncate text-muted-foreground">Lines</span>
      <span className="ms-auto shrink-0 text-success-foreground tabular-nums">
        +{props.detail.additions}
      </span>
      <span className="shrink-0 text-destructive tabular-nums">-{props.detail.deletions}</span>
    </div>
  );
}

function ReadinessHeader(props: {
  detail: ReviewSidebarDetail;
  checks: ReadonlyArray<ReviewCheck>;
  variant?: "hero" | "compact";
  showPills?: boolean;
}): ReactElement {
  const state = readinessState(props.detail, props.checks);
  const decision = reviewDecisionPill(props.detail.reviewDecision);
  const checksSummary = summarizeReviewChecks(props.checks);
  const checksTone = reviewChecksTone(checksSummary, props.detail.checksStatus);
  const checkLabel = reviewChecksHeadline(checksSummary, props.detail.checksStatus);
  const mergeTone = props.detail.mergeable === "CONFLICTING" ? "danger" : "muted";
  const showPills = props.showPills ?? props.variant !== "compact";

  return (
    <section
      aria-label="Pull request readiness"
      className={cn(
        "border-b px-4 py-3.5",
        READINESS_CLASS[state.tone],
        props.variant === "compact" && "py-3",
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          className={cn("mt-1.5 size-2 shrink-0 rounded-full", READINESS_DOT_CLASS[state.tone])}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-[14px] text-foreground">{state.title}</p>
          <p className="mt-0.5 text-[12px] text-muted-foreground/82">{state.description}</p>
        </div>
        <ReviewerAvatarStack detail={props.detail} className="pt-0.5" presentation="informative" />
      </div>
      {showPills ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <ReviewPill tone={CHECK_TONE_TO_PILL_TONE[checksTone]}>{checkLabel}</ReviewPill>
          {decision ? <ReviewPill tone={decision.tone}>{decision.label}</ReviewPill> : null}
          <ReviewPill tone={mergeTone}>{MERGEABLE_LABEL[props.detail.mergeable]}</ReviewPill>
        </div>
      ) : null}
    </section>
  );
}

function DetailRow(props: { label: string; value: ReactNode; icon?: ReactNode }): ReactElement {
  return (
    <div className="flex min-h-7 min-w-0 items-center justify-between gap-3 text-[12px]">
      <dt className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {props.icon ? (
          <span className="inline-flex size-3.5 shrink-0 items-center justify-center opacity-75">
            {props.icon}
          </span>
        ) : null}
        <span className="truncate">{props.label}</span>
      </dt>
      <dd className="min-w-0 truncate text-right text-foreground tabular-nums">{props.value}</dd>
    </div>
  );
}

function DetailsLedger(props: {
  detail: ReviewSidebarDetail;
  events: ReadonlyArray<ReviewTimelineEvent>;
}): ReactElement {
  const created = formatRelativeReviewTime(props.detail.createdAt);
  const updated = formatRelativeReviewTime(props.detail.updatedAt);
  const counts = sidebarCounts(props.detail, props.events);

  return (
    <dl className="flex flex-col gap-1">
      {created ? <DetailRow label="Created" value={created} /> : null}
      {updated ? <DetailRow label="Updated" value={updated} /> : null}
      <DetailRow label="Commits" value={counts.commits} icon={<GitCommitIcon />} />
      <DetailRow label="Comments" value={counts.comments} icon={<MessageCircleIcon />} />
      <DetailRow label="Reviews" value={counts.reviews} icon={<MessageCircleIcon />} />
    </dl>
  );
}

function ChangeLedger(props: { detail: ReviewSidebarDetail }): ReactElement {
  return (
    <dl className="flex flex-col gap-1">
      <DetailRow label="Files changed" value={props.detail.changedFiles} />
      <DetailRow
        label="Additions"
        value={<span className="text-success-foreground">+{props.detail.additions}</span>}
      />
      <DetailRow
        label="Deletions"
        value={<span className="text-destructive">-{props.detail.deletions}</span>}
      />
    </dl>
  );
}

function participantAvatarEntries(
  detail: ReviewSidebarDetail,
): ReadonlyArray<readonly [login: string, avatarUrl: string | undefined]> {
  const avatarByLogin = new Map<string, string | undefined>();
  if (detail.author.length > 0) {
    avatarByLogin.set(detail.author, detail.authorAvatarUrl);
  }
  for (const reviewer of detail.reviewers ?? []) {
    if (reviewer.login.length > 0 && !avatarByLogin.has(reviewer.login)) {
      avatarByLogin.set(reviewer.login, reviewer.avatarUrl);
    }
  }
  for (const assignee of detail.assignees) {
    if (assignee.login.length > 0 && !avatarByLogin.has(assignee.login)) {
      avatarByLogin.set(assignee.login, assignee.avatarUrl);
    }
  }
  return [...avatarByLogin.entries()];
}

function reviewerSummary(detail: ReviewSidebarDetail): string {
  const reviewers = detail.reviewers ?? [];
  if (reviewers.length === 0) {
    return "No reviewers requested";
  }
  const changesRequested = reviewers.filter((reviewer) => reviewer.state === "CHANGES_REQUESTED");
  if (changesRequested.length > 0) {
    return `${changesRequested.length} change${changesRequested.length === 1 ? "" : "s"} requested`;
  }
  const requested = reviewers.filter((reviewer) => reviewer.state === "REVIEW_REQUIRED");
  if (requested.length > 0) {
    return `${requested.length} reviewer${requested.length === 1 ? "" : "s"} requested`;
  }
  const approved = reviewers.filter((reviewer) => reviewer.state === "APPROVED");
  if (approved.length > 0) {
    return `${approved.length}/${reviewers.length} approved`;
  }
  return `${reviewers.length} reviewer${reviewers.length === 1 ? "" : "s"}`;
}

function ReviewerAvatarStack(props: {
  detail: ReviewSidebarDetail;
  className?: string;
  size?: "sm" | "md";
  presentation?: "decorative" | "informative";
}): ReactElement | null {
  const reviewers = props.detail.reviewers ?? [];
  if (reviewers.length === 0) {
    return null;
  }
  const visibleReviewers = reviewers.slice(0, 4);
  const hiddenCount = reviewers.length - visibleReviewers.length;
  const informative = props.presentation !== "decorative";
  const label = `Reviewers: ${reviewers.map((reviewer) => reviewer.login).join(", ")}`;
  return (
    <div
      className={cn("flex shrink-0 items-center -space-x-1", props.className)}
      role={informative ? "img" : undefined}
      aria-label={informative ? label : undefined}
      aria-hidden={informative ? undefined : true}
      title={label}
    >
      {visibleReviewers.map((reviewer) => (
        <ReviewAvatar
          key={reviewer.login}
          login={reviewer.login}
          {...(reviewer.avatarUrl !== undefined ? { avatarUrl: reviewer.avatarUrl } : {})}
          className={cn(
            "border-background ring-1 ring-border/50",
            props.size === "md" ? "size-6" : "size-5",
          )}
          presentation="decorative"
        />
      ))}
      {hiddenCount > 0 ? (
        <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-background bg-muted font-medium text-[10px] text-muted-foreground ring-1 ring-border/50 tabular-nums">
          +{hiddenCount}
        </span>
      ) : null}
    </div>
  );
}

function ParticipantsAvatars(props: {
  entries: ReadonlyArray<readonly [login: string, avatarUrl: string | undefined]>;
}): ReactElement {
  return (
    <div className="flex max-h-20 min-w-0 flex-wrap items-center gap-1.5 overflow-y-auto pr-1">
      {props.entries.map(([login, avatarUrl]) => (
        <ReviewAvatar
          key={login}
          login={login}
          {...(avatarUrl !== undefined ? { avatarUrl } : {})}
          className="size-6"
          presentation="informative"
        />
      ))}
    </div>
  );
}

function ReviewersList(props: { detail: ReviewSidebarDetail }): ReactElement | null {
  if ((props.detail.reviewers ?? []).length === 0) {
    return null;
  }
  return (
    <ul className="flex max-h-48 flex-col gap-1.5 overflow-y-auto pr-1" role="list">
      {(props.detail.reviewers ?? []).map((reviewer) => {
        const pill = reviewerStatePill(reviewer.state);
        return (
          <li
            key={reviewer.login}
            className="grid min-h-8 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-[13px]"
          >
            <ReviewAvatar
              login={reviewer.login}
              {...(reviewer.avatarUrl !== undefined ? { avatarUrl: reviewer.avatarUrl } : {})}
              className="size-6"
              presentation="decorative"
            />
            <span className="min-w-0 flex-1 truncate text-foreground">{reviewer.login}</span>
            <span className="shrink-0">
              <ReviewPill tone={pill.tone}>{pill.label}</ReviewPill>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function PeopleSection(props: { detail: ReviewSidebarDetail }): ReactElement | null {
  const participants = participantAvatarEntries(props.detail);
  const hasReviewers = (props.detail.reviewers ?? []).length > 0;
  if (participants.length === 0 && !hasReviewers) {
    return null;
  }
  return (
    <InspectorSection title="Reviewers">
      <div className="flex flex-col gap-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-medium text-[12px] text-foreground">
              {reviewerSummary(props.detail)}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground/78">
              {participants.length} participant{participants.length === 1 ? "" : "s"}
            </p>
          </div>
          <ReviewerAvatarStack detail={props.detail} size="md" presentation="informative" />
        </div>
        {hasReviewers ? (
          <ReviewersList detail={props.detail} />
        ) : (
          <p className="text-[12px] text-muted-foreground/78">No reviewers requested</p>
        )}
        {participants.length > 0 ? <ParticipantsAvatars entries={participants} /> : null}
      </div>
    </InspectorSection>
  );
}

function MetadataSection(props: { detail: ReviewSidebarDetail }): ReactElement | null {
  const hasLabels = props.detail.labels.length > 0;
  const hasAssignees = props.detail.assignees.length > 0;
  const hasMilestone = props.detail.milestone !== null;
  if (!hasLabels && !hasAssignees && !hasMilestone) {
    return null;
  }
  return (
    <InspectorSection title="Metadata">
      <div className="flex flex-col gap-2.5">
        {hasLabels ? (
          <ul className="flex max-h-24 min-w-0 flex-wrap gap-1 overflow-y-auto pr-1" role="list">
            {props.detail.labels.map((label) => (
              <li key={label.name} className="min-w-0 max-w-full">
                <LabelPill name={label.name} color={label.color} className="max-w-full truncate" />
              </li>
            ))}
          </ul>
        ) : null}
        {hasAssignees ? (
          <ul className="flex flex-col gap-1.5" role="list">
            {props.detail.assignees.map((assignee) => (
              <li
                key={assignee.login}
                className="flex min-h-7 min-w-0 items-center gap-1.5 text-[12px]"
              >
                <ReviewAvatar
                  login={assignee.login}
                  {...(assignee.avatarUrl !== undefined ? { avatarUrl: assignee.avatarUrl } : {})}
                  className="size-5"
                  presentation="decorative"
                />
                <span className="min-w-0 truncate text-foreground">{assignee.login}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {props.detail.milestone ? (
          <p className="truncate text-[12px] text-foreground">{props.detail.milestone}</p>
        ) : null}
      </div>
    </InspectorSection>
  );
}

function CursorLedgerPanel(props: ReviewPrSidebarInfoPanelProps): ReactElement {
  const ledgerRows = readinessLedgerRows(props.detail, props.checks);

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
      <ReadinessHeader detail={props.detail} checks={props.checks} variant="compact" />
      <div className="px-4 py-3">
        <dl className="overflow-hidden rounded-md border border-border/24">
          {ledgerRows.map((row) => (
            <LedgerRow {...row} key={row.key} />
          ))}
        </dl>
      </div>
      <div className="min-w-0 px-4 pb-3">
        <ReviewPrSidebarChecksPanel
          checks={props.checks}
          checksStatus={props.detail.checksStatus}
          maxRowsClassName={props.mode === "files" ? "max-h-56" : "max-h-72"}
          variant="inspector"
        />
      </div>
      <PeopleSection detail={props.detail} />
      <InspectorSection title="Activity">
        <div className="flex flex-col gap-2.5">
          <ChangeLedger detail={props.detail} />
          <LineDelta detail={props.detail} />
          <DetailsLedger detail={props.detail} events={props.events} />
        </div>
      </InspectorSection>
      <MetadataSection detail={props.detail} />
    </div>
  );
}

function ReviewerRailPanel(props: ReviewPrSidebarInfoPanelProps): ReactElement {
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
      <ReadinessHeader detail={props.detail} checks={props.checks} variant="compact" />
      <InspectorSection title="Reviewers" className="border-t-0">
        <div className="flex flex-col gap-3">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium text-[12px] text-foreground">
                {reviewerSummary(props.detail)}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground/78">
                Review ownership
              </p>
            </div>
            <ReviewerAvatarStack detail={props.detail} size="md" presentation="informative" />
          </div>
          <ReviewersList detail={props.detail} />
        </div>
      </InspectorSection>
      <div className="px-4 py-3">
        <dl className="overflow-hidden rounded-md border border-border/24">
          {readinessLedgerRows(props.detail, props.checks).map((row) => (
            <LedgerRow {...row} key={row.key} />
          ))}
        </dl>
      </div>
      <div className="min-w-0 px-4 pb-3">
        <ReviewPrSidebarChecksPanel
          checks={props.checks}
          checksStatus={props.detail.checksStatus}
          maxRowsClassName={props.mode === "files" ? "max-h-48" : "max-h-64"}
          variant="inspector"
        />
      </div>
      <InspectorSection title="Activity">
        <div className="flex flex-col gap-2.5">
          <ChangeLedger detail={props.detail} />
          <DetailsLedger detail={props.detail} events={props.events} />
        </div>
      </InspectorSection>
      <MetadataSection detail={props.detail} />
    </div>
  );
}

function FailureFirstPanel(props: ReviewPrSidebarInfoPanelProps): ReactElement {
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
      <ReadinessHeader detail={props.detail} checks={props.checks} variant="compact" />
      <div className="min-w-0 px-4 py-3">
        <ReviewPrSidebarChecksPanel
          checks={props.checks}
          checksStatus={props.detail.checksStatus}
          maxRowsClassName={props.mode === "files" ? "max-h-64" : "max-h-80"}
          variant="inspector"
        />
      </div>
      <div className="px-4 pb-3">
        <dl className="overflow-hidden rounded-md border border-border/24">
          {readinessLedgerRows(props.detail, props.checks).map((row) => (
            <LedgerRow {...row} key={row.key} />
          ))}
        </dl>
      </div>
      <PeopleSection detail={props.detail} />
      <InspectorSection title="Activity">
        <DetailsLedger detail={props.detail} events={props.events} />
      </InspectorSection>
    </div>
  );
}

function LedgerRow(props: {
  label: string;
  value: ReactNode;
  description: ReactNode;
  tone: ReadinessTone;
  trailing?: ReactNode;
}): ReactElement {
  return (
    <div className="grid min-h-[52px] grid-cols-[4rem_minmax(0,1fr)] gap-3 border-t border-border/20 px-3 py-2 first:border-t-0">
      <dt className="truncate pt-0.5 font-medium text-[11px] text-muted-foreground">
        {props.label}
      </dt>
      <dd className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn("size-1.5 shrink-0 rounded-full", READINESS_DOT_CLASS[props.tone])}
            aria-hidden="true"
          />
          <p className="min-w-0 truncate font-medium text-[12px] text-foreground">{props.value}</p>
          {props.trailing ? <div className="ms-auto shrink-0">{props.trailing}</div> : null}
        </div>
        <div className="mt-0.5 min-w-0 break-words text-[11px] text-muted-foreground/78 [overflow-wrap:anywhere]">
          {props.description}
        </div>
      </dd>
    </div>
  );
}

function ledgerToneFromPillTone(tone: ReviewPillTone): ReadinessTone {
  if (tone === "danger" || tone === "warning" || tone === "success") {
    return tone;
  }
  return "muted";
}

function readinessLedgerRows(
  detail: ReviewSidebarDetail,
  checks: ReadonlyArray<ReviewCheck>,
): ReadonlyArray<LedgerRowData> {
  const checksSummary = summarizeReviewChecks(checks);
  const checksTone = reviewChecksTone(checksSummary, detail.checksStatus);
  const decision = reviewDecisionPill(detail.reviewDecision);
  const rows: ReadonlyArray<LedgerRowData> = [
    {
      key: "checks",
      label: "CI",
      value: reviewChecksHeadline(checksSummary, detail.checksStatus),
      tone: CHECK_TONE_TO_PILL_TONE[checksTone],
      description: reviewChecksDetail(checksSummary, detail.checksStatus),
    },
    {
      key: "review",
      label: "Review",
      value: decision?.label ?? "Not reviewed",
      tone: ledgerToneFromPillTone(decision?.tone ?? "muted"),
      description: reviewerSummary(detail),
      trailing: <ReviewerAvatarStack detail={detail} presentation="informative" />,
    },
    {
      key: "merge",
      label: "Branch",
      value: MERGEABLE_LABEL[detail.mergeable],
      tone: detail.mergeable === "CONFLICTING" ? "danger" : "muted",
      description:
        detail.mergeable === "CONFLICTING"
          ? "Conflicts must be resolved"
          : detail.mergeable === "UNKNOWN"
            ? "GitHub is still checking"
            : "Branch can merge cleanly",
    },
  ];
  const priorityKey =
    checksTone === "danger" || checksTone === "warning"
      ? "checks"
      : detail.mergeable === "CONFLICTING"
        ? "merge"
        : detail.reviewDecision === "CHANGES_REQUESTED"
          ? "review"
          : "checks";
  return [...rows].sort((left, right) => {
    if (left.key === priorityKey) {
      return -1;
    }
    if (right.key === priorityKey) {
      return 1;
    }
    return 0;
  });
}

export function ReviewPrSidebarInfoPanel(props: ReviewPrSidebarInfoPanelProps): ReactElement {
  return (
    <div data-uidotsh-pick="Sidebar info layout" className="contents">
      <div data-uidotsh-option="Cursor ledger (current)" className="contents">
        <CursorLedgerPanel {...props} />
      </div>
      <div data-uidotsh-option="Reviewer rail" className="contents" hidden>
        <ReviewerRailPanel {...props} />
      </div>
      <div data-uidotsh-option="Failure first" className="contents" hidden>
        <FailureFirstPanel {...props} />
      </div>
    </div>
  );
}
