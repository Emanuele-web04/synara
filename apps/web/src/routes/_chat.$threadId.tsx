// FILE: _chat.$threadId.tsx
// Purpose: Resolves the active thread route into either a single chat surface or a persisted split view.
// Layer: Route container
// Depends on: ChatView, splitViewStore, splitView.logic, ChatPaneDropOverlay, and pane-scoped browser/diff panels

import {
  type ProjectId,
  ThreadId,
  type ThreadId as ThreadIdType,
  type TurnId,
} from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { startTransition, type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";

import BrowserPanel from "../components/BrowserPanel";
import { ChatPaneDropOverlay } from "../components/chat-drop-overlay/ChatPaneDropOverlay";
import { useComposerDraftStore } from "../composerDraftStore";
import { useDockPaneRuntimeActivation } from "../hooks/useDockPaneRuntimeActivation";
import {
  type DiffRouteSearch,
  parseDiffRouteSearch,
  stripDiffSearchParams,
} from "../diffRouteSearch";
import { isSplitRoute } from "../splitViewRoute";
import {
  selectSplitView,
  type SplitDirection,
  type SplitDropSide,
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
import { GitPanel } from "../components/chat/GitPanel";
import { PanelStateMessage } from "../components/chat/PanelStateMessage";
import { RIGHT_DOCK_ADD_MENU_KINDS } from "../components/chat/rightDockPaneMeta";
import { type DockPaneRuntimeMode } from "../lib/dockPaneActivation";
import { canComposerHandlePanelWidth } from "../lib/panelResize";
import { getSidechatCreator } from "../lib/sidechatCreatorRegistry";
import { toastManager } from "../components/ui/toast";
import { useStore } from "../store";
import {
  createSidebarThreadSummariesSelector,
  createThreadExistsSelector,
  createThreadProjectIdSelector,
} from "../storeSelectors";
import { resolveRoutePanelBootstrap } from "./-chatThreadRoute.logic";
import {
  CHAT_BACKGROUND_CLASS_NAME,
  CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
  CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
  CHAT_ROUTE_INSET_SHELL_CLASS_NAME,
} from "../components/chat/composerPickerStyles";
import { cn } from "~/lib/utils";
import { SidebarInset } from "~/components/ui/sidebar";

import {
  ChatMountSkeleton,
  DeferredChatView,
  DIFF_INLINE_DEFAULT_WIDTH,
  DOCK_EMBEDDED_PANEL_STATE,
  LazyDiffPanel,
  LazyReviewDockPane,
  PaneRenderer,
  RIGHT_PANEL_SIDEBAR_WIDTH_STORAGE_KEY,
  RightDockPanePlaceholder,
  SINGLE_PANEL_MIN_WIDTH,
  SplitPaneSurface,
  allowAnySplitDirection,
  noop,
  normalizeSingleSearchFromPane,
  resolveSingleProjectId,
} from "./-chatThreadRoute.panes";
import { SplitChatSurface } from "./-chatThreadRoute.split";

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
  const lastAppliedRoutePanelSearchKeyRef = useRef<string | null>(null);

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

  const reviewOpen = activePane?.kind === "review";

  const handleToggleDiff = useCallback(() => {
    requestImmediateDockHydration("diff");
    toggleSingletonPane(props.threadId, { kind: "diff" });
  }, [props.threadId, requestImmediateDockHydration, toggleSingletonPane]);
  const handleToggleBrowser = useCallback(() => {
    requestImmediateDockHydration("browser");
    toggleSingletonPane(props.threadId, { kind: "browser" });
  }, [props.threadId, requestImmediateDockHydration, toggleSingletonPane]);
  const handleToggleReview = useCallback(() => {
    requestImmediateDockHydration("review");
    toggleSingletonPane(props.threadId, { kind: "review" });
  }, [props.threadId, requestImmediateDockHydration, toggleSingletonPane]);
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
  const paneLabelOverrides = useMemo(() => {
    const hasSidechatPane = dockState.panes.some((pane) => pane.kind === "sidechat");
    if (!hasSidechatPane) {
      return undefined;
    }
    const titleByThreadId = new Map(threadSummaries.map((summary) => [summary.id, summary.title]));
    const overrides: Record<string, string | undefined> = {};
    for (const pane of dockState.panes) {
      if (pane.kind === "sidechat" && pane.threadId) {
        overrides[pane.id] = titleByThreadId.get(pane.threadId) || "Side chat";
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
            title: "Sidechat is unavailable",
            description: "Open a server-backed main thread before starting a sidechat.",
          });
          return;
        }
        void createSidechat().catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start sidechat",
            description:
              error instanceof Error
                ? error.message
                : "An error occurred while creating the sidechat.",
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
        case "review":
          return <LazyReviewDockPane threadId={props.threadId} />;
        case "sidechat":
          if (!pane.threadId) {
            return <RightDockPanePlaceholder kind="sidechat" />;
          }
          if (context.runtimeMode === "preview") {
            return <ChatMountSkeleton />;
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
      props.projectId,
      props.threadId,
      requestActiveDockPaneLive,
      updatePane,
    ],
  );

  const handleSelectDockPane = useCallback(
    (paneId: string) => {
      requestImmediateDockHydration(dockState.panes.find((pane) => pane.id === paneId)?.kind);
      setActivePane(props.threadId, paneId);
    },
    [dockState.panes, props.threadId, requestImmediateDockHydration, setActivePane],
  );

  return (
    <div className={cn(CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME, CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME)}>
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
            onOpenTurnDiff={handleOpenTurnDiff}
            reviewOpen={reviewOpen}
            onToggleReview={handleToggleReview}
            onSplitSurface={handleSplitSurface}
          />
        </SidebarInset>
      </ChatPaneDropOverlay>
      <RightDock
        state={dockState}
        minWidth={SINGLE_PANEL_MIN_WIDTH}
        defaultWidth={DIFF_INLINE_DEFAULT_WIDTH}
        storageKey={`${RIGHT_PANEL_SIDEBAR_WIDTH_STORAGE_KEY}:dock:v2`}
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
  );
}

function ChatThreadRouteView() {
  const threadsHydrated = useStore((store) => store.threadsHydrated);
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

  useEffect(() => {
    if (!threadsHydrated || !splitViewsHydrated) {
      return;
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
    navigate,
    routeThreadExists,
    search,
    splitView,
    splitViewsHydrated,
    threadId,
    threadsHydrated,
  ]);

  if (!threadsHydrated || !splitViewsHydrated) {
    return <ChatMountSkeleton />;
  }

  if (splitView && search.splitViewId) {
    return <SplitChatSurface splitViewId={search.splitViewId} routeThreadId={threadId} />;
  }

  if (!routeThreadExists) {
    return <ChatMountSkeleton />;
  }

  return <SingleChatSurface threadId={threadId} search={search} projectId={activeProjectId} />;
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  component: ChatThreadRouteView,
});
