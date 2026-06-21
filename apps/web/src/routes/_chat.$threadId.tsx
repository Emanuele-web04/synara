// FILE: _chat.$threadId.tsx
// Purpose: Resolves the active thread route into either a single chat surface or a persisted split view.
// Layer: Route container
// Depends on: ChatView, splitViewStore, splitView.logic, ChatPaneDropOverlay, and pane-scoped browser/diff panels

import {
  type ProviderKind,
  type ProjectId,
  ThreadId,
  type ThreadId as ThreadIdType,
  type TurnId,
} from "@t3tools/contracts";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import { isWorkspaceRelativePathSafe } from "@t3tools/shared/path";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Suspense,
  lazy,
  startTransition,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Schema } from "effect";

import ChatView from "../components/ChatView";
import BrowserPanel from "../components/BrowserPanel";
import { EditorWorkspaceView } from "../components/EditorWorkspaceView";
import { ProviderIcon } from "../components/ProviderIcon";
import { ChatPaneDropOverlay } from "../components/chat-drop-overlay/ChatPaneDropOverlay";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../components/DiffPanelShell";
import { useComposerDraftStore } from "../composerDraftStore";
import { useDockPaneRuntimeActivation } from "../hooks/useDockPaneRuntimeActivation";
import {
  type ChatRightPanel,
  type DiffRouteSearch,
  parseDiffRouteSearch,
  stripDiffSearchParams,
} from "../diffRouteSearch";
import {
  type EmptyRouteRestoreRecoveryState,
  shouldHoldMissingThreadRouteFallback,
  shouldStartMissingThreadRouteRecovery,
} from "../chatRouteRestore";
import {
  refreshEmptyRouteRestoreSnapshot,
  waitForEmptyRouteRestoreFallbackDelay,
} from "../chatRouteRecovery";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { resolveActiveSplitView, isSplitRoute } from "../splitViewRoute";
import { canSubdividePane, collectLeaves, findLeafPaneById } from "../splitView.logic";
import {
  resolveSplitViewFocusedThreadId,
  resolveSplitViewPaneIdForThread,
  resolveSplitViewThreadIds,
  selectSplitView,
  type LeafPane,
  type Pane,
  type PaneId,
  type SplitDirection,
  type SplitDropSide,
  type SplitView,
  type SplitViewId,
  type SplitViewPanePanelState,
  useSplitViewStore,
} from "../splitViewStore";
import { selectRightDockState, useRightDockStore } from "../rightDockStore";
import {
  type RightDockPane,
  type RightDockPaneKind,
  resolveActivePane,
} from "../rightDockStore.logic";
import { RightDock } from "../components/chat/RightDock";
import { DockTerminalPane } from "../components/chat/DockTerminalPane";
import { CHAT_SURFACE_HEADER_ROW_CLASS_NAME } from "../components/chat/chatHeaderControls";
import { GitPanel } from "../components/chat/GitPanel";
import { PanelStateMessage } from "../components/chat/PanelStateMessage";
import {
  RIGHT_DOCK_ADD_MENU_KINDS,
  getRightDockPaneMeta,
} from "../components/chat/rightDockPaneMeta";
import { DockFilePane } from "../components/chat/DockFilePane";
import { readEditorViewState, storeEditorViewState } from "../editorViewState";
import { basenameOfPath } from "../file-icons";
import {
  addChatFileComment,
  appendChatFileReference,
  appendComposerPromptText,
  buildWhyLinesPrompt,
  type ChatFileReference,
} from "../lib/chatReferences";
import type { FileCommentSelection } from "../lib/fileComments";
import { type DockPaneRuntimeMode } from "../lib/dockPaneActivation";
import { projectListDirectoriesQueryOptions } from "../lib/projectReactQuery";
import {
  WorkspaceFileOpenerContext,
  prefetchWorkspaceFile,
  resolveDockFileOpenTarget,
  resolveWorkspaceFileOpenTarget,
  type WorkspaceFileOpener,
} from "../lib/workspaceFileOpener";
import {
  canComposerHandlePanelWidth,
  createPanelResizeOverlay,
  removePanelResizeOverlay,
} from "../lib/panelResize";
import { getSidechatCreator } from "../lib/sidechatCreatorRegistry";
import { toastManager } from "../components/ui/toast";
import { useAppSettings } from "../appSettings";
import { useStore } from "../store";
import { readNativeApi } from "../nativeApi";
import {
  createAllThreadsSelector,
  createProjectSelector,
  createSidebarThreadSummariesSelector,
  createThreadExistsSelector,
  createThreadProjectIdSelector,
  createThreadWorkspaceMetadataSelector,
} from "../storeSelectors";
import { sortThreadsForSidebar } from "../components/Sidebar.logic";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import {
  resolveFilePreviewWorkspaceRoot,
  resolveRoutePanelBootstrap,
  resolveSplitPaneCloseDecision,
  resolveSplitPaneMaximizeDecision,
  resolveThreadPickerTitle,
  resolveToggledChatPanelPatch,
} from "./-chatThreadRoute.logic";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import {
  CHAT_BACKGROUND_CLASS_NAME,
  CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
  CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
  CHAT_ROUTE_INSET_SHELL_CLASS_NAME,
} from "../components/chat/composerPickerStyles";
import { cn } from "~/lib/utils";
import { SidebarInset } from "~/components/ui/sidebar";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
// Pre-measure approximation of the dock's 50/50 split (half the viewport minus
// half a 16rem left sidebar). RightDock measures the actual shell on open and
// pins the width to exactly half; this only covers the first paint before that
// effect runs. `max()` keeps a sane minimum on narrow screens.
const DIFF_INLINE_DEFAULT_WIDTH = "max(28rem, calc(50vw - 8rem))";
const SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX = 22 * 16;
const BROWSER_SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX = 30 * 16;
const SPLIT_PANE_CHAT_MIN_WIDTH = 20 * 16;
const SINGLE_PANEL_MIN_WIDTH = 26 * 16;
const BROWSER_PANEL_MIN_WIDTH = 21 * 16;
const RIGHT_PANEL_SIDEBAR_WIDTH_STORAGE_KEY = "chat_right_panel_width";
const SPLIT_RATIO_MIN = 0.25;
const SPLIT_RATIO_MAX = 0.75;

const allowAnySplitDirection = (_direction: SplitDirection) => true;
const noop = () => {};

function clampSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, value));
}

const DiffLoadingFallback = (props: { mode: DiffPanelMode; hideHeader?: boolean }) => {
  return (
    <DiffPanelShell
      mode={props.mode}
      header={props.hideHeader ? null : <DiffPanelHeaderSkeleton />}
    >
      <DiffPanelLoadingState label="Loading diff viewer..." />
    </DiffPanelShell>
  );
};

const LazyDiffPanel = (props: {
  mode: DiffPanelMode;
  threadId?: ThreadIdType | null;
  panelState?: Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">;
  onUpdatePanelState?: (
    patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
  ) => void;
  onClosePanel?: () => void;
  liveRefreshEnabled?: boolean;
  queriesEnabled?: boolean;
  hideHeader?: boolean;
  onRenderableFilesChange?: (files: ReadonlyArray<FileDiffMetadata>, isLoading: boolean) => void;
  onEditorDiffOptionsChange?: (control: ReactNode | null) => void;
}) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense
        fallback={
          <DiffLoadingFallback
            mode={props.mode}
            {...(props.hideHeader !== undefined ? { hideHeader: props.hideHeader } : {})}
          />
        }
      >
        <DiffPanel
          mode={props.mode}
          {...(props.threadId !== undefined ? { threadId: props.threadId } : {})}
          {...(props.panelState ? { panelState: props.panelState } : {})}
          {...(props.onUpdatePanelState ? { onUpdatePanelState: props.onUpdatePanelState } : {})}
          {...(props.onClosePanel ? { onClosePanel: props.onClosePanel } : {})}
          {...(props.liveRefreshEnabled !== undefined
            ? { liveRefreshEnabled: props.liveRefreshEnabled }
            : {})}
          {...(props.queriesEnabled !== undefined ? { queriesEnabled: props.queriesEnabled } : {})}
          {...(props.hideHeader !== undefined ? { hideHeader: props.hideHeader } : {})}
          {...(props.onRenderableFilesChange
            ? { onRenderableFilesChange: props.onRenderableFilesChange }
            : {})}
          {...(props.onEditorDiffOptionsChange
            ? { onEditorDiffOptionsChange: props.onEditorDiffOptionsChange }
            : {})}
        />
      </Suspense>
    </DiffWorkerPoolProvider>
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
      className="relative flex h-full min-h-0 min-w-0 flex-none border-l border-[var(--app-surface-divider)] bg-card text-foreground"
      style={
        {
          width: `${panelWidth}px`,
          maxWidth: `calc(100% - ${SPLIT_PANE_CHAT_MIN_WIDTH}px)`,
          minWidth: minPanelWidth,
        } as CSSProperties
      }
    >
      <div
        className="absolute inset-y-0 left-0 z-20 w-2 -translate-x-1/2 cursor-col-resize bg-transparent before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-[var(--app-surface-divider)]"
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

function resolveSingleProjectId(input: {
  threadProjectId: ProjectId | null;
  draftProjectId: ProjectId | null;
}): ProjectId | null {
  return input.threadProjectId ?? input.draftProjectId ?? null;
}

function normalizeSingleSearchFromPane(
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
      ...(panelState.diffFilePath ? { diffFilePath: panelState.diffFilePath } : {}),
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

function PaneRenderer(props: {
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

function ChatMountSkeleton() {
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col text-foreground [contain:layout_style_paint]",
        CHAT_BACKGROUND_CLASS_NAME,
      )}
    >
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

function DeferredChatView(props: {
  threadId: ThreadIdType;
  paneScopeId: string;
  deferMount: boolean;
  surfaceMode: "single" | "split";
  presentationMode?: "default" | "editor";
  isFocusedPane: boolean;
  panelState: SplitViewPanePanelState;
  onToggleDiff: () => void;
  onToggleBrowser: () => void;
  onOpenBrowserUrl: (url: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onSplitSurface?: () => void;
  onMaximize?: () => void;
  viewModeAction?: {
    label: string;
    active: boolean;
    onClick: () => void;
  } | null;
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
      presentationMode={props.presentationMode ?? "default"}
      isFocusedPane={props.isFocusedPane}
      panelState={props.panelState}
      onToggleDiffPanel={props.onToggleDiff}
      onToggleBrowserPanel={props.onToggleBrowser}
      onOpenBrowserUrl={props.onOpenBrowserUrl}
      onOpenTurnDiffPanel={props.onOpenTurnDiff}
      {...(props.onSplitSurface ? { onSplitSurface: props.onSplitSurface } : {})}
      {...(props.onMaximize ? { onMaximizeSurface: props.onMaximize } : {})}
      {...(props.viewModeAction !== undefined ? { viewModeAction: props.viewModeAction } : {})}
      {...(props.onChangeThread ? { onChangeThreadInSplitPane: props.onChangeThread } : {})}
      {...(props.onCloseThreadPane ? { onCloseThreadPane: props.onCloseThreadPane } : {})}
    />
  );
}

function SplitPaneSurface(props: {
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
  onOpenBrowserUrl: (url: string) => void;
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
              onOpenBrowserUrl={props.onOpenBrowserUrl}
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

function SplitChatSurface(props: { splitViewId: SplitViewId; routeThreadId: ThreadIdType }) {
  const navigate = useNavigate();
  const { handleNewChat } = useHandleNewChat();
  const selectAllThreads = useMemo(() => createAllThreadsSelector(), []);
  const threads = useStore(selectAllThreads);
  const projects = useStore((store) => store.projects);
  const splitView = useSplitViewStore(selectSplitView(props.splitViewId));
  const setFocusedPane = useSplitViewStore((store) => store.setFocusedPane);
  const setRatioForNode = useSplitViewStore((store) => store.setRatioForNode);
  const setPanePanelState = useSplitViewStore((store) => store.setPanePanelState);
  const replacePaneThread = useSplitViewStore((store) => store.replacePaneThread);
  const dropThreadOnPane = useSplitViewStore((store) => store.dropThreadOnPane);
  const removeSplitView = useSplitViewStore((store) => store.removeSplitView);
  const removePaneFromSplitView = useSplitViewStore((store) => store.removePaneFromSplitView);
  const [threadPickerPaneId, setThreadPickerPaneId] = useState<PaneId | null>(null);
  const { splitView: activeSplitView, routePaneId } = resolveActiveSplitView({
    splitView,
    routeThreadId: props.routeThreadId,
  });

  useEffect(() => {
    if (!activeSplitView) {
      void navigate({
        to: "/$threadId",
        params: { threadId: props.routeThreadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          splitViewId: undefined,
        }),
      });
      return;
    }

    // Single-leaf split views collapse back to the single chat surface.
    const leaves = collectLeaves(activeSplitView.root);
    if (leaves.length <= 1) {
      const onlyThreadId = leaves[0]?.threadId ?? null;
      removeSplitView(activeSplitView.id);
      const fallbackThreadId = onlyThreadId ?? props.routeThreadId;
      if (!fallbackThreadId) {
        void handleNewChat({ fresh: true });
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId: fallbackThreadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          splitViewId: undefined,
        }),
      });
      return;
    }

    // If the route threadId targets a non-focused pane, switch focus to that pane.
    const focusedLeaf = findLeafPaneById(activeSplitView.root, activeSplitView.focusedPaneId);
    if (
      routePaneId &&
      routePaneId !== activeSplitView.focusedPaneId &&
      focusedLeaf?.threadId !== null &&
      focusedLeaf?.threadId !== undefined
    ) {
      setFocusedPane(activeSplitView.id, routePaneId);
      return;
    }

    // Sync the route threadId with the focused leaf's thread.
    const normalizedFocusedThreadId = resolveSplitViewFocusedThreadId(activeSplitView);
    if (normalizedFocusedThreadId && props.routeThreadId !== normalizedFocusedThreadId) {
      void navigate({
        to: "/$threadId",
        params: { threadId: normalizedFocusedThreadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          splitViewId: activeSplitView.id,
        }),
      });
    }
  }, [
    activeSplitView,
    handleNewChat,
    navigate,
    props.routeThreadId,
    removeSplitView,
    routePaneId,
    setFocusedPane,
  ]);

  const setPaneFocus = useCallback(
    (paneId: PaneId) => {
      if (!activeSplitView) return;
      const leaf = findLeafPaneById(activeSplitView.root, paneId);
      const nextThreadId = leaf?.threadId ?? resolveSplitViewFocusedThreadId(activeSplitView);
      setFocusedPane(activeSplitView.id, paneId);
      if (!nextThreadId || nextThreadId === props.routeThreadId) {
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          splitViewId: activeSplitView.id,
        }),
      });
    },
    [activeSplitView, navigate, props.routeThreadId, setFocusedPane],
  );

  const updatePanePanelState = useCallback(
    (
      paneId: PaneId,
      patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
    ) => {
      if (!activeSplitView) return;
      const leaf = findLeafPaneById(activeSplitView.root, paneId);
      if (!leaf) return;
      const nextPanel = patch.panel ?? leaf.panel.panel;
      setPanePanelState(activeSplitView.id, paneId, {
        ...patch,
        hasOpenedPanel: leaf.panel.hasOpenedPanel || nextPanel !== null,
        lastOpenPanel:
          patch.panel === "browser" || patch.panel === "diff"
            ? patch.panel
            : leaf.panel.lastOpenPanel,
      });
    },
    [activeSplitView, setPanePanelState],
  );

  const togglePanePanel = useCallback(
    (paneId: PaneId, panel: ChatRightPanel) => {
      if (!activeSplitView) return;
      const leaf = findLeafPaneById(activeSplitView.root, paneId);
      if (!leaf?.threadId) {
        return;
      }
      updatePanePanelState(paneId, resolveToggledChatPanelPatch(leaf.panel, panel));
    },
    [activeSplitView, updatePanePanelState],
  );

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function" || !activeSplitView) {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "toggle-browser") return;
      togglePanePanel(activeSplitView.focusedPaneId, "browser");
    });

    return () => {
      unsubscribe?.();
    };
  }, [activeSplitView, togglePanePanel]);

  useEffect(() => {
    const onOpenBrowserPanelRequest = window.desktopBridge?.browser.onBrowserUseOpenPanelRequest;
    if (typeof onOpenBrowserPanelRequest !== "function" || !activeSplitView) {
      return;
    }

    const unsubscribe = onOpenBrowserPanelRequest(() => {
      updatePanePanelState(activeSplitView.focusedPaneId, { panel: "browser" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [activeSplitView, updatePanePanelState]);

  const closePanePanel = useCallback(
    (paneId: PaneId) => {
      updatePanePanelState(paneId, { panel: null });
    },
    [updatePanePanelState],
  );

  const openPaneTurnDiff = useCallback(
    (paneId: PaneId, turnId: TurnId, filePath?: string) => {
      updatePanePanelState(paneId, {
        panel: "diff",
        diffTurnId: turnId,
        diffFilePath: filePath ?? null,
      });
    },
    [updatePanePanelState],
  );

  const maximizeFocusedPane = useCallback(() => {
    if (!activeSplitView) return;
    const focusedLeaf = findLeafPaneById(activeSplitView.root, activeSplitView.focusedPaneId);
    const decision = resolveSplitPaneMaximizeDecision({
      splitViewId: activeSplitView.id,
      focusedThreadId: focusedLeaf?.threadId ?? null,
      focusedPanelState: focusedLeaf?.panel ?? null,
    });

    if (decision) {
      removeSplitView(decision.splitViewIdToRemove);
      void navigate({
        to: "/$threadId",
        params: { threadId: decision.threadId },
        replace: true,
        search: () =>
          decision.panelState ? normalizeSingleSearchFromPane(decision.panelState) : {},
      });
      return;
    }

    removeSplitView(activeSplitView.id);
    void handleNewChat({ fresh: true });
  }, [activeSplitView, handleNewChat, navigate, removeSplitView]);

  const closePaneThread = useCallback(
    (paneId: PaneId) => {
      if (!activeSplitView) return;
      const closingLeaf = findLeafPaneById(activeSplitView.root, paneId);
      const closingThread = closingLeaf?.threadId
        ? threads.find((thread) => thread.id === closingLeaf.threadId)
        : null;

      if (closingThread?.sidechatSourceThreadId) {
        const decision = resolveSplitPaneCloseDecision({
          splitViewId: activeSplitView.id,
          sourceThreadId: activeSplitView.sourceThreadId,
          closingThreadId: closingLeaf?.threadId ?? null,
          closingSidechatSourceThreadId: closingThread.sidechatSourceThreadId,
          nextFocusedThreadId: null,
          nextLeafCount: 0,
        });
        if (decision.kind !== "single-thread") return;
        void navigate({
          to: "/$threadId",
          params: { threadId: decision.threadId },
          replace: true,
          search: (previous) => ({
            ...stripDiffSearchParams(previous),
            splitViewId: undefined,
          }),
        }).then(() => {
          removeSplitView(decision.splitViewIdToRemove);
        });
        return;
      }

      const closed = removePaneFromSplitView({
        splitViewId: activeSplitView.id,
        paneId,
      });
      if (!closed) return;

      const nextSplitView = useSplitViewStore.getState().splitViewsById[activeSplitView.id];
      const nextThreadId = nextSplitView ? resolveSplitViewFocusedThreadId(nextSplitView) : null;
      const decision = resolveSplitPaneCloseDecision({
        splitViewId: activeSplitView.id,
        sourceThreadId: activeSplitView.sourceThreadId,
        closingThreadId: closingLeaf?.threadId ?? null,
        closingSidechatSourceThreadId: null,
        nextFocusedThreadId: nextThreadId,
        nextLeafCount: nextSplitView ? collectLeaves(nextSplitView.root).length : 0,
      });

      if (decision.kind === "single-thread") {
        removeSplitView(decision.splitViewIdToRemove);
        void navigate({
          to: "/$threadId",
          params: { threadId: decision.threadId },
          replace: true,
          search: (previous) => ({
            ...stripDiffSearchParams(previous),
            splitViewId: undefined,
          }),
        });
        return;
      }

      if (decision.kind === "split-thread") {
        void navigate({
          to: "/$threadId",
          params: { threadId: decision.threadId },
          replace: true,
          search: (previous) => ({
            ...stripDiffSearchParams(previous),
            splitViewId: decision.splitViewId,
          }),
        });
        return;
      }

      void handleNewChat({ fresh: true });
    },
    [activeSplitView, handleNewChat, navigate, removePaneFromSplitView, removeSplitView, threads],
  );

  const handleSetRatio = useCallback(
    (nodeId: PaneId, ratio: number) => {
      if (!activeSplitView) return;
      setRatioForNode(activeSplitView.id, nodeId, ratio);
    },
    [activeSplitView, setRatioForNode],
  );

  const handleDropThreadOnPane = useCallback(
    (
      paneId: PaneId,
      payload: {
        droppedThreadId: ThreadIdType;
        direction: SplitDirection;
        side: SplitDropSide;
      },
    ) => {
      if (!activeSplitView) return;
      const ok = dropThreadOnPane({
        splitViewId: activeSplitView.id,
        targetPaneId: paneId,
        direction: payload.direction,
        side: payload.side,
        threadId: payload.droppedThreadId,
      });
      if (!ok) return;
      startTransition(() => {
        void navigate({
          to: "/$threadId",
          params: { threadId: payload.droppedThreadId },
          replace: true,
          search: () => ({ splitViewId: activeSplitView.id }),
        });
      });
    },
    [activeSplitView, dropThreadOnPane, navigate],
  );

  const selectableThreads = useMemo(
    () =>
      threads.toSorted(
        (left, right) =>
          Date.parse(right.updatedAt ?? right.createdAt) -
          Date.parse(left.updatedAt ?? left.createdAt),
      ),
    [threads],
  );
  const splitThreadIds = useMemo(
    () => new Set(activeSplitView ? resolveSplitViewThreadIds(activeSplitView) : []),
    [activeSplitView],
  );

  if (!activeSplitView) {
    return <ChatMountSkeleton />;
  }

  const chooseThreadForPane = (threadId: ThreadIdType, paneOverride?: PaneId) => {
    const paneId = paneOverride ?? threadPickerPaneId;
    if (!paneId) {
      return;
    }
    setThreadPickerPaneId(null);

    const existingPaneIdForThread = resolveSplitViewPaneIdForThread(activeSplitView, threadId);
    if (existingPaneIdForThread && existingPaneIdForThread !== paneId) {
      setPaneFocus(existingPaneIdForThread);
      return;
    }

    const leaf = findLeafPaneById(activeSplitView.root, paneId);
    setFocusedPane(activeSplitView.id, paneId);
    if (leaf && leaf.threadId !== threadId) {
      replacePaneThread(activeSplitView.id, paneId, threadId);
      setPanePanelState(activeSplitView.id, paneId, {
        diffTurnId: null,
        diffFilePath: null,
      });
    }

    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => ({
        ...stripDiffSearchParams(previous),
        splitViewId: activeSplitView.id,
      }),
    });
  };

  const renderLeaf = ({ leaf }: { leaf: LeafPane }): ReactNode => {
    const isFocused = leaf.id === activeSplitView.focusedPaneId;
    const excluded = new Set<ThreadIdType>(splitThreadIds);
    return (
      <SplitPaneSurface
        key={leaf.id}
        splitView={activeSplitView}
        paneId={leaf.id}
        threadId={leaf.threadId}
        panelState={leaf.panel}
        isFocused={isFocused}
        deferChatMount={false}
        canDropInDirection={(direction) =>
          canSubdividePane(activeSplitView.root, leaf.id, direction)
        }
        excludedThreadIds={excluded}
        threads={selectableThreads}
        projects={projects}
        onFocus={() => setPaneFocus(leaf.id)}
        onToggleDiff={() => togglePanePanel(leaf.id, "diff")}
        onToggleBrowser={() => togglePanePanel(leaf.id, "browser")}
        onOpenBrowserUrl={() => updatePanePanelState(leaf.id, { panel: "browser" })}
        onOpenTurnDiff={(turnId, filePath) => openPaneTurnDiff(leaf.id, turnId, filePath)}
        onClosePanel={() => closePanePanel(leaf.id)}
        onUpdatePanelState={(patch) => updatePanePanelState(leaf.id, patch)}
        onMaximize={maximizeFocusedPane}
        onCloseThreadPane={() => closePaneThread(leaf.id)}
        onChooseThread={() => {
          setPaneFocus(leaf.id);
          setThreadPickerPaneId(leaf.id);
        }}
        onSelectThread={(threadId) => chooseThreadForPane(threadId, leaf.id)}
        onChatMounted={noop}
        onDropThread={(payload) => handleDropThreadOnPane(leaf.id, payload)}
      />
    );
  };

  const pickerLeaf = threadPickerPaneId
    ? findLeafPaneById(activeSplitView.root, threadPickerPaneId)
    : null;

  return (
    <>
      <div
        className={cn(CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME, CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME)}
      >
        <PaneRenderer
          pane={activeSplitView.root}
          splitView={activeSplitView}
          renderLeaf={renderLeaf}
          onSetRatio={handleSetRatio}
        />
      </div>
      <Dialog
        open={threadPickerPaneId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setThreadPickerPaneId(null);
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader className="items-center text-center">
            <DialogTitle>Choose Chat</DialogTitle>
            <DialogDescription className="max-w-sm text-center">
              Pick which chat should appear in the focused split pane.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <div className="max-h-[56vh] space-y-1 overflow-y-auto">
              {selectableThreads.map((thread) => {
                const projectName =
                  projects.find((project) => project.id === thread.projectId)?.name ?? "Project";
                const isSelected = pickerLeaf?.threadId === thread.id;
                return (
                  <button
                    key={thread.id}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                      isSelected
                        ? "border-[color:var(--color-border)] bg-[var(--sidebar-accent)]"
                        : "border-[color:var(--color-border-light)] hover:bg-[var(--sidebar-accent)]",
                    )}
                    onClick={() => chooseThreadForPane(thread.id)}
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
            <DialogFooter variant="bare">
              <Button type="button" variant="outline" onClick={() => setThreadPickerPaneId(null)}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function RightDockPanePlaceholder(props: { kind: RightDockPaneKind }) {
  const { label } = getRightDockPaneMeta(props.kind);
  return <PanelStateMessage>{label} panel is coming soon.</PanelStateMessage>;
}

// Embedded dock chats (side chats) manage their own panels through the dock, so the
// nested ChatView always renders with a closed, inert panel state.
const DOCK_EMBEDDED_PANEL_STATE: SplitViewPanePanelState = {
  panel: null,
  diffTurnId: null,
  diffFilePath: null,
  hasOpenedPanel: false,
  lastOpenPanel: "browser",
};

function stripEditorViewSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "view" | "editorFilePath"> {
  const { view: _view, editorFilePath: _editorFilePath, ...rest } = params;
  return rest as Omit<T, "view" | "editorFilePath">;
}

function collectParentDirectoryPaths(filePath: string): string[] {
  const segments = filePath.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return [];
  }

  const parents: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    parents.push(segments.slice(0, index).join("/"));
  }
  return parents;
}

function SingleChatSurface(props: {
  threadId: ThreadIdType;
  search: DiffRouteSearch;
  projectId: ProjectId | null;
}) {
  const navigate = useNavigate();
  const createSplitView = useSplitViewStore((store) => store.createFromThread);
  const createSplitViewFromDrop = useSplitViewStore((store) => store.createFromDrop);
  const dockState = useRightDockStore(selectRightDockState(props.threadId));
  const openPane = useRightDockStore((store) => store.openPane);
  const toggleSingletonPane = useRightDockStore((store) => store.toggleSingletonPane);
  const closePane = useRightDockStore((store) => store.closePane);
  const setActivePane = useRightDockStore((store) => store.setActivePane);
  const setDockOpen = useRightDockStore((store) => store.setDockOpen);
  const updatePane = useRightDockStore((store) => store.updatePane);
  const activeProject = useStore(
    useMemo(() => createProjectSelector(props.projectId), [props.projectId]),
  );
  const threadWorkspaceMetadata = useStore(
    useMemo(() => createThreadWorkspaceMetadataSelector(props.threadId), [props.threadId]),
  );
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[props.threadId] ?? null,
  );
  // File preview must follow the same runtime cwd as chat markdown, diffs, and git:
  // worktree-backed threads resolve links against their materialized worktree.
  const workspaceRoot = resolveFilePreviewWorkspaceRoot({
    projectCwd: activeProject?.cwd ?? null,
    threadEnvMode: threadWorkspaceMetadata.envMode ?? draftThread?.envMode ?? null,
    threadWorktreePath: threadWorkspaceMetadata.worktreePath ?? draftThread?.worktreePath ?? null,
  });
  const projects = useStore((store) => store.projects);
  const { settings: appSettings } = useAppSettings();
  const { handleNewThread } = useHandleNewThread();
  const queryClient = useQueryClient();
  const lastAppliedRoutePanelSearchKeyRef = useRef<string | null>(null);
  const [editorExpandedDirectories, setEditorExpandedDirectories] = useState<ReadonlySet<string>>(
    () => new Set(readEditorViewState(props.threadId)?.expandedDirectories ?? []),
  );
  const [editorCenterMode, setEditorCenterMode] = useState<"file" | "diff">(() =>
    props.search.editorFilePath
      ? "file"
      : (readEditorViewState(props.threadId)?.centerMode ?? "diff"),
  );
  // This route component is reused across thread navigations; reload the
  // persisted editor view state when the thread changes.
  const editorViewStateThreadIdRef = useRef(props.threadId);
  useEffect(() => {
    if (editorViewStateThreadIdRef.current === props.threadId) {
      return;
    }
    editorViewStateThreadIdRef.current = props.threadId;
    const persisted = readEditorViewState(props.threadId);
    setEditorExpandedDirectories(new Set(persisted?.expandedDirectories ?? []));
    setEditorCenterMode(props.search.editorFilePath ? "file" : (persisted?.centerMode ?? "diff"));
  }, [props.search.editorFilePath, props.threadId]);
  const editorViewActive = props.search.view === "editor";
  useEffect(() => {
    if (!editorViewActive) {
      return;
    }
    storeEditorViewState(props.threadId, {
      expandedDirectories: [...editorExpandedDirectories],
      centerMode: editorCenterMode,
    });
  }, [editorCenterMode, editorExpandedDirectories, editorViewActive, props.threadId]);
  const [editorDiffPanelState, setEditorDiffPanelState] = useState<
    Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">
  >({
    panel: "diff",
    diffTurnId: props.search.diffTurnId ?? null,
    diffFilePath: props.search.diffFilePath ?? null,
  });
  const [editorDiffFiles, setEditorDiffFiles] = useState<ReadonlyArray<FileDiffMetadata>>([]);
  const [editorDiffFilesLoading, setEditorDiffFilesLoading] = useState(false);
  const [editorDiffOptionsControl, setEditorDiffOptionsControl] = useState<ReactNode | null>(null);

  const activePane = resolveActivePane(dockState);
  const {
    activePaneRuntimeMode,
    requestActivePaneLive: requestActiveDockPaneLive,
    requestImmediateHydration: requestImmediateDockHydration,
  } = useDockPaneRuntimeActivation({
    threadId: props.threadId,
    activePane,
  });

  // Bridge the dock's active browser/diff pane back into the panelState shape the
  // chat shell still consumes (diff badge, toggle pressed state, transcript gating).
  const chatPanelState = useMemo<SplitViewPanePanelState>(
    () => ({
      panel:
        activePane && (activePane.kind === "browser" || activePane.kind === "diff")
          ? activePane.kind
          : null,
      diffTurnId: activePane?.kind === "diff" ? activePane.diffTurnId : null,
      diffFilePath: activePane?.kind === "diff" ? activePane.diffFilePath : null,
      hasOpenedPanel: dockState.panes.length > 0,
      lastOpenPanel: "browser",
    }),
    [activePane, dockState.panes.length],
  );

  const handleToggleDiff = useCallback(() => {
    requestImmediateDockHydration("diff");
    toggleSingletonPane(props.threadId, { kind: "diff" });
  }, [props.threadId, requestImmediateDockHydration, toggleSingletonPane]);
  const handleToggleBrowser = useCallback(() => {
    requestImmediateDockHydration("browser");
    toggleSingletonPane(props.threadId, { kind: "browser" });
  }, [props.threadId, requestImmediateDockHydration, toggleSingletonPane]);
  const handleOpenBrowserUrl = useCallback(() => {
    requestImmediateDockHydration("browser");
    openPane(props.threadId, { kind: "browser" });
  }, [openPane, props.threadId, requestImmediateDockHydration]);
  const handleOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      requestImmediateDockHydration("diff");
      openPane(props.threadId, {
        kind: "diff",
        diffTurnId: turnId,
        diffFilePath: filePath ?? null,
      });
    },
    [openPane, props.threadId, requestImmediateDockHydration],
  );

  const handleOpenEditorView = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId: props.threadId },
      search: (previous) => ({
        ...stripDiffSearchParams(previous),
        view: "editor",
        ...(props.search.editorFilePath ? { editorFilePath: props.search.editorFilePath } : {}),
      }),
    });
  }, [navigate, props.search.editorFilePath, props.threadId]);

  const handleCloseEditorView = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId: props.threadId },
      search: (previous) => stripEditorViewSearchParams(stripDiffSearchParams(previous)),
    });
  }, [navigate, props.threadId]);

  const handleSelectEditorFile = useCallback(
    (filePath: string) => {
      setEditorCenterMode("file");
      void navigate({
        to: "/$threadId",
        params: { threadId: props.threadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          view: "editor",
          editorFilePath: filePath,
        }),
      });
    },
    [navigate, props.threadId],
  );

  const handleToggleEditorDirectory = useCallback((directoryPath: string) => {
    setEditorExpandedDirectories((previous) => {
      const next = new Set(previous);
      if (next.has(directoryPath)) {
        next.delete(directoryPath);
      } else {
        next.add(directoryPath);
      }
      return next;
    });
  }, []);

  const handleEditorToggleDiff = useCallback(() => {
    setEditorCenterMode((current) =>
      current === "diff" && props.search.editorFilePath ? "file" : "diff",
    );
  }, [props.search.editorFilePath]);

  const handleEditorOpenTurnDiff = useCallback((turnId: TurnId, filePath?: string) => {
    setEditorCenterMode("diff");
    setEditorDiffPanelState({
      panel: "diff",
      diffTurnId: turnId,
      diffFilePath: filePath ?? null,
    });
  }, []);

  const handleUpdateEditorDiffPanelState = useCallback(
    (patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>) => {
      setEditorDiffPanelState((previous) => ({
        panel: "diff",
        diffTurnId: "diffTurnId" in patch ? (patch.diffTurnId ?? null) : previous.diffTurnId,
        diffFilePath:
          "diffFilePath" in patch ? (patch.diffFilePath ?? null) : previous.diffFilePath,
      }));
    },
    [],
  );
  const handleEditorDiffFilesChange = useCallback(
    (files: ReadonlyArray<FileDiffMetadata>, isLoading: boolean) => {
      setEditorDiffFiles(files);
      setEditorDiffFilesLoading(isLoading);
    },
    [],
  );
  const handleSelectEditorDiffFile = useCallback((filePath: string) => {
    setEditorCenterMode("diff");
    setEditorDiffPanelState((previous) => ({
      ...previous,
      panel: "diff",
      diffFilePath: filePath,
    }));
  }, []);
  const handleEditorDiffOptionsChange = useCallback((control: ReactNode | null) => {
    setEditorDiffOptionsControl(control);
  }, []);
  const handleReferenceInChat = useCallback(
    (reference: ChatFileReference) => {
      appendChatFileReference(props.threadId, reference);
    },
    [props.threadId],
  );
  const handleAskWhyInChat = useCallback(
    (reference: ChatFileReference) => {
      appendComposerPromptText(props.threadId, buildWhyLinesPrompt(reference));
    },
    [props.threadId],
  );
  const handleCommentInChat = useCallback(
    (comment: FileCommentSelection) => {
      addChatFileComment(props.threadId, comment);
    },
    [props.threadId],
  );

  // Hover warm-up shared by both surfaces' file openers: file contents land in
  // the React Query cache and the matching Shiki highlighter loads, so the
  // preview paints instantly on click.
  const prefetchOpenerFile = useCallback(
    (path: string) => {
      if (!workspaceRoot) {
        return;
      }
      const relativePath = resolveWorkspaceFileOpenTarget(path, workspaceRoot);
      if (relativePath) {
        prefetchWorkspaceFile(queryClient, workspaceRoot, relativePath);
      }
    },
    [queryClient, workspaceRoot],
  );
  // Chat surface: file references open in the right-dock file pane. References
  // outside the workspace report unhandled so chips fall back to the external
  // editor.
  const dockFileOpener = useMemo<WorkspaceFileOpener>(
    () => ({
      openFile: (path) => {
        // In-workspace references map to relative paths for the file-read RPC;
        // binary previews in a session's scratch workspace (outside the chat
        // workspace) open by absolute path through the local-image route.
        const targetPath = resolveDockFileOpenTarget(path, workspaceRoot);
        if (!targetPath) {
          return false;
        }
        requestImmediateDockHydration("file");
        openPane(props.threadId, { kind: "file", filePath: targetPath });
        return true;
      },
      prefetchFile: prefetchOpenerFile,
    }),
    [openPane, prefetchOpenerFile, props.threadId, requestImmediateDockHydration, workspaceRoot],
  );
  // Editor surface: the center file pane is already the file viewer, so file
  // references select into it instead of opening a dock pane.
  const editorFileOpener = useMemo<WorkspaceFileOpener>(
    () => ({
      openFile: (path) => {
        if (!workspaceRoot) {
          return false;
        }
        const relativePath = resolveWorkspaceFileOpenTarget(path, workspaceRoot);
        if (!relativePath) {
          return false;
        }
        handleSelectEditorFile(relativePath);
        return true;
      },
      prefetchFile: prefetchOpenerFile,
    }),
    [handleSelectEditorFile, prefetchOpenerFile, workspaceRoot],
  );

  const handleSplitSurface = useCallback(() => {
    if (!props.projectId) return;
    const splitViewId = createSplitView({
      sourceThreadId: props.threadId,
      ownerProjectId: props.projectId,
    });
    startTransition(() => {
      void navigate({
        to: "/$threadId",
        params: { threadId: props.threadId },
        replace: true,
        search: () => ({ splitViewId }),
      });
    });
  }, [createSplitView, navigate, props.projectId, props.threadId]);

  const handleDropThread = useCallback(
    (payload: { threadId: ThreadIdType; direction: SplitDirection; side: SplitDropSide }) => {
      if (!props.projectId) return;
      if (payload.threadId === props.threadId) return;
      const splitViewId = createSplitViewFromDrop({
        sourceThreadId: props.threadId,
        ownerProjectId: props.projectId,
        droppedThreadId: payload.threadId,
        direction: payload.direction,
        side: payload.side,
      });
      startTransition(() => {
        void navigate({
          to: "/$threadId",
          params: { threadId: payload.threadId },
          replace: true,
          search: () => ({ splitViewId }),
        });
      });
    },
    [createSplitViewFromDrop, navigate, props.projectId, props.threadId],
  );

  useEffect(() => {
    const { nextAppliedSearchKey, panelPatch } = resolveRoutePanelBootstrap({
      scopeId: props.threadId,
      search: props.search,
      lastAppliedSearchKey: lastAppliedRoutePanelSearchKeyRef.current,
    });

    lastAppliedRoutePanelSearchKeyRef.current = nextAppliedSearchKey;
    if (!panelPatch) {
      return;
    }

    if (panelPatch.panel === "browser") {
      requestImmediateDockHydration("browser");
      openPane(props.threadId, { kind: "browser" });
    } else if (panelPatch.panel === "diff") {
      requestImmediateDockHydration("diff");
      openPane(props.threadId, {
        kind: "diff",
        diffTurnId: panelPatch.diffTurnId ?? null,
        diffFilePath: panelPatch.diffFilePath ?? null,
      });
    } else {
      setDockOpen(props.threadId, false);
    }
    void navigate({
      to: "/$threadId",
      params: { threadId: props.threadId },
      replace: true,
      search: (previous) => stripDiffSearchParams(previous),
    });
  }, [
    navigate,
    openPane,
    props.search,
    props.threadId,
    requestImmediateDockHydration,
    setDockOpen,
  ]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "toggle-browser") return;
      requestImmediateDockHydration("browser");
      toggleSingletonPane(props.threadId, { kind: "browser" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [props.threadId, requestImmediateDockHydration, toggleSingletonPane]);

  useEffect(() => {
    const onOpenBrowserPanelRequest = window.desktopBridge?.browser.onBrowserUseOpenPanelRequest;
    if (typeof onOpenBrowserPanelRequest !== "function") {
      return;
    }

    const unsubscribe = onOpenBrowserPanelRequest(() => {
      requestImmediateDockHydration("browser");
      openPane(props.threadId, { kind: "browser" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [openPane, props.threadId, requestImmediateDockHydration]);

  const excludedThreadIds = useMemo(
    () => new Set<ThreadIdType>([props.threadId]),
    [props.threadId],
  );

  // Sidechat tab labels only need thread titles, so subscribe to the coarse
  // sidebar-summary selector (turn-level changes) instead of the full thread
  // selector, which re-emits on every streaming token of any thread and would
  // otherwise re-render the entire chat surface + right dock + active pane.
  const threadSummaries = useStore(useMemo(() => createSidebarThreadSummariesSelector(), []));
  const editorProjectOptions = useMemo(
    () =>
      projects.flatMap((project) =>
        project.kind === "project" ? [{ id: project.id, name: project.name }] : [],
      ),
    [projects],
  );
  const openEditorProject = useCallback(
    async (projectId: ProjectId) => {
      const latestThread = sortThreadsForSidebar(
        threadSummaries.filter((thread) => thread.projectId === projectId),
        appSettings.sidebarThreadSortOrder,
      )[0];

      if (latestThread) {
        await navigate({
          to: "/$threadId",
          params: { threadId: latestThread.id },
          search: (previous) => ({
            ...stripEditorViewSearchParams(stripDiffSearchParams(previous)),
            view: "editor",
          }),
        });
        return;
      }

      await handleNewThread(
        projectId,
        {
          envMode: appSettings.defaultThreadEnvMode,
        },
        {
          search: (previous) => ({
            ...stripEditorViewSearchParams(stripDiffSearchParams(previous)),
            view: "editor",
          }),
        },
      );
    },
    [
      appSettings.defaultThreadEnvMode,
      appSettings.sidebarThreadSortOrder,
      handleNewThread,
      navigate,
      threadSummaries,
    ],
  );
  const handleSelectEditorProject = useCallback(
    (projectId: ProjectId) => {
      void openEditorProject(projectId).catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Unable to open project",
          description: error instanceof Error ? error.message : "The project could not be opened.",
        });
      });
    },
    [openEditorProject],
  );
  const paneLabelOverrides = useMemo(() => {
    const hasSidechatPane = dockState.panes.some((pane) => pane.kind === "sidechat");
    const hasNamedFilePane = dockState.panes.some(
      (pane) => pane.kind === "file" && pane.filePath !== null,
    );
    if (!hasSidechatPane && !hasNamedFilePane) {
      return undefined;
    }
    const titleByThreadId = hasSidechatPane
      ? new Map(threadSummaries.map((summary) => [summary.id, summary.title]))
      : null;
    const overrides: Record<string, string | undefined> = {};
    for (const pane of dockState.panes) {
      if (pane.kind === "sidechat" && pane.threadId) {
        overrides[pane.id] = titleByThreadId?.get(pane.threadId) || "Side";
      } else if (pane.kind === "file" && pane.filePath) {
        overrides[pane.id] = basenameOfPath(pane.filePath);
      }
    }
    return overrides;
  }, [threadSummaries, dockState.panes]);

  const shouldAcceptDockWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
      return canComposerHandlePanelWidth({
        nextWidth,
        applyWidth: (width) => {
          wrapper.style.setProperty("--sidebar-width", `${width}px`);
        },
        resetWidth: () => {
          if (previousSidebarWidth.length > 0) {
            wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
          } else {
            wrapper.style.removeProperty("--sidebar-width");
          }
        },
      });
    },
    [],
  );

  const handleAddDockPane = useCallback(
    (kind: RightDockPaneKind) => {
      requestImmediateDockHydration(kind);
      if (kind === "sidechat") {
        // Sidechat spawns a thread; reuse the composer's /side flow (correct model
        // selection) published via the registry instead of opening an empty pane.
        const createSidechat = getSidechatCreator(props.threadId);
        if (!createSidechat) {
          toastManager.add({
            type: "warning",
            title: "Side is unavailable",
            description: "Open a server-backed main thread before starting Side.",
          });
          return;
        }
        void createSidechat().catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start Side",
            description:
              error instanceof Error ? error.message : "An error occurred while creating Side.",
          });
        });
        return;
      }
      openPane(props.threadId, { kind });
    },
    [openPane, props.threadId, requestImmediateDockHydration],
  );

  const renderDockPane = useCallback(
    (
      pane: RightDockPane,
      context: { runtimeMode: DockPaneRuntimeMode; isActive: boolean },
    ): ReactNode => {
      switch (pane.kind) {
        case "browser":
          return (
            <BrowserPanel
              mode="sidebar"
              threadId={props.threadId}
              onClosePanel={() => closePane(props.threadId, pane.id)}
              runtimeMode={context.runtimeMode}
              onRequestLive={requestActiveDockPaneLive}
            />
          );
        case "diff":
          return (
            <LazyDiffPanel
              mode="sidebar"
              threadId={props.threadId}
              panelState={{
                panel: "diff",
                diffTurnId: pane.diffTurnId,
                diffFilePath: pane.diffFilePath,
              }}
              onUpdatePanelState={(patch) =>
                updatePane(props.threadId, pane.id, {
                  diffTurnId: patch.diffTurnId ?? null,
                  diffFilePath: patch.diffFilePath ?? null,
                })
              }
              onClosePanel={() => closePane(props.threadId, pane.id)}
              liveRefreshEnabled={context.isActive && dockState.open}
              queriesEnabled={context.isActive && dockState.open}
            />
          );
        case "terminal":
          if (context.runtimeMode === "preview") {
            return <PanelStateMessage>Terminal is sleeping. Restoring shortly.</PanelStateMessage>;
          }
          // Kept mounted across tab switches; visibility toggles the xterm runtime
          // instead of detaching/reattaching it (avoids the open-lag + fit flicker).
          // Also sleep it while the dock is collapsed: a closed dock keeps the pane
          // mounted (offcanvas is CSS-only), so without this the off-screen terminal
          // would keep WebGL + resize observers alive for nothing.
          return (
            <DockTerminalPane
              hostThreadId={props.threadId}
              projectId={props.projectId}
              isActive={context.isActive && dockState.open}
            />
          );
        case "git":
          return (
            <GitPanel
              hostThreadId={props.threadId}
              projectId={props.projectId}
              onClose={() => closePane(props.threadId, pane.id)}
            />
          );
        case "file":
          return (
            <DockFilePane
              workspaceRoot={workspaceRoot}
              filePath={pane.filePath}
              onReferenceInChat={handleReferenceInChat}
              onAskWhyInChat={handleAskWhyInChat}
              onCommentInChat={handleCommentInChat}
            />
          );
        case "sidechat":
          if (!pane.threadId) {
            return <RightDockPanePlaceholder kind="sidechat" />;
          }
          if (context.runtimeMode === "preview") {
            return null;
          }
          return (
            <DeferredChatView
              threadId={pane.threadId}
              paneScopeId={`dock-sidechat:${pane.id}`}
              deferMount={false}
              surfaceMode="split"
              isFocusedPane={false}
              panelState={DOCK_EMBEDDED_PANEL_STATE}
              onToggleDiff={noop}
              onToggleBrowser={noop}
              onOpenBrowserUrl={noop}
              onOpenTurnDiff={noop}
              onCloseThreadPane={() => closePane(props.threadId, pane.id)}
            />
          );
        default:
          return <RightDockPanePlaceholder kind={pane.kind} />;
      }
    },
    [
      closePane,
      dockState.open,
      handleAskWhyInChat,
      handleCommentInChat,
      handleReferenceInChat,
      props.projectId,
      props.threadId,
      requestActiveDockPaneLive,
      updatePane,
      workspaceRoot,
    ],
  );

  const handleSelectDockPane = useCallback(
    (paneId: string) => {
      requestImmediateDockHydration(dockState.panes.find((pane) => pane.id === paneId)?.kind);
      setActivePane(props.threadId, paneId);
    },
    [dockState.panes, props.threadId, requestImmediateDockHydration, setActivePane],
  );

  // The editor file path arrives via the URL, so an attacker-crafted link can
  // carry traversal segments ("../../etc"). Treat unsafe values as no selection
  // so neither the ancestor prefetch nor the preview ever queries them.
  const rawEditorFilePath = props.search.editorFilePath ?? null;
  const selectedEditorFilePath =
    rawEditorFilePath !== null && isWorkspaceRelativePathSafe(rawEditorFilePath)
      ? rawEditorFilePath
      : null;
  useEffect(() => {
    if (!selectedEditorFilePath) {
      return;
    }

    const parentPaths = collectParentDirectoryPaths(selectedEditorFilePath);
    if (parentPaths.length === 0) {
      return;
    }

    // Prefetch every ancestor listing in parallel: the explorer renders one
    // directory level at a time, so without this each depth waits for the
    // previous level's response (a per-level request waterfall).
    if (workspaceRoot) {
      for (const parentPath of parentPaths) {
        void queryClient.prefetchQuery(
          projectListDirectoriesQueryOptions({
            cwd: workspaceRoot,
            relativePath: parentPath,
            includeFiles: true,
          }),
        );
      }
    }

    setEditorExpandedDirectories((previous) => {
      let changed = false;
      const next = new Set(previous);
      for (const parentPath of parentPaths) {
        if (!next.has(parentPath)) {
          next.add(parentPath);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [workspaceRoot, queryClient, selectedEditorFilePath]);

  const editorChatPanelState = useMemo<SplitViewPanePanelState>(
    () => ({
      panel: editorCenterMode === "diff" ? "diff" : null,
      diffTurnId: editorDiffPanelState.diffTurnId,
      diffFilePath: editorDiffPanelState.diffFilePath,
      hasOpenedPanel: true,
      lastOpenPanel: "browser",
    }),
    [editorCenterMode, editorDiffPanelState.diffFilePath, editorDiffPanelState.diffTurnId],
  );

  if (props.search.view === "editor") {
    return (
      <WorkspaceFileOpenerContext.Provider value={editorFileOpener}>
        <div
          className={cn(CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME, CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME)}
        >
          <EditorWorkspaceView
            workspaceRoot={workspaceRoot}
            projectName={activeProject?.name ?? null}
            currentProjectId={activeProject?.id ?? null}
            projectOptions={editorProjectOptions}
            selectedFilePath={selectedEditorFilePath}
            expandedDirectories={editorExpandedDirectories}
            centerMode={editorCenterMode}
            diffFiles={editorDiffFiles}
            diffFilesLoading={editorDiffFilesLoading}
            selectedDiffFilePath={editorDiffPanelState.diffFilePath ?? null}
            diffOptionsControl={editorDiffOptionsControl}
            onSelectDiffFile={handleSelectEditorDiffFile}
            onSelectFile={handleSelectEditorFile}
            onToggleDirectory={handleToggleEditorDirectory}
            onCenterModeChange={setEditorCenterMode}
            onExitEditorView={handleCloseEditorView}
            onReferenceInChat={handleReferenceInChat}
            onAskWhyInChat={handleAskWhyInChat}
            onCommentInChat={handleCommentInChat}
            onSelectProject={handleSelectEditorProject}
            diffPanel={
              <LazyDiffPanel
                mode="sidebar"
                threadId={props.threadId}
                panelState={editorDiffPanelState}
                onUpdatePanelState={handleUpdateEditorDiffPanelState}
                liveRefreshEnabled={editorCenterMode === "diff"}
                // Keep diff data warm while browsing files so switching to the
                // diff tab renders instantly instead of cold-fetching.
                queriesEnabled
                hideHeader
                onRenderableFilesChange={handleEditorDiffFilesChange}
                onEditorDiffOptionsChange={handleEditorDiffOptionsChange}
              />
            }
            chatPanel={
              <SidebarInset
                className="min-h-0 min-w-0 overflow-hidden overscroll-y-none text-foreground"
                surfaceClassName={CHAT_BACKGROUND_CLASS_NAME}
              >
                <DeferredChatView
                  threadId={props.threadId}
                  paneScopeId="editor-chat"
                  deferMount={false}
                  surfaceMode="split"
                  presentationMode="editor"
                  isFocusedPane
                  panelState={editorChatPanelState}
                  onToggleDiff={handleEditorToggleDiff}
                  onToggleBrowser={noop}
                  onOpenBrowserUrl={noop}
                  onOpenTurnDiff={handleEditorOpenTurnDiff}
                />
              </SidebarInset>
            }
          />
        </div>
      </WorkspaceFileOpenerContext.Provider>
    );
  }

  return (
    <WorkspaceFileOpenerContext.Provider value={dockFileOpener}>
      <div
        className={cn(CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME, CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME)}
      >
        <ChatPaneDropOverlay
          canDropInDirection={allowAnySplitDirection}
          excludedThreadIds={excludedThreadIds}
          onDrop={handleDropThread}
          className="flex h-full min-h-0 min-w-0 flex-1"
        >
          <SidebarInset
            className={CHAT_ROUTE_INSET_SHELL_CLASS_NAME}
            surfaceClassName={CHAT_BACKGROUND_CLASS_NAME}
          >
            <DeferredChatView
              threadId={props.threadId}
              paneScopeId="single"
              deferMount={false}
              surfaceMode="single"
              isFocusedPane
              panelState={chatPanelState}
              onToggleDiff={handleToggleDiff}
              onToggleBrowser={handleToggleBrowser}
              onOpenBrowserUrl={handleOpenBrowserUrl}
              onOpenTurnDiff={handleOpenTurnDiff}
              onSplitSurface={handleSplitSurface}
              viewModeAction={{
                label: "Editor view",
                active: false,
                onClick: handleOpenEditorView,
              }}
            />
          </SidebarInset>
        </ChatPaneDropOverlay>
        <RightDock
          state={dockState}
          minWidth={SINGLE_PANEL_MIN_WIDTH}
          defaultWidth={DIFF_INLINE_DEFAULT_WIDTH}
          shouldAcceptWidth={shouldAcceptDockWidth}
          addMenuKinds={RIGHT_DOCK_ADD_MENU_KINDS}
          motionKey={props.threadId}
          activePaneRuntimeMode={activePaneRuntimeMode}
          {...(paneLabelOverrides ? { paneLabelOverrides } : {})}
          onSelectPane={handleSelectDockPane}
          onClosePane={(paneId) => closePane(props.threadId, paneId)}
          onCollapse={() => setDockOpen(props.threadId, false)}
          onOpenChange={(open) => setDockOpen(props.threadId, open)}
          onAddPane={handleAddDockPane}
          renderPane={renderDockPane}
        />
      </div>
    </WorkspaceFileOpenerContext.Provider>
  );
}

function ChatThreadRouteView() {
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const hasKnownServerThreads = useStore(
    (store) => (store.threadIds?.length ?? 0) > 0 || store.threads.length > 0,
  );
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const search = Route.useSearch();
  const threadProjectIdSelector = useMemo(
    () => createThreadProjectIdSelector(threadId),
    [threadId],
  );
  const threadExistsSelector = useMemo(() => createThreadExistsSelector(threadId), [threadId]);
  const threadProjectId: ProjectId | null = useStore(threadProjectIdSelector);
  const threadExists = useStore(threadExistsSelector);
  const draftThreadState = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const draftThreadExists = draftThreadState !== null;
  const routeThreadExists = threadExists || draftThreadExists;
  const splitView = useSplitViewStore(selectSplitView(search.splitViewId ?? null));
  const splitViewsHydrated = useSplitViewStore((store) => store.hasHydrated);
  const activeProjectId = resolveSingleProjectId({
    threadProjectId,
    draftProjectId: draftThreadState?.projectId ?? null,
  });
  const navigate = useNavigate();
  const [missingThreadRecoveryState, setMissingThreadRecoveryState] =
    useState<EmptyRouteRestoreRecoveryState>("idle");
  const mountedRef = useRef(true);
  const missingThreadRecoveryRunRef = useRef(0);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    missingThreadRecoveryRunRef.current += 1;
    setMissingThreadRecoveryState("idle");
  }, [threadId]);

  useEffect(() => {
    if (routeThreadExists && missingThreadRecoveryState !== "idle") {
      missingThreadRecoveryRunRef.current += 1;
      setMissingThreadRecoveryState("idle");
    }
  }, [missingThreadRecoveryState, routeThreadExists]);

  useEffect(() => {
    if (!threadsHydrated || !splitViewsHydrated) {
      return;
    }

    if (!routeThreadExists) {
      if (
        shouldStartMissingThreadRouteRecovery({
          hasKnownServerThreads,
          recoveryState: missingThreadRecoveryState,
          routeThreadExists,
        })
      ) {
        const recoveryRun = (missingThreadRecoveryRunRef.current += 1);
        setMissingThreadRecoveryState("pending");
        void Promise.all([
          refreshEmptyRouteRestoreSnapshot(readNativeApi()).catch(() => false),
          waitForEmptyRouteRestoreFallbackDelay(),
        ]).finally(() => {
          if (mountedRef.current && missingThreadRecoveryRunRef.current === recoveryRun) {
            setMissingThreadRecoveryState("done");
          }
        });
        return;
      }

      if (
        shouldHoldMissingThreadRouteFallback({
          hasKnownServerThreads,
          recoveryState: missingThreadRecoveryState,
          routeThreadExists,
        })
      ) {
        return;
      }
    }

    if (isSplitRoute(search)) {
      if (!splitView) {
        void navigate({
          to: "/$threadId",
          params: { threadId },
          replace: true,
          search: (previous) => ({
            ...stripDiffSearchParams(previous),
            splitViewId: undefined,
          }),
        });
      }
      return;
    }

    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
    }
  }, [
    hasKnownServerThreads,
    missingThreadRecoveryState,
    navigate,
    routeThreadExists,
    search,
    splitView,
    splitViewsHydrated,
    threadId,
    threadsHydrated,
  ]);

  if (
    !threadsHydrated ||
    !splitViewsHydrated ||
    shouldHoldMissingThreadRouteFallback({
      hasKnownServerThreads,
      recoveryState: missingThreadRecoveryState,
      routeThreadExists,
    })
  ) {
    return null;
  }

  if (splitView && search.splitViewId) {
    return <SplitChatSurface splitViewId={search.splitViewId} routeThreadId={threadId} />;
  }

  if (!routeThreadExists) {
    return null;
  }

  return <SingleChatSurface threadId={threadId} search={search} projectId={activeProjectId} />;
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  component: ChatThreadRouteView,
});
