// FILE: -chatThreadRoute.panes.tsx
// Purpose: Self-contained pane primitives and surface shells for the thread route (split dividers, embedded panels, empty/skeleton states, deferred chat mount).
// Layer: Route UI components
// Exports: pane dimension constants, clampSplitRatio, allowAnySplitDirection, noop, normalizeSingleSearchFromPane, resolveSingleProjectId, DOCK_EMBEDDED_PANEL_STATE, LazyDiffPanel, LazyReviewDockPane, ChatMountSkeleton, DeferredChatView, SplitDivider, PaneRenderer, SplitPaneEmptyState, SplitPaneEmbeddedPanel, SplitPaneSurface, RightDockPanePlaceholder

import {
  type ProviderKind,
  type ProjectId,
  type ThreadId as ThreadIdType,
  type TurnId,
} from "@t3tools/contracts";
import {
  Suspense,
  lazy,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Schema } from "effect";

import ChatView from "../components/ChatView";
import BrowserPanel from "../components/BrowserPanel";
import { ProviderIcon } from "../components/ProviderIcon";
import { ChatPaneDropOverlay } from "../components/chat-drop-overlay/ChatPaneDropOverlay";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../components/DiffPanelShell";
import { type ChatRightPanel, type DiffRouteSearch } from "../diffRouteSearch";
import {
  type LeafPane,
  type Pane,
  type PaneId,
  type SplitDirection,
  type SplitDropSide,
  type SplitView,
  type SplitViewId,
  type SplitViewPanePanelState,
} from "../splitViewStore";
import { CHAT_SURFACE_HEADER_ROW_CLASS_NAME } from "../components/chat/chatHeaderControls";
import { PanelStateMessage } from "../components/chat/PanelStateMessage";
import { getRightDockPaneMeta } from "../components/chat/rightDockPaneMeta";
import { type RightDockPaneKind } from "../rightDockStore.logic";
import {
  canComposerHandlePanelWidth,
  createPanelResizeOverlay,
  removePanelResizeOverlay,
} from "../lib/panelResize";
import { resolveThreadPickerTitle } from "./-chatThreadRoute.logic";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { CHAT_BACKGROUND_CLASS_NAME } from "../components/chat/composerPickerStyles";
import { cn } from "~/lib/utils";
import { SidebarInset } from "~/components/ui/sidebar";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const ReviewDockPane = lazy(() =>
  import("../components/review/ReviewDockPane").then((module) => ({
    default: module.ReviewDockPane,
  })),
);
// Open the dock as a true 50/50 split of the chat area: `50vw - 8rem` is half the
// viewport minus half the fixed 16rem left sidebar, so the chat and dock match.
// `max()` keeps a sane minimum on narrow screens but never caps the half-width.
export const DIFF_INLINE_DEFAULT_WIDTH = "max(28rem, calc(50vw - 8rem))";
const SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX = 22 * 16;
const BROWSER_SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX = 30 * 16;
const SPLIT_PANE_CHAT_MIN_WIDTH = 20 * 16;
export const SINGLE_PANEL_MIN_WIDTH = 26 * 16;
const BROWSER_PANEL_MIN_WIDTH = 21 * 16;
export const RIGHT_PANEL_SIDEBAR_WIDTH_STORAGE_KEY = "chat_right_panel_width";
const SPLIT_RATIO_MIN = 0.25;
const SPLIT_RATIO_MAX = 0.75;

export const allowAnySplitDirection = (_direction: SplitDirection) => true;
export const noop = () => {};

function clampSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, value));
}

const DiffLoadingFallback = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label="Loading diff viewer..." />
    </DiffPanelShell>
  );
};

export const LazyDiffPanel = (props: {
  mode: DiffPanelMode;
  threadId?: ThreadIdType | null;
  panelState?: Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">;
  onUpdatePanelState?: (
    patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
  ) => void;
  onClosePanel?: () => void;
  liveRefreshEnabled?: boolean;
}) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
        <DiffPanel
          mode={props.mode}
          {...(props.threadId !== undefined ? { threadId: props.threadId } : {})}
          {...(props.panelState ? { panelState: props.panelState } : {})}
          {...(props.onUpdatePanelState ? { onUpdatePanelState: props.onUpdatePanelState } : {})}
          {...(props.onClosePanel ? { onClosePanel: props.onClosePanel } : {})}
          {...(props.liveRefreshEnabled !== undefined
            ? { liveRefreshEnabled: props.liveRefreshEnabled }
            : {})}
        />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

export const LazyReviewDockPane = (props: { threadId: ThreadIdType }) => {
  return (
    <Suspense fallback={<PanelStateMessage density="compact">Loading review…</PanelStateMessage>}>
      <ReviewDockPane threadId={props.threadId} />
    </Suspense>
  );
};

// Split panes cannot reuse the desktop Sidebar primitive because it positions the panel
// against the viewport. This embedded shell keeps browser/diff content anchored to the pane.
function SplitPaneEmbeddedPanel(props: {
  splitViewId: SplitViewId;
  paneId: PaneId;
  paneScopeId: string;
  panelOpen: boolean;
  panel: ChatRightPanel | null | undefined;
  threadId: ThreadIdType | null;
  onClosePanel: () => void;
  panelState: Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">;
  isFocused: boolean;
  onUpdatePanelState: (
    patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
  ) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelWidthStorageKey =
    props.panel === "browser" ? "browser" : props.panel === "diff" ? "diff" : "panel";
  const storageKey = `${RIGHT_PANEL_SIDEBAR_WIDTH_STORAGE_KEY}:${props.splitViewId}:${props.paneId}:${panelWidthStorageKey}`;
  const defaultPanelWidth =
    props.panel === "browser"
      ? BROWSER_SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX
      : SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX;
  const minPanelWidth =
    props.panel === "browser" ? BROWSER_PANEL_MIN_WIDTH : SINGLE_PANEL_MIN_WIDTH;
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    return getLocalStorageItem(storageKey, Schema.Finite) ?? defaultPanelWidth;
  });

  useEffect(() => {
    setPanelWidth(getLocalStorageItem(storageKey, Schema.Finite) ?? defaultPanelWidth);
  }, [defaultPanelWidth, storageKey]);

  const shouldAcceptEmbeddedWidth = useCallback(
    (nextWidth: number) => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return true;
      return canComposerHandlePanelWidth({
        nextWidth,
        paneScopeId: props.paneScopeId,
        applyWidth: (width) => {
          wrapper.style.width = `${width}px`;
        },
        resetWidth: () => {
          wrapper.style.width = `${panelWidth}px`;
        },
      });
    },
    [panelWidth, props.paneScopeId],
  );

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const wrapper = wrapperRef.current;
      const parent = wrapper?.parentElement;
      if (!wrapper || !parent) return;

      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = wrapper.getBoundingClientRect().width;
      const maxWidth = Math.max(minPanelWidth, parent.clientWidth - SPLIT_PANE_CHAT_MIN_WIDTH);
      const resizeOverlay = createPanelResizeOverlay();

      const onPointerMove = (moveEvent: PointerEvent) => {
        const delta = startX - moveEvent.clientX;
        const nextWidth = Math.max(minPanelWidth, Math.min(maxWidth, startWidth + delta));
        if (!shouldAcceptEmbeddedWidth(nextWidth)) {
          return;
        }
        setPanelWidth(nextWidth);
        setLocalStorageItem(storageKey, nextWidth, Schema.Finite);
      };

      const onPointerUp = () => {
        removePanelResizeOverlay(resizeOverlay);
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
        resizeOverlay.removeEventListener("pointermove", onPointerMove);
        resizeOverlay.removeEventListener("pointerup", onPointerUp);
        resizeOverlay.removeEventListener("pointercancel", onPointerUp);
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      resizeOverlay.addEventListener("pointermove", onPointerMove);
      resizeOverlay.addEventListener("pointerup", onPointerUp);
      resizeOverlay.addEventListener("pointercancel", onPointerUp);
    },
    [minPanelWidth, shouldAcceptEmbeddedWidth, storageKey],
  );

  if (!props.panelOpen || !props.threadId) {
    return null;
  }

  return (
    <div
      ref={wrapperRef}
      data-native-browser-surface={props.panel === "browser" ? "true" : undefined}
      className="relative flex h-full min-h-0 min-w-0 flex-none border-l border-sidebar-border bg-card text-foreground"
      style={
        {
          width: `${panelWidth}px`,
          maxWidth: `calc(100% - ${SPLIT_PANE_CHAT_MIN_WIDTH}px)`,
          minWidth: minPanelWidth,
        } as CSSProperties
      }
    >
      <div
        className="absolute inset-y-0 left-0 z-20 w-2 -translate-x-1/2 cursor-col-resize bg-transparent before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-sidebar-border"
        onPointerDown={startResize}
      />
      {props.panel === "browser" ? (
        <BrowserPanel mode="sidebar" threadId={props.threadId} onClosePanel={props.onClosePanel} />
      ) : (
        <LazyDiffPanel
          mode="sidebar"
          threadId={props.threadId}
          onClosePanel={props.onClosePanel}
          panelState={props.panelState}
          liveRefreshEnabled={props.isFocused}
          onUpdatePanelState={props.onUpdatePanelState}
        />
      )}
    </div>
  );
}

export function resolveSingleProjectId(input: {
  threadProjectId: ProjectId | null;
  draftProjectId: ProjectId | null;
}): ProjectId | null {
  return input.threadProjectId ?? input.draftProjectId ?? null;
}

export function normalizeSingleSearchFromPane(
  panelState: Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">,
): DiffRouteSearch {
  if (panelState.panel === "browser") {
    return { panel: "browser" };
  }
  if (panelState.panel === "diff") {
    return {
      panel: "diff",
      diff: "1",
      ...(panelState.diffTurnId ? { diffTurnId: panelState.diffTurnId } : {}),
      ...(panelState.diffTurnId && panelState.diffFilePath
        ? { diffFilePath: panelState.diffFilePath }
        : {}),
    };
  }
  return {};
}

function SplitPaneEmptyState(props: {
  isFocused: boolean;
  onFocus: () => void;
  threads: readonly {
    id: ThreadIdType;
    title: string | null;
    projectId: ProjectId;
    modelSelection: { provider: ProviderKind };
  }[];
  projects: readonly { id: ProjectId; name: string }[];
  excludedThreadIds: ReadonlySet<ThreadIdType>;
  onSelectThread: (threadId: ThreadIdType) => void;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col items-center px-6 pt-16",
        CHAT_BACKGROUND_CLASS_NAME,
        props.isFocused ? "ring-2 ring-inset ring-primary/70" : "",
      )}
      onMouseDown={props.onFocus}
    >
      <div className="w-full max-w-sm space-y-4">
        <p className="text-center text-sm font-medium text-foreground/70">Select a chat</p>
        <div className="max-h-[60vh] space-y-1 overflow-y-auto">
          {props.threads.map((thread) => {
            const isUsed = props.excludedThreadIds.has(thread.id);
            const projectName =
              props.projects.find((p) => p.id === thread.projectId)?.name ?? "Project";
            return (
              <button
                key={thread.id}
                type="button"
                disabled={isUsed}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                  isUsed
                    ? "cursor-default border-border/30 opacity-35"
                    : "border-[color:var(--color-border-light)] hover:bg-[var(--sidebar-accent)]",
                )}
                onClick={() => {
                  if (!isUsed) props.onSelectThread(thread.id);
                }}
              >
                <ProviderIcon
                  provider={thread.modelSelection.provider}
                  className="size-4 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {resolveThreadPickerTitle(thread.title)}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{projectName}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SplitDivider(props: {
  splitNodeId: PaneId;
  direction: SplitDirection;
  onSetRatio: (nodeId: PaneId, ratio: number) => void;
}) {
  const { onSetRatio, splitNodeId, direction } = props;
  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = event.currentTarget;
      const parent = target.parentElement as HTMLElement | null;
      if (!parent) return;
      event.preventDefault();
      const rect = parent.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const computeRatio = (clientX: number, clientY: number) =>
        clampSplitRatio(
          direction === "horizontal"
            ? (clientX - rect.left) / rect.width
            : (clientY - rect.top) / rect.height,
        );

      let latestRatio = computeRatio(event.clientX, event.clientY);
      let frameId = 0;
      const previousParentPosition = parent.style.position;
      const previousBodyCursor = document.body.style.cursor;
      const previousBodyUserSelect = document.body.style.userSelect;
      if (getComputedStyle(parent).position === "static") {
        parent.style.position = "relative";
      }
      const resizeGuide = document.createElement("div");
      resizeGuide.setAttribute("data-split-resize-guide", "true");
      Object.assign(resizeGuide.style, {
        position: "absolute",
        zIndex: "50",
        pointerEvents: "none",
        borderRadius: "999px",
        background: "var(--info)",
        opacity: "0.75",
        boxShadow: "0 0 0 1px color-mix(in srgb, var(--info) 70%, transparent)",
      });
      if (direction === "horizontal") {
        Object.assign(resizeGuide.style, {
          top: "0",
          bottom: "0",
          left: "0",
          width: "2px",
        });
      } else {
        Object.assign(resizeGuide.style, {
          top: "0",
          left: "0",
          right: "0",
          height: "2px",
        });
      }
      parent.append(resizeGuide);

      const applyGuide = () => {
        frameId = 0;
        const offsetPx =
          direction === "horizontal" ? rect.width * latestRatio : rect.height * latestRatio;
        resizeGuide.style.transform =
          direction === "horizontal"
            ? `translateX(${Math.round(offsetPx)}px)`
            : `translateY(${Math.round(offsetPx)}px)`;
      };

      const onPointerMove = (moveEvent: PointerEvent) => {
        latestRatio = computeRatio(moveEvent.clientX, moveEvent.clientY);
        if (frameId === 0) {
          frameId = window.requestAnimationFrame(applyGuide);
        }
      };
      const onPointerUp = () => {
        if (frameId !== 0) {
          window.cancelAnimationFrame(frameId);
          applyGuide();
        }
        document.body.style.userSelect = previousBodyUserSelect;
        document.body.style.cursor = previousBodyCursor;
        parent.style.position = previousParentPosition;
        resizeGuide.remove();
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        onSetRatio(splitNodeId, latestRatio);
      };

      document.body.style.userSelect = "none";
      document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
      applyGuide();
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [direction, onSetRatio, splitNodeId],
  );

  return (
    <div
      data-split-divider="true"
      data-split-node-id={splitNodeId}
      data-split-direction={direction}
      className={cn(
        "relative z-10 shrink-0 bg-border/70",
        direction === "horizontal"
          ? "w-px cursor-col-resize before:absolute before:inset-y-0 before:-left-1 before:w-2 before:bg-transparent"
          : "h-px cursor-row-resize before:absolute before:inset-x-0 before:-top-1 before:h-2 before:bg-transparent",
      )}
      onPointerDown={handlePointerDown}
    />
  );
}

export function PaneRenderer(props: {
  pane: Pane;
  splitView: SplitView;
  renderLeaf: (input: { leaf: LeafPane }) => ReactNode;
  onSetRatio: (nodeId: PaneId, ratio: number) => void;
}) {
  if (props.pane.kind === "leaf") {
    return <>{props.renderLeaf({ leaf: props.pane })}</>;
  }
  const node = props.pane;
  const isRow = node.direction === "horizontal";
  const firstBasis = `${node.ratio * 100}%`;
  return (
    <div
      data-split-container="true"
      data-split-direction={node.direction}
      className={cn("flex min-h-0 min-w-0 flex-1 overflow-hidden", isRow ? "flex-row" : "flex-col")}
    >
      <div
        className="flex min-h-0 min-w-0 overflow-hidden"
        style={{ flexBasis: firstBasis, flexGrow: 0, flexShrink: 1 }}
      >
        <PaneRenderer
          pane={node.first}
          splitView={props.splitView}
          renderLeaf={props.renderLeaf}
          onSetRatio={props.onSetRatio}
        />
      </div>
      <SplitDivider
        splitNodeId={node.id}
        direction={node.direction}
        onSetRatio={props.onSetRatio}
      />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <PaneRenderer
          pane={node.second}
          splitView={props.splitView}
          renderLeaf={props.renderLeaf}
          onSetRatio={props.onSetRatio}
        />
      </div>
    </div>
  );
}

export function ChatMountSkeleton() {
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col text-foreground [contain:layout_style_paint]",
        CHAT_BACKGROUND_CLASS_NAME,
      )}
    >
      {/* Mirrors the real chat shell so route changes paint immediately while ChatView mounts
          on the next frames. */}
      <div className={cn(CHAT_SURFACE_HEADER_ROW_CLASS_NAME, "gap-3 px-4")}>
        <div className="size-5 rounded-full bg-muted" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="h-3.5 w-44 max-w-[48%] rounded-full bg-muted" />
          <div className="h-2 w-24 max-w-[32%] rounded-full bg-muted/65" />
        </div>
        <div className="hidden items-center gap-1.5 sm:flex">
          <div className="size-7 rounded-md border border-[color:var(--color-border-light)] bg-muted/35" />
          <div className="size-7 rounded-md border border-[color:var(--color-border-light)] bg-muted/35" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 px-5 py-4">
        <div className="max-w-[82%] space-y-2 rounded-2xl border border-[color:var(--color-border-light)] bg-muted/22 p-3">
          <div className="h-2.5 w-11/12 rounded-full bg-muted/75" />
          <div className="h-2.5 w-7/12 rounded-full bg-muted/60" />
        </div>
        <div className="ml-auto max-w-[70%] space-y-2 rounded-2xl bg-muted/45 p-3">
          <div className="h-2.5 w-48 max-w-full rounded-full bg-muted-foreground/14" />
          <div className="h-2.5 w-32 max-w-[78%] rounded-full bg-muted-foreground/12" />
        </div>
        <div className="max-w-[88%] space-y-2 rounded-2xl border border-[color:var(--color-border-light)] bg-muted/22 p-3">
          <div className="h-2.5 w-full rounded-full bg-muted/75" />
          <div className="h-2.5 w-10/12 rounded-full bg-muted/60" />
          <div className="h-2.5 w-5/12 rounded-full bg-muted/50" />
        </div>
      </div>
      <div className="shrink-0 border-t border-[color:var(--color-border-light)] p-3">
        <div className="rounded-2xl border border-[color:var(--color-border-light)] bg-background p-3 shadow-xs">
          <div className="h-3 w-40 max-w-[50%] rounded-full bg-muted" />
          <div className="mt-8 flex items-center justify-between">
            <div className="h-2.5 w-24 rounded-full bg-muted/65" />
            <div className="size-7 rounded-full bg-muted" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function DeferredChatView(props: {
  threadId: ThreadIdType;
  paneScopeId: string;
  deferMount: boolean;
  surfaceMode: "single" | "split";
  isFocusedPane: boolean;
  panelState: SplitViewPanePanelState;
  onToggleDiff: () => void;
  onToggleBrowser: () => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  reviewOpen?: boolean;
  onToggleReview?: () => void;
  onSplitSurface?: () => void;
  onMaximize?: () => void;
  onChangeThread?: () => void;
  onCloseThreadPane?: () => void;
  onMounted?: () => void;
}) {
  const onMounted = props.onMounted ?? noop;
  const mountKey = `${props.paneScopeId}:${props.threadId}`;
  const [readyMountKey, setReadyMountKey] = useState<string | null>(() =>
    props.deferMount ? null : mountKey,
  );
  const canMountChatView = !props.deferMount || readyMountKey === mountKey;

  useEffect(() => {
    if (!props.deferMount) {
      return;
    }
    setReadyMountKey(null);
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => setReadyMountKey(mountKey));
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [mountKey, props.deferMount]);

  useEffect(() => {
    if (canMountChatView) {
      onMounted();
    }
  }, [canMountChatView, onMounted]);

  if (!canMountChatView) {
    return <ChatMountSkeleton />;
  }

  return (
    <ChatView
      key={props.paneScopeId}
      threadId={props.threadId}
      paneScopeId={props.paneScopeId}
      surfaceMode={props.surfaceMode}
      isFocusedPane={props.isFocusedPane}
      panelState={props.panelState}
      onToggleDiffPanel={props.onToggleDiff}
      onToggleBrowserPanel={props.onToggleBrowser}
      onOpenTurnDiffPanel={props.onOpenTurnDiff}
      {...(props.reviewOpen !== undefined ? { reviewPanelOpen: props.reviewOpen } : {})}
      {...(props.onToggleReview ? { onToggleReviewPanel: props.onToggleReview } : {})}
      {...(props.onSplitSurface ? { onSplitSurface: props.onSplitSurface } : {})}
      {...(props.onMaximize ? { onMaximizeSurface: props.onMaximize } : {})}
      {...(props.onChangeThread ? { onChangeThreadInSplitPane: props.onChangeThread } : {})}
      {...(props.onCloseThreadPane ? { onCloseThreadPane: props.onCloseThreadPane } : {})}
    />
  );
}

export function SplitPaneSurface(props: {
  splitView: SplitView;
  paneId: PaneId;
  threadId: ThreadIdType | null;
  panelState: SplitViewPanePanelState;
  isFocused: boolean;
  deferChatMount: boolean;
  canDropInDirection: (direction: SplitDirection) => boolean;
  excludedThreadIds: ReadonlySet<ThreadIdType>;
  threads: readonly {
    id: ThreadIdType;
    title: string | null;
    projectId: ProjectId;
    modelSelection: { provider: ProviderKind };
  }[];
  projects: readonly { id: ProjectId; name: string }[];
  onFocus: () => void;
  onToggleDiff: () => void;
  onToggleBrowser: () => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onClosePanel: () => void;
  onUpdatePanelState: (
    patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
  ) => void;
  onMaximize: () => void;
  onCloseThreadPane: () => void;
  onChooseThread: () => void;
  onSelectThread: (threadId: ThreadIdType) => void;
  onChatMounted: () => void;
  onDropThread: (payload: {
    droppedThreadId: ThreadIdType;
    direction: SplitDirection;
    side: SplitDropSide;
  }) => void;
}) {
  const paneScopeId = `${props.splitView.id}:${props.paneId}`;
  const panelOpen = props.panelState.panel !== null;
  const shouldRenderPanelContent = panelOpen || props.panelState.hasOpenedPanel;

  const onDropThread = props.onDropThread;
  const handleDrop = useCallback(
    (payload: { threadId: ThreadIdType; direction: SplitDirection; side: SplitDropSide }) => {
      onDropThread({
        droppedThreadId: payload.threadId,
        direction: payload.direction,
        side: payload.side,
      });
    },
    [onDropThread],
  );

  return (
    <div
      className={cn(
        "group relative flex min-h-0 min-w-0 flex-1 [contain:layout_style_paint]",
        CHAT_BACKGROUND_CLASS_NAME,
      )}
    >
      <ChatPaneDropOverlay
        paneScopeId={paneScopeId}
        canDropInDirection={props.canDropInDirection}
        excludedThreadIds={props.excludedThreadIds}
        onDrop={handleDrop}
        className="flex min-h-0 min-w-0 flex-1"
      >
        <SidebarInset
          className={cn(
            "min-h-0 min-w-0 overflow-hidden overscroll-y-none text-foreground transition-shadow",
            props.isFocused ? "ring-2 ring-inset ring-primary/70" : "",
          )}
          surfaceClassName={CHAT_BACKGROUND_CLASS_NAME}
          onMouseDown={props.onFocus}
        >
          {props.threadId ? (
            <DeferredChatView
              threadId={props.threadId}
              paneScopeId={paneScopeId}
              deferMount={props.deferChatMount}
              surfaceMode="split"
              isFocusedPane={props.isFocused}
              panelState={props.panelState}
              onToggleDiff={props.onToggleDiff}
              onToggleBrowser={props.onToggleBrowser}
              onOpenTurnDiff={props.onOpenTurnDiff}
              onMaximize={props.onMaximize}
              onChangeThread={props.onChooseThread}
              onCloseThreadPane={props.onCloseThreadPane}
              onMounted={props.onChatMounted}
            />
          ) : (
            <SplitPaneEmptyState
              isFocused={props.isFocused}
              onFocus={props.onFocus}
              threads={props.threads}
              projects={props.projects}
              excludedThreadIds={props.excludedThreadIds}
              onSelectThread={props.onSelectThread}
            />
          )}
        </SidebarInset>
      </ChatPaneDropOverlay>
      <SplitPaneEmbeddedPanel
        splitViewId={props.splitView.id}
        paneId={props.paneId}
        paneScopeId={paneScopeId}
        panelOpen={panelOpen && shouldRenderPanelContent}
        panel={props.panelState.panel}
        threadId={props.threadId}
        onClosePanel={props.onClosePanel}
        panelState={props.panelState}
        isFocused={props.isFocused}
        onUpdatePanelState={props.onUpdatePanelState}
      />
      {props.isFocused ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-[0.9px] z-20 border border-[color-mix(in_srgb,var(--info)_45%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--info)_12%,transparent)] transition-opacity duration-150"
        />
      ) : null}
      {!props.isFocused ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 bg-foreground/[0.060] transition-opacity duration-150"
        />
      ) : null}
    </div>
  );
}

export function RightDockPanePlaceholder(props: { kind: RightDockPaneKind }) {
  const { label } = getRightDockPaneMeta(props.kind);
  return <PanelStateMessage>{label} panel is coming soon.</PanelStateMessage>;
}

// Embedded dock chats (side chats) manage their own panels through the dock, so the
// nested ChatView always renders with a closed, inert panel state.
export const DOCK_EMBEDDED_PANEL_STATE: SplitViewPanePanelState = {
  panel: null,
  diffTurnId: null,
  diffFilePath: null,
  hasOpenedPanel: false,
  lastOpenPanel: "browser",
};
