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
import { ReviewRailResizer } from "./reviewPrimitives";
import { ReviewSidechat } from "./ReviewSidechat";
import {
  hasReviewSidechatAgentContext,
  type ReviewSidechatContextPayload,
} from "./reviewSidechatContext";
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

const SIDEBAR_ASSISTANT_LABEL = "Review assistant";

function SidebarStatusDot(props: { ready: boolean; ariaLabel?: string; title?: string }) {
  return (
    <span
      className={cn(
        "size-2 rounded-full ring-1",
        props.ready
          ? "bg-success ring-success/30"
          : "bg-muted-foreground/45 ring-muted-foreground/20",
      )}
      aria-label={props.ariaLabel}
      title={props.title}
    />
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
        "active:scale-[0.96] motion-reduce:active:scale-100",
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
    <aside className="flex h-full min-h-0 w-12 shrink-0 flex-col items-center border-l border-border/60 bg-background py-2">
      <SidebarCollapseButton collapsed onCollapsedChange={props.onCollapsedChange} />
      <div className="mt-3 flex min-h-0 flex-1 flex-col items-center gap-2" aria-hidden="true">
        <span className="flex size-8 items-center justify-center rounded-lg bg-muted/40 text-primary ring-1 ring-border/40">
          <BotIcon className="size-4" />
        </span>
        <SidebarStatusDot ready={false} />
        <span className="mt-1 [writing-mode:vertical-rl] text-[10px] font-semibold text-muted-foreground/75 uppercase tracking-wide">
          {SIDEBAR_ASSISTANT_LABEL}
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
      onClick={() => props.onSelect(props.tab)}
      className={cn(
        "inline-flex h-8 min-w-0 items-center justify-center rounded-lg px-3 text-[12px] font-medium outline-none",
        "transition-[background-color,color,box-shadow,transform] duration-150 motion-reduce:transition-none",
        "focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] motion-reduce:active:scale-100",
        active
          ? "bg-muted/60 font-semibold text-foreground"
          : "text-muted-foreground hover:bg-muted/30 hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

function SidebarTabbedHeader(props: {
  activeTab: ReviewSidebarTab;
  chatContextReady: boolean;
  onTabChange: (tab: ReviewSidebarTab) => void;
  collapsed: boolean;
  onCollapsedChange: ((collapsed: boolean) => void) | undefined;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/25 px-3 py-2">
      <div
        role="tablist"
        aria-label="Pull request sidebar"
        className="inline-flex min-w-0 rounded-lg bg-muted/40 p-0.5 ring-1 ring-border/40"
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
          <SidebarStatusDot
            ready={props.chatContextReady}
            title={props.chatContextReady ? "PR context loaded" : "Loading PR context"}
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
  const chatContextReady = hasReviewSidechatAgentContext(props.sidechatContext);
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
      <ReviewRailResizer
        resize={resize}
        edge="right"
        label="Resize AI chat sidebar"
        className="hidden xl:block"
      />
      <aside
        ref={sidebarRef}
        className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-border/60 bg-background max-xl:max-w-[min(420px,calc(100vw-48px))]"
        style={{ width: resize.width }}
      >
        <SidebarTabbedHeader
          activeTab={activeTab}
          chatContextReady={chatContextReady}
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
          />
        </div>
      </aside>
    </>
  );
}
