import type {
  ReviewCheck,
  ReviewPullRequestDetail,
  ReviewSourceRef,
  ReviewTargetKey,
  ReviewTimelineEvent,
  ThreadId,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  BotIcon,
  GitCommitIcon,
  MessageCircleIcon,
  PanelRightCloseIcon,
  SidebarHiddenRightWideIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  CheckStateIcon,
  checkStateLabel,
  LabelPill,
  ReviewAvatar,
  reviewerStatePill,
} from "./reviewPrPrimitives";
import { ReviewPill, formatRelativeReviewTime, reviewDecisionPill } from "./reviewPrimitives";
import { ReviewSidechat } from "./ReviewSidechat";
import type { ReviewSidechatContextPayload } from "./reviewSidechatContext";
import { useResizableReviewSidebar } from "./useResizableReviewSidebar";

type ReviewSidebarTab = "info" | "chat";

const REVIEW_AGENT_SIDEBAR_WIDTH_BY_MODE = {
  conversation: { min: 288, max: 520, default: 360 },
  files: { min: 320, max: 620, default: 432 },
} as const;

function agentSidebarWidthStorageKey(mode: "conversation" | "files"): string {
  return `review:agent-sidebar-width:${mode}`;
}

function sidebarMidpointMaxWidth(
  containerWidth: number | null,
  fallbackMax: number,
  min: number,
): number {
  if (containerWidth === null || containerWidth <= 0) {
    return fallbackMax;
  }
  return Math.max(min, Math.floor(containerWidth / 2));
}

function defaultSidebarTab(mode: "conversation" | "files"): ReviewSidebarTab {
  return mode === "files" ? "info" : "chat";
}

function SidebarSection(props: {
  title: string;
  trailing?: ReactNode;
  children: ReactNode;
  className?: string;
  framed?: boolean;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-2",
        props.framed && "border-t border-border/25 px-3.5 py-3 first:border-t-0",
        props.className,
      )}
    >
      <h3 className="flex items-center justify-between gap-2 font-semibold text-[10px] text-muted-foreground/82 uppercase tracking-wide">
        <span>{props.title}</span>
        {props.trailing}
      </h3>
      {props.children}
    </section>
  );
}

function EmptyLine(props: { children: ReactNode }) {
  return <p className="text-[12px] leading-relaxed text-muted-foreground/80">{props.children}</p>;
}

const MERGEABLE_LABEL: Record<ReviewPullRequestDetail["mergeable"], string> = {
  MERGEABLE: "No conflicts",
  CONFLICTING: "Has conflicts",
  UNKNOWN: "Mergeability unknown",
};

const PASSING_CHECK_STATES = new Set(["success", "skipped", "neutral"]);
const FAILING_CHECK_STATES = new Set(["failure", "cancelled"]);

function ChecksSection(props: { checks: ReadonlyArray<ReviewCheck>; compact?: boolean }) {
  if (props.checks.length === 0) {
    return (
      <SidebarSection title="Checks">
        <EmptyLine>No CI checks</EmptyLine>
      </SidebarSection>
    );
  }
  const total = props.checks.length;
  const passed = props.checks.filter((check) => PASSING_CHECK_STATES.has(check.state)).length;
  return (
    <SidebarSection
      title="Checks"
      framed={!props.compact}
      trailing={
        <span className="font-normal text-[12px] text-muted-foreground tabular-nums">
          {passed}/{total}
        </span>
      }
    >
      <ul className={cn("flex flex-col gap-1.5", props.compact && "max-h-40 overflow-y-auto pe-1")}>
        {props.checks.map((check) => {
          const content = (
            <>
              <CheckStateIcon state={check.state} />
              <span className="min-w-0 flex-1 truncate" title={check.name}>
                {check.name}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground/75">
                {checkStateLabel(check.state)}
              </span>
            </>
          );
          return (
            <li
              key={`${check.name}:${check.workflow ?? ""}:${check.url ?? ""}`}
              className="min-w-0"
            >
              {check.url ? (
                <a
                  href={check.url}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(
                    "flex min-h-7 min-w-0 items-center gap-2 rounded-xl px-2 text-foreground outline-none transition-colors hover:bg-muted/22 focus-visible:ring-2 focus-visible:ring-ring",
                    props.compact ? "text-[11.5px]" : "text-[12px]",
                  )}
                >
                  {content}
                </a>
              ) : (
                <div
                  className={cn(
                    "flex min-h-7 min-w-0 items-center gap-2 rounded-xl px-2 text-foreground",
                    props.compact ? "text-[11.5px]" : "text-[12px]",
                  )}
                >
                  {content}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </SidebarSection>
  );
}

function ParticipantsSection(props: { detail: ReviewPullRequestDetail }) {
  const { detail } = props;
  const avatarByLogin = new Map<string, string | undefined>();
  if (detail.author.length > 0) {
    avatarByLogin.set(detail.author, detail.authorAvatarUrl);
  }
  for (const reviewer of detail.reviewers) {
    if (reviewer.login.length > 0 && !avatarByLogin.has(reviewer.login)) {
      avatarByLogin.set(reviewer.login, reviewer.avatarUrl);
    }
  }
  for (const assignee of detail.assignees) {
    if (assignee.login.length > 0 && !avatarByLogin.has(assignee.login)) {
      avatarByLogin.set(assignee.login, assignee.avatarUrl);
    }
  }
  if (avatarByLogin.size === 0) {
    return null;
  }
  return (
    <SidebarSection title="Participants" framed>
      <div className="flex flex-wrap gap-1.5">
        {[...avatarByLogin.entries()].map(([login, avatarUrl]) => (
          <ReviewAvatar
            key={login}
            login={login}
            {...(avatarUrl !== undefined ? { avatarUrl } : {})}
            className="size-6"
          />
        ))}
      </div>
    </SidebarSection>
  );
}

function DetailRow(props: { label: string; value: string; icon?: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-2">
      <dt className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {props.icon ? (
          <span className="inline-flex size-3.5 shrink-0 items-center justify-center opacity-75">
            {props.icon}
          </span>
        ) : null}
        <span className="truncate">{props.label}</span>
      </dt>
      <dd className="truncate text-foreground tabular-nums">{props.value}</dd>
    </div>
  );
}

function DetailsSection(props: {
  detail: ReviewPullRequestDetail;
  events: ReadonlyArray<ReviewTimelineEvent>;
}) {
  const { detail } = props;
  const created = formatRelativeReviewTime(detail.createdAt);
  const updated = formatRelativeReviewTime(detail.updatedAt);
  const comments = props.events.filter((event) => event._tag === "comment").length;
  const reviews = props.events.filter((event) => event._tag === "review").length;
  return (
    <SidebarSection title="Details" framed>
      <dl className="flex flex-col gap-1.5 text-[12px]">
        {created ? <DetailRow label="Created" value={created} /> : null}
        {updated ? <DetailRow label="Updated" value={updated} /> : null}
        <DetailRow label="Commits" value={String(detail.commitsCount)} icon={<GitCommitIcon />} />
        <DetailRow label="Comments" value={String(comments)} icon={<MessageCircleIcon />} />
        <DetailRow label="Reviews" value={String(reviews)} icon={<MessageCircleIcon />} />
      </dl>
    </SidebarSection>
  );
}

function SidebarUtilityStack(props: {
  detail: ReviewPullRequestDetail;
  events: ReadonlyArray<ReviewTimelineEvent>;
}) {
  const { detail } = props;
  const decision = reviewDecisionPill(detail.reviewDecision);

  return (
    <div className="flex min-h-0 flex-col overflow-y-auto">
      <SidebarSection title="Changes" framed>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">{detail.changedFiles}</span>
          files
          <span className="text-success-foreground tabular-nums">+{detail.additions}</span>
          <span className="text-destructive tabular-nums">-{detail.deletions}</span>
        </div>
      </SidebarSection>

      <SidebarSection title="Status" framed>
        <div className="flex flex-col gap-1.5">
          {decision ? (
            <ReviewPill tone={decision.tone} className="self-start">
              {decision.label}
            </ReviewPill>
          ) : null}
          <span
            className={cn(
              "text-[11px]",
              detail.mergeable === "CONFLICTING" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {MERGEABLE_LABEL[detail.mergeable]}
          </span>
        </div>
      </SidebarSection>

      <ParticipantsSection detail={detail} />

      <DetailsSection detail={detail} events={props.events} />

      {detail.reviewers.length > 0 ? (
        <SidebarSection title="Reviewers" framed>
          <ul className="flex flex-col gap-2">
            {detail.reviewers.map((reviewer) => {
              const pill = reviewerStatePill(reviewer.state);
              return (
                <li
                  key={reviewer.login}
                  className="flex min-h-8 min-w-0 items-center gap-2 text-[13px]"
                >
                  <ReviewAvatar
                    login={reviewer.login}
                    {...(reviewer.avatarUrl !== undefined ? { avatarUrl: reviewer.avatarUrl } : {})}
                    className="size-6"
                  />
                  <span className="min-w-0 flex-1 truncate text-foreground">{reviewer.login}</span>
                  <ReviewPill tone={pill.tone}>{pill.label}</ReviewPill>
                </li>
              );
            })}
          </ul>
        </SidebarSection>
      ) : null}

      {detail.labels.length > 0 ? (
        <SidebarSection title="Labels" framed>
          <div className="flex flex-wrap gap-1">
            {detail.labels.map((label) => (
              <LabelPill key={label.name} name={label.name} color={label.color} />
            ))}
          </div>
        </SidebarSection>
      ) : null}

      {detail.assignees.length > 0 ? (
        <SidebarSection title="Assignees" framed>
          <ul className="flex flex-col gap-1.5">
            {detail.assignees.map((assignee) => (
              <li
                key={assignee.login}
                className="flex min-h-7 min-w-0 items-center gap-1.5 text-[11px]"
              >
                <ReviewAvatar
                  login={assignee.login}
                  {...(assignee.avatarUrl !== undefined ? { avatarUrl: assignee.avatarUrl } : {})}
                />
                <span className="min-w-0 truncate text-foreground">{assignee.login}</span>
              </li>
            ))}
          </ul>
        </SidebarSection>
      ) : null}

      {detail.milestone ? (
        <SidebarSection title="Milestone" framed>
          <p className="text-[11px] text-foreground">{detail.milestone}</p>
        </SidebarSection>
      ) : null}
    </div>
  );
}

function FilesAnalysisStack(props: { checks: ReadonlyArray<ReviewCheck> }) {
  const total = props.checks.length;
  const passed = props.checks.filter((check) => PASSING_CHECK_STATES.has(check.state)).length;
  const failing = props.checks.filter((check) => FAILING_CHECK_STATES.has(check.state)).length;
  const summary =
    total === 0
      ? "No checks"
      : failing > 0
        ? `${failing} failing`
        : passed === total
          ? "All checks passed"
          : `${passed}/${total} passed`;

  return (
    <div className="flex max-h-[9.5rem] shrink-0 flex-col border-b border-border/25">
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-2.5">
        <div className="min-w-0">
          <p className="font-semibold text-[10px] text-muted-foreground/90 uppercase tracking-wide">
            Checks
          </p>
          <p className="truncate text-[11px] text-muted-foreground/85">{summary}</p>
        </div>
        {total > 0 ? (
          <span
            className={cn(
              "shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-medium tabular-nums",
              failing > 0
                ? "border-destructive/20 bg-destructive/8 text-destructive"
                : "border-success/20 bg-success/10 text-success-foreground",
            )}
          >
            {passed}/{total}
          </span>
        ) : null}
      </div>
      <div className="min-h-0 overflow-y-auto px-2.5 pb-2">
        {props.checks.length === 0 ? (
          <p className="px-1.5 py-1 text-[12px] text-muted-foreground/80">No CI checks</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {props.checks.map((check) => {
              const content = (
                <>
                  <CheckStateIcon state={check.state} />
                  <span className="min-w-0 flex-1 truncate" title={check.name}>
                    {check.name}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/70">
                    {checkStateLabel(check.state)}
                  </span>
                </>
              );
              return (
                <li key={`${check.name}:${check.workflow ?? ""}:${check.url ?? ""}`}>
                  {check.url ? (
                    <a
                      href={check.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-h-7 min-w-0 items-center gap-2 rounded-xl px-1.5 text-[11.5px] text-foreground outline-none transition-colors hover:bg-muted/25 focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {content}
                    </a>
                  ) : (
                    <div className="flex min-h-7 min-w-0 items-center gap-2 rounded-xl px-1.5 text-[11.5px] text-foreground">
                      {content}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function SidebarCollapseButton(props: {
  collapsed: boolean;
  onCollapsedChange: ((collapsed: boolean) => void) | undefined;
}) {
  const Icon = props.collapsed ? SidebarHiddenRightWideIcon : PanelRightCloseIcon;
  return (
    <button
      type="button"
      aria-label={props.collapsed ? "Expand AI chat sidebar" : "Collapse AI chat sidebar"}
      aria-expanded={!props.collapsed}
      title={props.collapsed ? "Expand AI chat sidebar" : "Collapse AI chat sidebar"}
      onClick={() => props.onCollapsedChange?.(!props.collapsed)}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none",
        "transition-[background-color,color,opacity,transform] duration-150 motion-reduce:transition-none",
        "hover:bg-muted/35 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}

function CollapsedSidebarRail(props: {
  mode: "conversation" | "files";
  onCollapsedChange: ((collapsed: boolean) => void) | undefined;
}) {
  return (
    <aside className="hidden h-full min-h-0 w-12 shrink-0 flex-col items-center border-l border-border/30 bg-background py-2 xl:flex">
      <SidebarCollapseButton collapsed onCollapsedChange={props.onCollapsedChange} />
      <div className="mt-3 flex min-h-0 flex-1 flex-col items-center gap-2" aria-hidden="true">
        <span className="flex size-8 items-center justify-center rounded-xl bg-muted/35 text-primary ring-1 ring-border/35">
          <BotIcon className="size-4" />
        </span>
        <span className="size-2 rounded-full bg-success shadow-[0_0_16px_rgba(34,197,94,0.45)]" />
        <span className="mt-1 [writing-mode:vertical-rl] text-[10px] font-semibold text-muted-foreground/75 uppercase tracking-wide">
          {props.mode === "files" ? "Ask Devin" : "AI chat"}
        </span>
      </div>
    </aside>
  );
}

function SidebarTabButton(props: {
  tab: ReviewSidebarTab;
  activeTab: ReviewSidebarTab;
  onSelect: (tab: ReviewSidebarTab) => void;
  children: ReactNode;
}) {
  const active = props.tab === props.activeTab;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={() => props.onSelect(props.tab)}
      className={cn(
        "inline-flex h-8 min-w-0 items-center justify-center rounded-lg px-3 text-[12px] font-medium outline-none",
        "transition-[background-color,color,box-shadow] duration-150 motion-reduce:transition-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-muted/55 text-foreground shadow-[inset_0_0_0_1px_var(--border)]"
          : "text-muted-foreground hover:bg-muted/30 hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

function SidebarTabbedHeader(props: {
  activeTab: ReviewSidebarTab;
  onTabChange: (tab: ReviewSidebarTab) => void;
  collapsed: boolean;
  onCollapsedChange: ((collapsed: boolean) => void) | undefined;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/25 px-3 py-2">
      <div
        role="tablist"
        aria-label="Pull request sidebar"
        className="inline-flex min-w-0 rounded-xl bg-muted/18 p-0.5 ring-1 ring-border/25"
      >
        <SidebarTabButton tab="info" activeTab={props.activeTab} onSelect={props.onTabChange}>
          Info
        </SidebarTabButton>
        <SidebarTabButton tab="chat" activeTab={props.activeTab} onSelect={props.onTabChange}>
          Chat
        </SidebarTabButton>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {props.activeTab === "chat" ? (
          <span
            className="size-2 rounded-full bg-success shadow-[0_0_16px_rgba(34,197,94,0.45)]"
            title="PR context loaded"
          />
        ) : null}
        <SidebarCollapseButton
          collapsed={props.collapsed}
          onCollapsedChange={props.onCollapsedChange}
        />
      </div>
    </div>
  );
}

function SidebarInfoPanel(props: {
  detail: ReviewPullRequestDetail;
  checks: ReadonlyArray<ReviewCheck>;
  events: ReadonlyArray<ReviewTimelineEvent>;
  mode: "conversation" | "files";
}) {
  if (props.mode === "files") {
    return (
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
        <FilesAnalysisStack checks={props.checks} />
        <SidebarUtilityStack detail={props.detail} events={props.events} />
      </div>
    );
  }
  return (
    <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-3.5 py-3">
        <ChecksSection checks={props.checks} compact />
      </div>
      <SidebarUtilityStack detail={props.detail} events={props.events} />
    </div>
  );
}

function ChatPanelHeader(props: { mode: "conversation" | "files" }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/20 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-xl bg-muted/35 text-primary ring-1 ring-border/35">
          <BotIcon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-[13px] text-foreground">Ask Devin</h2>
          <p className="truncate text-[11px] text-muted-foreground">PR context</p>
        </div>
      </div>
      <span className="size-2 rounded-full bg-success shadow-[0_0_16px_rgba(34,197,94,0.45)]" />
    </div>
  );
}

export function ReviewPrSidebar(props: {
  detail: ReviewPullRequestDetail;
  checks: ReadonlyArray<ReviewCheck>;
  events?: ReadonlyArray<ReviewTimelineEvent>;
  mode?: "conversation" | "files";
  cwd?: string | null;
  source?: ReviewSourceRef | null;
  target?: ReviewTargetKey | null;
  sidechatContext: ReviewSidechatContextPayload;
  hostThreadId?: ThreadId | null;
  reviewThreadId?: ThreadId | null;
  sidechatOwnsPrewarm?: boolean;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}) {
  const events = props.events ?? [];
  const mode = props.mode ?? "conversation";
  const collapsed = props.collapsed ?? false;
  const [activeTab, setActiveTab] = useState<ReviewSidebarTab>(() => defaultSidebarTab(mode));
  const sidebarRef = useRef<HTMLElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const baseBounds = REVIEW_AGENT_SIDEBAR_WIDTH_BY_MODE[mode];
  const sidebarBounds = useMemo(
    () => ({
      ...baseBounds,
      max: sidebarMidpointMaxWidth(containerWidth, baseBounds.max, baseBounds.min),
    }),
    [baseBounds, containerWidth],
  );
  const resize = useResizableReviewSidebar({
    bounds: sidebarBounds,
    edge: "left",
    storageKey: agentSidebarWidthStorageKey(mode),
  });

  useEffect(() => {
    if (collapsed) {
      return;
    }
    const sidebar = sidebarRef.current;
    const container = sidebar?.parentElement ?? null;
    if (!container) {
      return;
    }

    const updateContainerWidth = () => {
      setContainerWidth(container.getBoundingClientRect().width);
    };

    updateContainerWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateContainerWidth);
      return () => window.removeEventListener("resize", updateContainerWidth);
    }

    const observer = new ResizeObserver(updateContainerWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, [collapsed]);

  if (collapsed) {
    return <CollapsedSidebarRail mode={mode} onCollapsedChange={props.onCollapsedChange} />;
  }

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize AI chat sidebar"
        aria-valuemin={resize.bounds.min}
        aria-valuemax={resize.bounds.max}
        aria-valuenow={resize.width}
        tabIndex={0}
        onDoubleClick={resize.resetWidth}
        onPointerDown={resize.handleResizeStart}
        onKeyDown={resize.handleResizeKeyDown}
        className={cn(
          "-me-px relative z-10 hidden w-1 shrink-0 cursor-col-resize bg-transparent outline-none xl:block",
          "transition-colors duration-150 hover:bg-[var(--sidebar-accent)] focus-visible:bg-primary/30",
        )}
      />
      <aside
        ref={sidebarRef}
        className="hidden h-full min-h-0 shrink-0 flex-col border-l border-border/30 bg-background xl:flex"
        style={{ width: resize.width }}
      >
        <SidebarTabbedHeader
          activeTab={activeTab}
          onTabChange={setActiveTab}
          collapsed={collapsed}
          onCollapsedChange={props.onCollapsedChange}
        />
        <div className={cn("min-h-0 flex-1 flex-col", activeTab === "info" ? "flex" : "hidden")}>
          <SidebarInfoPanel
            detail={props.detail}
            checks={props.checks}
            events={events}
            mode={mode}
          />
        </div>
        <div className={cn("min-h-0 flex-1 flex-col", activeTab === "chat" ? "flex" : "hidden")}>
          <ReviewSidechat
            context={props.sidechatContext}
            mode={mode}
            cwd={props.cwd ?? undefined}
            hostThreadId={props.hostThreadId ?? null}
            reviewThreadId={props.reviewThreadId ?? null}
            ownsPrewarm={props.sidechatOwnsPrewarm}
            header={<ChatPanelHeader mode={mode} />}
          />
        </div>
      </aside>
    </>
  );
}
