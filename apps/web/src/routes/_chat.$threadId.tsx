// FILE: _chat.$threadId.tsx
// Purpose: Resolves the active thread route into either a single chat surface or a persisted split view.
// Layer: Route container
// Depends on: ChatView, splitViewStore, and pane-scoped browser/diff panels

import {
  type ProjectId,
  ThreadId,
  type ThreadId as ThreadIdType,
  type TurnId,
} from "@t3tools/contracts";
import { createFileRoute, retainSearchParams, useNavigate } from "@tanstack/react-router";
import {
  Suspense,
  lazy,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Schema } from "effect";
import { TbExchange } from "react-icons/tb";

import ChatView from "../components/ChatView";
import BrowserPanel from "../components/BrowserPanel";
import { ClaudeAI, OpenAI } from "../components/Icons";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../components/DiffPanelShell";
import { useComposerDraftStore } from "../composerDraftStore";
import {
  type ChatRightPanel,
  type DiffRouteSearch,
  parseDiffRouteSearch,
  stripDiffSearchParams,
} from "../diffRouteSearch";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { resolveActiveSplitView, isSplitRoute } from "../splitViewRoute";
import {
  resolveSplitViewFocusedThreadId,
  selectSplitView,
  type SplitView,
  type SplitViewId,
  type SplitViewPane,
  type SplitViewPanePanelState,
  useSplitViewStore,
} from "../splitViewStore";
import { useStore } from "../store";
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
import { Sheet, SheetPopup } from "../components/ui/sheet";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";

const DiffPanel = lazy(() => import("../components/DiffPanel"));
const DIFF_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 1180px)";
const DIFF_INLINE_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX = 22 * 16;
const SPLIT_PANE_CHAT_MIN_WIDTH = 20 * 16;
const SINGLE_PANEL_MIN_WIDTH = 26 * 16;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;
const RIGHT_PANEL_SIDEBAR_WIDTH_STORAGE_KEY = "chat_right_panel_width";

const RightPanelSheet = (props: {
  children: ReactNode;
  panelOpen: boolean;
  onClosePanel: () => void;
}) => {
  return (
    <Sheet
      open={props.panelOpen}
      onOpenChange={(open) => {
        if (!open) {
          props.onClosePanel();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className="w-[min(88vw,820px)] max-w-[820px] p-0"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
};

const DiffLoadingFallback = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
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
}) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
        <DiffPanel
          mode={props.mode}
          {...(props.threadId !== undefined ? { threadId: props.threadId } : {})}
          {...(props.panelState ? { panelState: props.panelState } : {})}
          {...(props.onUpdatePanelState ? { onUpdatePanelState: props.onUpdatePanelState } : {})}
        />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

function canComposerHandlePanelWidth(input: {
  nextWidth: number;
  paneScopeId?: string;
  applyWidth: (width: number) => void;
  resetWidth: () => void;
}) {
  const scopeSelector = input.paneScopeId
    ? `[data-chat-composer-form='true'][data-chat-pane-scope='${input.paneScopeId}']`
    : "[data-chat-composer-form='true']";
  const composerForm = document.querySelector<HTMLElement>(scopeSelector);
  if (!composerForm) return true;

  const composerViewport = composerForm.parentElement;
  if (!composerViewport) return true;

  input.applyWidth(input.nextWidth);

  const viewportStyle = window.getComputedStyle(composerViewport);
  const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
  const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
  const viewportContentWidth = Math.max(
    0,
    composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
  );
  const formRect = composerForm.getBoundingClientRect();
  const composerFooter = composerForm.querySelector<HTMLElement>(
    "[data-chat-composer-footer='true']",
  );
  const composerRightActions = composerForm.querySelector<HTMLElement>(
    "[data-chat-composer-actions='right']",
  );
  const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
  const composerFooterGap = composerFooter
    ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
      Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
      0
    : 0;
  const minimumComposerWidth =
    COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
  const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
  const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
  const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

  input.resetWidth();

  return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
}

const PanePanelInlineSidebar = (props: {
  panelOpen: boolean;
  onClosePanel: () => void;
  onOpenPanel: () => void;
  renderPanelContent: boolean;
  panel: ChatRightPanel | null | undefined;
  threadId: ThreadIdType | null;
  paneScopeId?: string;
  panelState?: Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">;
  onUpdatePanelState?: (
    patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
  ) => void;
}) => {
  const {
    panelOpen,
    onClosePanel,
    onOpenPanel,
    renderPanelContent,
    panel,
    threadId,
    paneScopeId,
    panelState,
    onUpdatePanelState,
  } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenPanel();
        return;
      }
      onClosePanel();
    },
    [onClosePanel, onOpenPanel],
  );
  const shouldAcceptInlineSidebarWidth = useCallback(
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
        ...(paneScopeId ? { paneScopeId } : {}),
      });
    },
    [paneScopeId],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={panelOpen}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": DIFF_INLINE_DEFAULT_WIDTH } as CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border/50 bg-card text-foreground"
        resizable={{
          minWidth: SINGLE_PANEL_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: RIGHT_PANEL_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {renderPanelContent && threadId ? (
          panel === "browser" ? (
            <BrowserPanel mode="sidebar" threadId={threadId} onClosePanel={onClosePanel} />
          ) : (
            <LazyDiffPanel
              mode="sidebar"
              threadId={threadId}
              {...(panelState ? { panelState } : {})}
              {...(onUpdatePanelState ? { onUpdatePanelState } : {})}
            />
          )
        ) : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};

// Split panes cannot reuse the desktop Sidebar primitive because it positions the panel
// against the viewport. This embedded shell keeps browser/diff content anchored to the pane.
function SplitPaneEmbeddedPanel(props: {
  splitViewId: SplitViewId;
  pane: SplitViewPane;
  paneScopeId: string;
  panelOpen: boolean;
  panel: ChatRightPanel | null | undefined;
  threadId: ThreadIdType | null;
  onClosePanel: () => void;
  panelState: Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">;
  onUpdatePanelState: (
    patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
  ) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const storageKey = `${RIGHT_PANEL_SIDEBAR_WIDTH_STORAGE_KEY}:${props.splitViewId}:${props.pane}`;
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    return getLocalStorageItem(storageKey, Schema.Finite) ?? SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX;
  });

  useEffect(() => {
    setPanelWidth(
      getLocalStorageItem(storageKey, Schema.Finite) ?? SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX,
    );
  }, [storageKey]);

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
    (event: React.PointerEvent<HTMLDivElement>) => {
      const wrapper = wrapperRef.current;
      const parent = wrapper?.parentElement;
      if (!wrapper || !parent) return;

      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = panelWidth;
      const maxWidth = Math.max(
        SINGLE_PANEL_MIN_WIDTH,
        parent.clientWidth - SPLIT_PANE_CHAT_MIN_WIDTH,
      );

      const onPointerMove = (moveEvent: PointerEvent) => {
        const delta = startX - moveEvent.clientX;
        const nextWidth = Math.max(SINGLE_PANEL_MIN_WIDTH, Math.min(maxWidth, startWidth + delta));
        if (!shouldAcceptEmbeddedWidth(nextWidth)) {
          return;
        }
        setPanelWidth(nextWidth);
        setLocalStorageItem(storageKey, nextWidth, Schema.Finite);
      };

      const onPointerUp = () => {
        document.body.style.removeProperty("user-select");
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      };

      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [panelWidth, shouldAcceptEmbeddedWidth, storageKey],
  );

  if (!props.panelOpen || !props.threadId) {
    return null;
  }

  return (
    <div
      ref={wrapperRef}
      className="relative flex h-full min-h-0 min-w-0 flex-none border-l border-border/50 bg-card text-foreground"
      style={{ width: `${panelWidth}px` } as CSSProperties}
    >
      <div
        className="absolute inset-y-0 left-0 z-20 w-2 -translate-x-1/2 cursor-col-resize bg-transparent before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border/65"
        onPointerDown={startResize}
      />
      {props.panel === "browser" ? (
        <BrowserPanel mode="sidebar" threadId={props.threadId} onClosePanel={props.onClosePanel} />
      ) : (
        <LazyDiffPanel
          mode="sidebar"
          threadId={props.threadId}
          panelState={props.panelState}
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

function normalizeSingleSearchFromPane(panelState: SplitViewPanePanelState): DiffRouteSearch {
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
    modelSelection: { provider: "codex" | "claudeAgent" };
  }[];
  projects: readonly { id: ProjectId; name: string }[];
  otherPaneThreadId: ThreadIdType | null;
  onSelectThread: (threadId: ThreadIdType) => void;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col items-center bg-background px-6 pt-16",
        props.isFocused ? "ring-1 ring-inset ring-primary/25" : "",
      )}
      onMouseDown={props.onFocus}
    >
      <div className="w-full max-w-sm space-y-4">
        <p className="text-center text-sm font-medium text-foreground/70">Select a chat</p>
        <div className="max-h-[60vh] space-y-1 overflow-y-auto">
          {props.threads.map((thread) => {
            const isUsed = thread.id === props.otherPaneThreadId;
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
                    : "border-border/55 hover:bg-accent/40",
                )}
                onClick={() => {
                  if (!isUsed) props.onSelectThread(thread.id);
                }}
              >
                <PickerProviderGlyph
                  provider={thread.modelSelection.provider}
                  className="size-4 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {thread.title || "New chat"}
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

function PickerProviderGlyph(props: { provider: "codex" | "claudeAgent"; className?: string }) {
  if (props.provider === "claudeAgent") {
    return <ClaudeAI aria-hidden="true" className={cn("text-[#d97757]", props.className)} />;
  }

  return <OpenAI aria-hidden="true" className={cn("text-muted-foreground/60", props.className)} />;
}

function SplitPaneSurface(props: {
  splitView: SplitView;
  pane: SplitViewPane;
  threadId: ThreadIdType | null;
  isFocused: boolean;
  threads: readonly {
    id: ThreadIdType;
    title: string | null;
    projectId: ProjectId;
    modelSelection: { provider: "codex" | "claudeAgent" };
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
  onChooseThread: () => void;
  onSelectThread: (threadId: ThreadIdType) => void;
}) {
  const paneScopeId = `${props.splitView.id}:${props.pane}`;
  const panelState = props.pane === "left" ? props.splitView.leftPanel : props.splitView.rightPanel;
  const panelOpen = panelState.panel !== null;
  const shouldRenderPanelContent = panelOpen || panelState.hasOpenedPanel;
  const otherPaneThreadId =
    props.pane === "left" ? props.splitView.rightThreadId : props.splitView.leftThreadId;

  return (
    <div className="group relative flex min-h-0 min-w-0 flex-1 bg-background">
      {props.threadId ? (
        <div className="pointer-events-none absolute right-3 top-[3.75rem] z-20 sm:right-5 sm:top-[4.25rem]">
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            aria-label={`Choose chat for the ${props.pane} split pane`}
            title="Choose chat"
            className={cn(
              "pointer-events-auto transition-opacity",
              !props.isFocused ? "opacity-0 group-hover:opacity-100" : "",
            )}
            onClick={(event) => {
              event.stopPropagation();
              props.onChooseThread();
            }}
          >
            <TbExchange className="size-4" />
          </Button>
        </div>
      ) : null}
      <SidebarInset
        className={cn(
          "min-h-0 min-w-0 overflow-hidden overscroll-y-none rounded-none bg-background text-foreground transition-shadow",
          props.isFocused ? "ring-1 ring-inset ring-primary/25" : "",
        )}
        onMouseDown={props.onFocus}
      >
        {props.threadId ? (
          <ChatView
            key={`${props.splitView.id}:${props.pane}:${props.threadId}`}
            threadId={props.threadId}
            paneScopeId={paneScopeId}
            surfaceMode="split"
            isFocusedPane={props.isFocused}
            panelState={panelState}
            onToggleDiffPanel={props.onToggleDiff}
            onToggleBrowserPanel={props.onToggleBrowser}
            onOpenTurnDiffPanel={props.onOpenTurnDiff}
            onMaximizeSurface={props.onMaximize}
          />
        ) : (
          <SplitPaneEmptyState
            isFocused={props.isFocused}
            onFocus={props.onFocus}
            threads={props.threads}
            projects={props.projects}
            otherPaneThreadId={otherPaneThreadId}
            onSelectThread={props.onSelectThread}
          />
        )}
      </SidebarInset>
      <SplitPaneEmbeddedPanel
        splitViewId={props.splitView.id}
        pane={props.pane}
        paneScopeId={paneScopeId}
        panelOpen={panelOpen && shouldRenderPanelContent}
        panel={panelState.panel}
        threadId={props.threadId}
        onClosePanel={props.onClosePanel}
        panelState={panelState}
        onUpdatePanelState={props.onUpdatePanelState}
      />
    </div>
  );
}

function SplitChatSurface(props: { splitViewId: SplitViewId; routeThreadId: ThreadIdType }) {
  const navigate = useNavigate();
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const splitView = useSplitViewStore(selectSplitView(props.splitViewId));
  const setFocusedPane = useSplitViewStore((store) => store.setFocusedPane);
  const setRatio = useSplitViewStore((store) => store.setRatio);
  const setPanePanelState = useSplitViewStore((store) => store.setPanePanelState);
  const replacePaneThread = useSplitViewStore((store) => store.replacePaneThread);
  const removeSplitView = useSplitViewStore((store) => store.removeSplitView);
  const rootRef = useRef<HTMLDivElement>(null);
  const [threadPickerPane, setThreadPickerPane] = useState<SplitViewPane | null>(null);
  const {
    splitView: activeSplitView,
    focusedThreadId,
    routePane,
  } = resolveActiveSplitView({
    splitView,
    routeThreadId: props.routeThreadId,
  });

  useEffect(() => {
    if (!activeSplitView) {
      void navigate({
        to: "/$threadId",
        params: { threadId: props.routeThreadId },
        replace: true,
        search: (previous) => ({ ...stripDiffSearchParams(previous), splitViewId: undefined }),
      });
      return;
    }

    if (
      activeSplitView.leftThreadId &&
      activeSplitView.rightThreadId &&
      activeSplitView.leftThreadId === activeSplitView.rightThreadId
    ) {
      replacePaneThread(activeSplitView.id, "right", null);
      setFocusedPane(activeSplitView.id, "left");
      return;
    }

    const focusedPaneThreadId =
      activeSplitView.focusedPane === "left"
        ? activeSplitView.leftThreadId
        : activeSplitView.rightThreadId;
    const normalizedFocusedThreadId = resolveSplitViewFocusedThreadId(activeSplitView);
    if (routePane && routePane !== activeSplitView.focusedPane && focusedPaneThreadId !== null) {
      setFocusedPane(activeSplitView.id, routePane);
      return;
    }

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
    navigate,
    props.routeThreadId,
    replacePaneThread,
    routePane,
    setFocusedPane,
  ]);

  const setPaneFocus = useCallback(
    (pane: SplitViewPane) => {
      if (!activeSplitView) return;
      setFocusedPane(activeSplitView.id, pane);
      const nextThreadId =
        pane === "left"
          ? (activeSplitView.leftThreadId ?? activeSplitView.rightThreadId)
          : (activeSplitView.rightThreadId ?? activeSplitView.leftThreadId);
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
      pane: SplitViewPane,
      patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
    ) => {
      if (!activeSplitView) return;
      const previousState =
        pane === "left" ? activeSplitView.leftPanel : activeSplitView.rightPanel;
      setPanePanelState(activeSplitView.id, pane, {
        ...patch,
        hasOpenedPanel:
          previousState.hasOpenedPanel || (patch.panel ?? previousState.panel) !== null,
        lastOpenPanel:
          patch.panel === "browser" || patch.panel === "diff"
            ? patch.panel
            : previousState.lastOpenPanel,
      });
    },
    [activeSplitView, setPanePanelState],
  );

  const togglePanePanel = useCallback(
    (pane: SplitViewPane, panel: ChatRightPanel) => {
      if (!activeSplitView) return;
      const paneThreadId =
        pane === "left" ? activeSplitView.leftThreadId : activeSplitView.rightThreadId;
      if (!paneThreadId) {
        return;
      }
      const previousState =
        pane === "left" ? activeSplitView.leftPanel : activeSplitView.rightPanel;
      updatePanePanelState(pane, {
        panel: previousState.panel === panel ? null : panel,
        diffTurnId: panel === "diff" ? previousState.diffTurnId : null,
        diffFilePath: panel === "diff" ? previousState.diffFilePath : null,
      });
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
      togglePanePanel(activeSplitView.focusedPane, "browser");
    });

    return () => {
      unsubscribe?.();
    };
  }, [activeSplitView, togglePanePanel]);

  const closePanePanel = useCallback(
    (pane: SplitViewPane) => {
      updatePanePanelState(pane, {
        panel: null,
      });
    },
    [updatePanePanelState],
  );

  const openPaneTurnDiff = useCallback(
    (pane: SplitViewPane, turnId: TurnId, filePath?: string) => {
      updatePanePanelState(pane, {
        panel: "diff",
        diffTurnId: turnId,
        diffFilePath: filePath ?? null,
      });
    },
    [updatePanePanelState],
  );

  const maximizeFocusedPane = useCallback(() => {
    if (!activeSplitView) return;
    const nextThreadId = focusedThreadId;
    const focusedPanelState =
      activeSplitView.focusedPane === "left"
        ? activeSplitView.leftPanel
        : activeSplitView.rightPanel;
    removeSplitView(activeSplitView.id);
    if (!nextThreadId) {
      void navigate({ to: "/", replace: true });
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId: nextThreadId },
      replace: true,
      search: () => normalizeSingleSearchFromPane(focusedPanelState),
    });
  }, [activeSplitView, focusedThreadId, navigate, removeSplitView]);

  const activeSplitViewIdRef = useRef<SplitViewId | null>(null);
  activeSplitViewIdRef.current = activeSplitView?.id ?? null;

  useEffect(() => {
    const root = rootRef.current;
    const splitViewId = activeSplitViewIdRef.current;
    if (!root || !splitViewId) return;

    const divider = root.querySelector<HTMLElement>("[data-split-divider='true']");
    if (!divider) return;

    const handlePointerMove = (event: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const id = activeSplitViewIdRef.current;
      if (!id) return;
      setRatio(id, (event.clientX - rect.left) / rect.width);
    };

    const handlePointerUp = () => {
      document.body.style.removeProperty("user-select");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    const onPointerDown = (event: PointerEvent) => {
      event.preventDefault();
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    };

    divider.addEventListener("pointerdown", onPointerDown);
    return () => {
      divider.removeEventListener("pointerdown", onPointerDown);
      handlePointerUp();
    };
  }, [activeSplitView?.id, setRatio]);

  if (!activeSplitView) {
    return null;
  }

  const leftBasis = `${activeSplitView.ratio * 100}%`;
  const rightBasis = `${(1 - activeSplitView.ratio) * 100}%`;
  const selectableThreads = threads.toSorted(
    (left, right) =>
      Date.parse(right.updatedAt ?? right.createdAt) - Date.parse(left.updatedAt ?? left.createdAt),
  );
  const chooseThreadForPane = (threadId: ThreadIdType, paneOverride?: SplitViewPane) => {
    const pane = paneOverride ?? threadPickerPane;
    if (!pane) {
      return;
    }
    const otherPane: SplitViewPane = pane === "left" ? "right" : "left";
    const currentPaneThreadId =
      pane === "left" ? activeSplitView.leftThreadId : activeSplitView.rightThreadId;
    const otherPaneThreadId =
      otherPane === "left" ? activeSplitView.leftThreadId : activeSplitView.rightThreadId;

    setThreadPickerPane(null);

    if (threadId === otherPaneThreadId) {
      setPaneFocus(otherPane);
      return;
    }

    setFocusedPane(activeSplitView.id, pane);
    if (threadId !== currentPaneThreadId) {
      replacePaneThread(activeSplitView.id, pane, threadId);
      setPanePanelState(activeSplitView.id, pane, {
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

  return (
    <>
      <div
        ref={rootRef}
        className="flex h-dvh min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
      >
        <div
          className="flex min-h-0 min-w-0"
          style={{ flexBasis: leftBasis, flexGrow: 0, flexShrink: 1 }}
        >
          <SplitPaneSurface
            splitView={activeSplitView}
            pane="left"
            threadId={activeSplitView.leftThreadId}
            isFocused={activeSplitView.focusedPane === "left"}
            threads={selectableThreads}
            projects={projects}
            onFocus={() => setPaneFocus("left")}
            onToggleDiff={() => togglePanePanel("left", "diff")}
            onToggleBrowser={() => togglePanePanel("left", "browser")}
            onOpenTurnDiff={(turnId, filePath) => openPaneTurnDiff("left", turnId, filePath)}
            onClosePanel={() => closePanePanel("left")}
            onUpdatePanelState={(patch) => updatePanePanelState("left", patch)}
            onMaximize={maximizeFocusedPane}
            onChooseThread={() => {
              setPaneFocus("left");
              setThreadPickerPane("left");
            }}
            onSelectThread={(threadId) => chooseThreadForPane(threadId, "left")}
          />
        </div>
        <div
          data-split-divider="true"
          className="relative z-10 w-px shrink-0 cursor-col-resize bg-border/70 before:absolute before:inset-y-0 before:-left-1 before:w-2 before:bg-transparent"
        />
        <div
          className="flex min-h-0 min-w-0 flex-1"
          style={{ flexBasis: rightBasis, flexGrow: 1, flexShrink: 1 }}
        >
          <SplitPaneSurface
            splitView={activeSplitView}
            pane="right"
            threadId={activeSplitView.rightThreadId}
            isFocused={activeSplitView.focusedPane === "right"}
            threads={selectableThreads}
            projects={projects}
            onFocus={() => setPaneFocus("right")}
            onToggleDiff={() => togglePanePanel("right", "diff")}
            onToggleBrowser={() => togglePanePanel("right", "browser")}
            onOpenTurnDiff={(turnId, filePath) => openPaneTurnDiff("right", turnId, filePath)}
            onClosePanel={() => closePanePanel("right")}
            onUpdatePanelState={(patch) => updatePanePanelState("right", patch)}
            onMaximize={maximizeFocusedPane}
            onChooseThread={() => {
              setPaneFocus("right");
              setThreadPickerPane("right");
            }}
            onSelectThread={(threadId) => chooseThreadForPane(threadId, "right")}
          />
        </div>
      </div>
      <Dialog
        open={threadPickerPane !== null}
        onOpenChange={(open) => {
          if (!open) {
            setThreadPickerPane(null);
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader className="items-center text-center">
            <DialogTitle>Choose Chat</DialogTitle>
            <DialogDescription className="max-w-sm text-center">
              Pick which chat should appear in the {threadPickerPane ?? "focused"} split pane.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <div className="max-h-[56vh] space-y-1 overflow-y-auto">
              {selectableThreads.map((thread) => {
                const projectName =
                  projects.find((project) => project.id === thread.projectId)?.name ?? "Project";
                const isSelected =
                  threadPickerPane === "left"
                    ? activeSplitView.leftThreadId === thread.id
                    : activeSplitView.rightThreadId === thread.id;
                return (
                  <button
                    key={thread.id}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                      isSelected
                        ? "border-primary/35 bg-accent/55"
                        : "border-border/55 hover:bg-accent/40",
                    )}
                    onClick={() => chooseThreadForPane(thread.id)}
                  >
                    <PickerProviderGlyph
                      provider={thread.modelSelection.provider}
                      className="size-4 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {thread.title}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{projectName}</div>
                    </div>
                  </button>
                );
              })}
            </div>
            <DialogFooter variant="bare">
              <Button type="button" variant="outline" onClick={() => setThreadPickerPane(null)}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function SingleChatSurface(props: {
  threadId: ThreadIdType;
  search: DiffRouteSearch;
  projectId: ProjectId | null;
}) {
  const navigate = useNavigate();
  const shouldUseDiffSheet = useMediaQuery(DIFF_INLINE_LAYOUT_MEDIA_QUERY);
  const createSplitView = useSplitViewStore((store) => store.createFromThread);
  const activePanel = props.search.panel;
  const panelOpen = activePanel !== undefined;
  const [hasOpenedPanel, setHasOpenedPanel] = useState(panelOpen);
  const [lastOpenPanel, setLastOpenPanel] = useState<ChatRightPanel>(activePanel ?? "browser");
  const closePanel = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId: props.threadId },
      search: (previous) => ({ ...stripDiffSearchParams(previous), panel: undefined }),
    });
  }, [navigate, props.threadId]);
  const openPanel = useCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId: props.threadId },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return lastOpenPanel === "browser"
          ? { ...rest, panel: "browser" }
          : { ...rest, panel: "diff", diff: "1" };
      },
    });
  }, [lastOpenPanel, navigate, props.threadId]);
  const handleSplitSurface = useCallback(() => {
    if (!props.projectId) return;
    const splitViewId = createSplitView({
      sourceThreadId: props.threadId,
      ownerProjectId: props.projectId,
    });
    void navigate({
      to: "/$threadId",
      params: { threadId: props.threadId },
      replace: true,
      search: () => ({ splitViewId }),
    });
  }, [createSplitView, navigate, props.projectId, props.threadId]);

  useEffect(() => {
    if (panelOpen) {
      setHasOpenedPanel(true);
    }
  }, [panelOpen]);

  useEffect(() => {
    if (activePanel) {
      setLastOpenPanel(activePanel);
    }
  }, [activePanel]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "toggle-browser") return;
      void navigate({
        to: "/$threadId",
        params: { threadId: props.threadId },
        replace: true,
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return activePanel === "browser"
            ? { ...rest, panel: undefined }
            : { ...rest, panel: "browser" };
        },
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [activePanel, navigate, props.threadId]);

  const shouldRenderPanelContent = activePanel !== undefined && (panelOpen || hasOpenedPanel);

  if (!shouldUseDiffSheet) {
    return (
      <div className="flex h-dvh min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
        <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none rounded-l-2xl bg-background text-foreground">
          <ChatView
            key={props.threadId}
            threadId={props.threadId}
            onSplitSurface={handleSplitSurface}
          />
        </SidebarInset>
        <PanePanelInlineSidebar
          panelOpen={panelOpen}
          onClosePanel={closePanel}
          onOpenPanel={openPanel}
          renderPanelContent={shouldRenderPanelContent}
          panel={activePanel}
          threadId={props.threadId}
        />
      </div>
    );
  }

  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none rounded-l-2xl bg-background text-foreground">
        <ChatView
          key={props.threadId}
          threadId={props.threadId}
          onSplitSurface={handleSplitSurface}
        />
      </SidebarInset>
      <RightPanelSheet panelOpen={panelOpen} onClosePanel={closePanel}>
        {shouldRenderPanelContent ? (
          activePanel === "browser" ? (
            <BrowserPanel mode="sheet" threadId={props.threadId} onClosePanel={closePanel} />
          ) : (
            <LazyDiffPanel mode="sheet" />
          )
        ) : null}
      </RightPanelSheet>
    </>
  );
}

function ChatThreadRouteView() {
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const search = Route.useSearch();
  const threadProjectId = useStore(
    (store) => store.threads.find((thread) => thread.id === threadId)?.projectId ?? null,
  );
  const threadExists = useStore((store) => store.threads.some((thread) => thread.id === threadId));
  const draftThreadState = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const draftThreadExists = draftThreadState !== null;
  const routeThreadExists = threadExists || draftThreadExists;
  const splitView = useSplitViewStore(selectSplitView(search.splitViewId ?? null));
  const activeProjectId = resolveSingleProjectId({
    threadProjectId,
    draftProjectId: draftThreadState?.projectId ?? null,
  });
  const navigate = useNavigate();

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    if (isSplitRoute(search)) {
      if (!splitView) {
        void navigate({
          to: "/$threadId",
          params: { threadId },
          replace: true,
          search: (previous) => ({ ...stripDiffSearchParams(previous), splitViewId: undefined }),
        });
      }
      return;
    }

    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
    }
  }, [navigate, routeThreadExists, search, splitView, threadId, threadsHydrated]);

  if (!threadsHydrated) {
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
  search: {
    middlewares: [retainSearchParams<DiffRouteSearch>(["panel", "diff"])],
  },
  component: ChatThreadRouteView,
});
