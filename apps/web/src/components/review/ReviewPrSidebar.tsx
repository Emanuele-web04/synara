import type {
  ReviewCheck,
  ReviewSourceRef,
  ReviewTargetKey,
  ReviewTimelineEvent,
  ThreadId,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { BotIcon, PanelRightCloseIcon, SidebarHiddenRightWideIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ReviewPrSidebarInfoPanel, type ReviewSidebarDetail } from "./ReviewPrSidebarInfo";
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
  detail: ReviewSidebarDetail;
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
        className="hidden h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-border/30 bg-background xl:flex"
        style={{ width: resize.width }}
      >
        <SidebarTabbedHeader
          activeTab={activeTab}
          onTabChange={setActiveTab}
          collapsed={collapsed}
          onCollapsedChange={props.onCollapsedChange}
        />
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
            activeTab === "info" ? "flex" : "hidden",
          )}
        >
          <ReviewPrSidebarInfoPanel
            detail={props.detail}
            checks={props.checks}
            events={events}
            mode={mode}
          />
        </div>
        <div
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
            activeTab === "chat" ? "flex" : "hidden",
          )}
        >
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
