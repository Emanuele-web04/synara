// FILE: CompactBottomTerminalDrawer.tsx
// Purpose: Compact, tileable bottom terminal drawer replacing the right-sidebar terminal.
// Layer: Chat terminal UI
// Depends on: bottomTerminalStore, terminalStateStore, TerminalViewport, and shared panelResize helpers.

import { type ProjectId, type ResolvedKeybindingsConfig, type ThreadId } from "@synara/contracts";
import { resolveThreadWorkspaceCwd } from "@synara/shared/threadEnvironment";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useAppSettings } from "~/appSettings";
import { selectBottomTerminalState, useBottomTerminalStore } from "~/bottomTerminalStore";
import {
  type BottomTerminalTab,
  type TerminalTileDirection,
  type TerminalTileRect,
  clampBottomTerminalHeight,
  clampTerminalTileRatio,
  collectTerminalTileLeaves,
  findTerminalTileById,
  layoutTerminalTiles,
  MAX_BOTTOM_TERMINAL_HEIGHT_PX,
  MIN_BOTTOM_TERMINAL_HEIGHT_PX,
  replaceTerminalTileNode,
  resolveActiveBottomTerminalTab,
} from "~/bottomTerminalStore.logic";
import {
  closeBottomTerminalPane,
  useTerminalSurfaceController,
} from "~/hooks/useTerminalSurfaceController";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTranslation } from "~/i18n";
import { shortcutLabelForCommand } from "~/keybindings";
import { SINGLE_CHAT_PANE_SCOPE_ID } from "~/lib/chatPaneScope";
import {
  DISCLOSURE_CLEANUP_BUFFER_MS,
  DISCLOSURE_HEIGHT_MOTION_CLASS,
  DISCLOSURE_TRANSITION_MS,
} from "~/lib/disclosureMotion";
import { dockTerminalThreadId } from "~/lib/dockTerminalScope";
import {
  ChevronDownIcon,
  PanelCollapseIcon,
  PanelExpandIcon,
  PlusIcon,
  SquareSplitHorizontal,
  SquareSplitVertical,
  TerminalIcon,
  XIcon,
} from "~/lib/icons";
import {
  attachPanelPointerOverlaySession,
  createPanelResizeOverlay,
  removePanelResizeOverlay,
} from "~/lib/panelResize";
import {
  getTerminalContextComposerTarget,
  subscribeTerminalContextComposerTarget,
} from "~/lib/terminalContextComposerRegistry";
import { cn, getNavigatorPlatform } from "~/lib/utils";
import { projectScriptRuntimeEnv } from "~/projectScripts";
import { useStore } from "~/store";
import { createProjectSelector, createThreadWorkspaceMetadataSelector } from "~/storeSelectors";
import { useTerminalStateStore } from "~/terminalStateStore";
import TerminalActivityIndicator from "../terminal/TerminalActivityIndicator";
import TerminalViewport from "../terminal/TerminalViewport";
import { IconButton } from "../ui/icon-button";
import { DOCK_HEADER_ICON_BUTTON_CLASS } from "./chatHeaderControls";

const MAXIMIZED_HEIGHT_FRACTION = 0.58;

function tileRectStyle(rect: TerminalTileRect): CSSProperties {
  return {
    left: `${rect.left * 100}%`,
    top: `${rect.top * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
}

function TileSplitDivider(props: {
  splitNodeId: string;
  direction: TerminalTileDirection;
  ratio: number;
  onPreviewRatio: (splitNodeId: string, ratio: number) => void;
  onFinishResize: (splitNodeId: string, ratio: number | null) => void;
}) {
  const { splitNodeId, direction } = props;
  const previewRatio = useStableCallback(props.onPreviewRatio);
  const finishResize = useStableCallback(props.onFinishResize);
  const abortResizeRef = useRef<(() => void) | null>(null);
  useEffect(() => () => abortResizeRef.current?.(), []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    abortResizeRef.current?.();
    const parent = event.currentTarget.parentElement;
    if (!parent) return;
    event.preventDefault();
    const rect = parent.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const computeRatio = (clientX: number, clientY: number) =>
      clampTerminalTileRatio(
        direction === "horizontal"
          ? (clientX - rect.left) / rect.width
          : (clientY - rect.top) / rect.height,
      );

    let latestRatio = props.ratio;
    let frameId = 0;
    const cursor = direction === "horizontal" ? "col-resize" : "row-resize";
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const overlay = createPanelResizeOverlay(cursor);
    let detach = () => {};

    const apply = () => {
      frameId = 0;
      previewRatio(splitNodeId, latestRatio);
    };
    const finish = (ratio: number | null) => {
      if (frameId !== 0) window.cancelAnimationFrame(frameId);
      detach();
      removePanelResizeOverlay(overlay);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      abortResizeRef.current = null;
      finishResize(splitNodeId, ratio);
    };

    abortResizeRef.current = () => finish(null);
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";
    detach = attachPanelPointerOverlaySession(overlay, {
      onMove: (moveEvent) => {
        latestRatio = computeRatio(moveEvent.clientX, moveEvent.clientY);
        if (frameId === 0) frameId = window.requestAnimationFrame(apply);
      },
      onRelease: () => finish(latestRatio),
      onAbort: () => finish(null),
    });
  };

  return (
    <div
      data-bottom-terminal-divider="true"
      data-split-direction={direction}
      className={cn(
        "pointer-events-auto absolute z-10 bg-[var(--app-surface-divider)]",
        direction === "horizontal"
          ? "inset-y-0 w-px cursor-col-resize before:absolute before:inset-y-0 before:-left-1 before:w-2 before:bg-transparent"
          : "inset-x-0 h-px cursor-row-resize before:absolute before:inset-x-0 before:-top-1 before:h-2 before:bg-transparent",
      )}
      style={
        direction === "horizontal"
          ? { left: `${props.ratio * 100}%` }
          : { top: `${props.ratio * 100}%` }
      }
      onPointerDown={handlePointerDown}
    />
  );
}

function BottomTerminalTabGrid(props: {
  hostThreadId: ThreadId;
  scopeId: ThreadId;
  tab: BottomTerminalTab;
  isActiveTab: boolean;
  drawerOpen: boolean;
  cwd: string;
  runtimeEnv: Record<string, string>;
  focusNonce: number;
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
  terminalCliKindsById: Record<string, "codex" | "claude" | "antigravity">;
  onFocusPane: (paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onSetSplitRatio: (splitNodeId: string, ratio: number) => void;
  onSessionExited: (terminalId: string) => void;
  onTerminalMetadataChange: (
    terminalId: string,
    metadata: { cliKind: "codex" | "claude" | "antigravity" | null; label: string },
  ) => void;
  onTerminalActivityChange: (
    terminalId: string,
    activity: {
      hasRunningSubprocess: boolean;
      agentState: "running" | "attention" | "review" | null;
    },
  ) => void;
  onAddTerminalContext:
    | ((selection: {
        terminalId: string;
        terminalLabel: string;
        lineStart: number;
        lineEnd: number;
        text: string;
      }) => void)
    | undefined;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<{
    root: BottomTerminalTab["root"];
    splitNodeId: string;
    ratio: number;
  } | null>(null);

  const effectiveRoot = useMemo(() => {
    if (!preview || preview.root !== props.tab.root) return props.tab.root;
    const node = findTerminalTileById(props.tab.root, preview.splitNodeId);
    if (!node || node.kind !== "split") return props.tab.root;
    return replaceTerminalTileNode(props.tab.root, node.id, { ...node, ratio: preview.ratio });
  }, [preview, props.tab.root]);

  const layout = useMemo(() => layoutTerminalTiles(effectiveRoot), [effectiveRoot]);
  const isMultiTile = layout.leaves.length > 1;
  const zoomedPaneId = isMultiTile ? props.tab.zoomedPaneId : null;

  return (
    <div
      className={cn(
        "absolute inset-0 min-h-0 min-w-0 overflow-hidden",
        props.isActiveTab ? undefined : "invisible pointer-events-none",
      )}
      aria-hidden={props.isActiveTab && props.drawerOpen ? undefined : true}
      inert={props.isActiveTab && props.drawerOpen ? undefined : true}
    >
      {layout.leaves.map(({ leaf, rect }) => {
        const isFocused = leaf.id === props.tab.focusedPaneId;
        const isZoomed = zoomedPaneId === leaf.id;
        const hiddenByZoom = zoomedPaneId !== null && !isZoomed;
        const isVisible = props.drawerOpen && props.isActiveTab && !hiddenByZoom;
        const label =
          props.terminalTitleOverridesById[leaf.terminalId] ??
          props.terminalLabelsById[leaf.terminalId] ??
          t("workspace:viewportPane_terminal");

        return (
          <div
            key={leaf.id}
            data-bottom-terminal-host-id={props.hostThreadId}
            data-bottom-terminal-tab-id={props.tab.id}
            data-bottom-terminal-pane-id={leaf.id}
            data-bottom-terminal-focused={isFocused ? "true" : undefined}
            className={cn(
              "group/tile absolute flex min-h-0 min-w-0 overflow-hidden",
              hiddenByZoom && "invisible pointer-events-none",
              isZoomed && "z-10",
            )}
            style={
              isZoomed
                ? { left: 0, top: 0, width: "100%", height: "100%" }
                : {
                    ...tileRectStyle(rect),
                    paddingLeft: rect.left > 0 ? 1 : 0,
                    paddingTop: rect.top > 0 ? 1 : 0,
                  }
            }
            onPointerDown={() => {
              if (!isFocused) props.onFocusPane(leaf.id);
            }}
          >
            <div
              className={cn(
                "relative flex h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden",
                isMultiTile &&
                  isFocused &&
                  !isZoomed &&
                  "ring-1 ring-inset ring-[var(--color-text-accent)]/40",
              )}
            >
              <TerminalViewport
                threadId={props.scopeId}
                terminalId={leaf.terminalId}
                terminalLabel={label}
                terminalCliKind={props.terminalCliKindsById[leaf.terminalId] ?? null}
                cwd={props.cwd}
                runtimeEnv={props.runtimeEnv}
                density="compact"
                onSessionExited={() => props.onSessionExited(leaf.terminalId)}
                onTerminalMetadataChange={props.onTerminalMetadataChange}
                onTerminalActivityChange={props.onTerminalActivityChange}
                onAddTerminalContext={props.onAddTerminalContext}
                focusRequestId={isFocused ? props.focusNonce : 0}
                autoFocus={isFocused && props.isActiveTab}
                isVisible={isVisible}
              />
              {isMultiTile ? (
                <button
                  type="button"
                  aria-label={t("chat:bottomTerminal_closePane")}
                  title={t("chat:bottomTerminal_closePane")}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onClosePane(leaf.id);
                  }}
                  className="absolute right-1.5 top-1 z-20 flex size-5 items-center justify-center rounded bg-background/80 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/tile:opacity-100"
                >
                  <XIcon className="size-3" />
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
      {zoomedPaneId === null
        ? layout.splits.map(({ node, rect }) => (
            <div key={node.id} className="pointer-events-none absolute" style={tileRectStyle(rect)}>
              <TileSplitDivider
                splitNodeId={node.id}
                direction={node.direction}
                ratio={node.ratio}
                onPreviewRatio={(splitNodeId, ratio) =>
                  setPreview({ root: props.tab.root, splitNodeId, ratio })
                }
                onFinishResize={(splitNodeId, ratio) => {
                  setPreview(null);
                  if (ratio !== null) props.onSetSplitRatio(splitNodeId, ratio);
                }}
              />
            </div>
          ))
        : null}
    </div>
  );
}

export function CompactBottomTerminalDrawer(props: {
  hostThreadId: ThreadId;
  projectId: ProjectId | null;
  paneScopeId?: string;
  keybindings: ResolvedKeybindingsConfig;
}) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const paneScopeId = props.paneScopeId ?? SINGLE_CHAT_PANE_SCOPE_ID;
  const scopeId = dockTerminalThreadId(props.hostThreadId);

  const bottomState = useBottomTerminalStore(
    useMemo(() => selectBottomTerminalState(props.hostThreadId), [props.hostThreadId]),
  );
  const focusNonce = useBottomTerminalStore((state) => state.focusNonce);
  const setDrawerOpen = useBottomTerminalStore((state) => state.setDrawerOpen);
  const setDrawerHeight = useBottomTerminalStore((state) => state.setDrawerHeight);
  const toggleMaximized = useBottomTerminalStore((state) => state.toggleMaximized);
  const addTab = useBottomTerminalStore((state) => state.addTab);
  const selectTab = useBottomTerminalStore((state) => state.selectTab);
  const splitFocusedPane = useBottomTerminalStore((state) => state.splitFocusedPane);
  const focusPane = useBottomTerminalStore((state) => state.focusPane);
  const setSplitRatio = useBottomTerminalStore((state) => state.setSplitRatio);
  const closeTerminalById = useBottomTerminalStore((state) => state.closeTerminalById);

  const threadWorkspace = useStore(
    useMemo(() => createThreadWorkspaceMetadataSelector(props.hostThreadId), [props.hostThreadId]),
  );
  const project = useStore(
    useMemo(() => createProjectSelector(props.projectId), [props.projectId]),
  );
  const worktreePath = threadWorkspace.worktreePath;
  const workingDirectory = threadWorkspace.workingDirectory;
  const projectCwd = project?.cwd ?? null;
  const cwd =
    resolveThreadWorkspaceCwd({
      projectCwd,
      envMode: threadWorkspace.envMode,
      worktreePath,
      workingDirectory,
    }) ?? "";
  const runtimeProjectCwd = workingDirectory ?? projectCwd;
  const runtimeEnv = useMemo(
    () =>
      runtimeProjectCwd
        ? projectScriptRuntimeEnv({ project: { cwd: runtimeProjectCwd }, worktreePath })
        : {},
    [runtimeProjectCwd, worktreePath],
  );

  const terminal = useTerminalSurfaceController(scopeId);
  const { terminalState } = terminal;
  const ensureDockTerminal = useTerminalStateStore((state) => state.ensureDockTerminal);
  const setActiveTerminal = useTerminalStateStore((state) => state.setActiveTerminal);

  const subscribeToComposerTarget = useCallback(
    (listener: () => void) => subscribeTerminalContextComposerTarget(paneScopeId, listener),
    [paneScopeId],
  );
  const readComposerTarget = useCallback(
    () => getTerminalContextComposerTarget(paneScopeId),
    [paneScopeId],
  );
  const composerTarget = useSyncExternalStore(
    subscribeToComposerTarget,
    readComposerTarget,
    readComposerTarget,
  );

  const activeTab = resolveActiveBottomTerminalTab(bottomState);

  // Register every tile's terminalId in terminalStateStore so labels, activity
  // dots, and close confirmations track them identically to right-dock panes.
  useEffect(() => {
    for (const tab of bottomState.tabs) {
      for (const leaf of collectTerminalTileLeaves(tab.root)) {
        ensureDockTerminal(scopeId, leaf.id, leaf.terminalId);
      }
    }
  }, [bottomState.tabs, ensureDockTerminal, scopeId]);

  useEffect(() => {
    if (!bottomState.open || !activeTab) return;
    const focused = collectTerminalTileLeaves(activeTab.root).find(
      (leaf) => leaf.id === activeTab.focusedPaneId,
    );
    if (focused) {
      setActiveTerminal(scopeId, focused.terminalId);
    }
  }, [activeTab, bottomState.open, scopeId, setActiveTerminal]);

  const drawerRef = useRef<HTMLElement>(null);
  const [dragHeightPx, setDragHeightPx] = useState<number | null>(null);
  const isEmptyClosed = !bottomState.open && bottomState.tabs.length === 0;
  // First open starts collapsed for 1 frame so the drawer slides up smoothly
  // instead of popping in abruptly; if already open on mount (thread switch),
  // render open immediately. When exiting via `exit` or closing the last tab,
  // keep the shell mounted until the slide-down transition finishes.
  const [hasRenderedDrawer, setHasRenderedDrawer] = useState(!isEmptyClosed);
  const [hasEntered, setHasEntered] = useState(bottomState.open);
  const abortDrawerResizeRef = useRef<(() => void) | null>(null);
  useEffect(() => () => abortDrawerResizeRef.current?.(), []);

  useEffect(() => {
    if (!isEmptyClosed && !hasRenderedDrawer) {
      setHasRenderedDrawer(true);
    }
  }, [hasRenderedDrawer, isEmptyClosed]);

  useEffect(() => {
    if (!bottomState.open) {
      if (!isEmptyClosed || !hasRenderedDrawer) return;
      const timer = window.setTimeout(() => {
        setHasRenderedDrawer(false);
        setHasEntered(false);
      }, DISCLOSURE_TRANSITION_MS + DISCLOSURE_CLEANUP_BUFFER_MS);
      return () => window.clearTimeout(timer);
    }
    if (hasEntered) return;
    const frameId = window.requestAnimationFrame(() => {
      setHasEntered(true);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [bottomState.open, hasEntered, hasRenderedDrawer, isEmptyClosed]);

  const handleStartHeightResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const drawer = drawerRef.current;
    const parent = drawer?.parentElement;
    if (!drawer || !parent) return;

    abortDrawerResizeRef.current?.();
    event.preventDefault();
    event.stopPropagation();

    const startY = event.clientY;
    const startHeight = drawer.getBoundingClientRect().height;
    const maxHeight = Math.min(
      MAX_BOTTOM_TERMINAL_HEIGHT_PX,
      Math.max(MIN_BOTTOM_TERMINAL_HEIGHT_PX, Math.round(parent.clientHeight * 0.72)),
    );

    let latestHeight = startHeight;
    let frameId = 0;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const overlay = createPanelResizeOverlay("row-resize");
    let detach = () => {};

    const apply = () => {
      frameId = 0;
      setDragHeightPx(latestHeight);
    };
    const finish = (commit: boolean) => {
      if (frameId !== 0) window.cancelAnimationFrame(frameId);
      detach();
      removePanelResizeOverlay(overlay);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      abortDrawerResizeRef.current = null;
      setDragHeightPx(null);
      if (commit) {
        setDrawerHeight(props.hostThreadId, latestHeight);
      }
    };

    abortDrawerResizeRef.current = () => finish(false);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    detach = attachPanelPointerOverlaySession(overlay, {
      onMove: (moveEvent) => {
        const delta = startY - moveEvent.clientY;
        latestHeight = Math.min(
          maxHeight,
          Math.max(MIN_BOTTOM_TERMINAL_HEIGHT_PX, startHeight + delta),
        );
        if (frameId === 0) frameId = window.requestAnimationFrame(apply);
      },
      onRelease: () => finish(true),
      onAbort: () => finish(false),
    });
  };

  const handleSessionExited = useCallback(
    (terminalId: string) => {
      const disposition = terminal.handleDockTerminalSessionExited(terminalId);
      if (disposition !== "ignored") {
        closeTerminalById(props.hostThreadId, terminalId);
      }
    },
    [closeTerminalById, props.hostThreadId, terminal],
  );

  const platform = getNavigatorPlatform();
  const splitRightLabel = shortcutLabelForCommand(props.keybindings, "terminal.tile.splitRight", {
    platform,
    context: { terminalFocus: true, terminalOpen: true },
  });
  const splitDownLabel = shortcutLabelForCommand(props.keybindings, "terminal.tile.splitDown", {
    platform,
    context: { terminalFocus: true, terminalOpen: true },
  });
  const newTabLabel = shortcutLabelForCommand(props.keybindings, "terminal.new", {
    platform,
    context: { terminalFocus: true, terminalOpen: true },
  });
  const toggleLabel = shortcutLabelForCommand(props.keybindings, "terminal.toggle", { platform });

  if (isEmptyClosed && !hasRenderedDrawer) {
    return null;
  }

  const visuallyOpen = bottomState.open && hasEntered;
  const effectiveHeightStyle: CSSProperties = !visuallyOpen
    ? { height: 0 }
    : bottomState.maximized && dragHeightPx === null
      ? { height: `${Math.round(MAXIMIZED_HEIGHT_FRACTION * 100)}%` }
      : { height: `${clampBottomTerminalHeight(dragHeightPx ?? bottomState.heightPx)}px` };

  const activeTabZoomed = activeTab?.zoomedPaneId != null;

  return (
    <section
      ref={drawerRef}
      aria-label={t("workspace:viewportPane_terminal")}
      data-bottom-terminal-drawer="true"
      data-bottom-terminal-open={bottomState.open ? "true" : "false"}
      className={cn(
        "bottom-terminal-drawer relative z-20 flex w-full shrink-0 flex-col overflow-hidden app-content-surface",
        dragHeightPx === null && DISCLOSURE_HEIGHT_MOTION_CLASS,
        visuallyOpen
          ? "border-t border-[var(--app-surface-divider)] opacity-100"
          : "pointer-events-none border-t-0 opacity-0",
      )}
      style={effectiveHeightStyle}
      aria-hidden={bottomState.open ? undefined : true}
      inert={bottomState.open ? undefined : true}
    >
      {bottomState.open ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("chat:bottomTerminal_resize")}
          data-bottom-terminal-resize-handle="true"
          className="absolute inset-x-0 -top-1 z-30 h-2 cursor-row-resize bg-transparent"
          onPointerDown={handleStartHeightResize}
          onDoubleClick={() => toggleMaximized(props.hostThreadId)}
        />
      ) : null}

      <header className="flex h-7 shrink-0 items-center gap-1 border-b border-[var(--app-surface-divider)] px-1.5 select-none">
        <div
          role="tablist"
          aria-label={t("chat:bottomTerminal_tabsAria")}
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {bottomState.tabs.map((tab, index) => {
            const isActive = tab.id === activeTab?.id;
            const leaves = collectTerminalTileLeaves(tab.root);
            const focusedLeaf = leaves.find((leaf) => leaf.id === tab.focusedPaneId) ?? leaves[0];
            const rawTitle = focusedLeaf
              ? (terminalState.terminalTitleOverridesById[focusedLeaf.terminalId] ??
                terminalState.terminalLabelsById[focusedLeaf.terminalId])
              : undefined;
            const tabTitle =
              rawTitle?.trim() || `${t("workspace:viewportPane_terminal")} ${index + 1}`;
            const hasRunning = leaves.some((leaf) =>
              terminalState.runningTerminalIds.includes(leaf.terminalId),
            );
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                className={cn(
                  "group/tab inline-flex h-5 max-w-44 shrink-0 items-center gap-1 rounded-md px-1.5 text-ui-xs transition-colors",
                  isActive
                    ? "bg-muted/80 font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-1 text-left"
                  onClick={() => selectTab(props.hostThreadId, tab.id)}
                >
                  <TerminalIcon className="size-3 shrink-0 opacity-75" />
                  <span className="truncate">{tabTitle}</span>
                  {leaves.length > 1 ? (
                    <span className="shrink-0 rounded bg-foreground/10 px-1 text-ui-xs leading-tight text-muted-foreground">
                      {leaves.length}
                    </span>
                  ) : null}
                  {hasRunning ? (
                    <TerminalActivityIndicator className="shrink-0 text-[var(--color-text-accent)]" />
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-label={t("common:closeNamedItem", { title: tabTitle })}
                  className="ml-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 opacity-60 transition-opacity hover:bg-foreground/10 hover:text-foreground hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    // Close every tile in this tab cleanly, prompting if busy.
                    void (async () => {
                      for (const leaf of leaves) {
                        const closed = await closeBottomTerminalPane({
                          hostThreadId: props.hostThreadId,
                          tabId: tab.id,
                          paneId: leaf.id,
                          confirmationEnabled: settings.confirmTerminalTabClose,
                        });
                        if (!closed) break;
                      }
                    })();
                  }}
                >
                  <XIcon className="size-2.5" />
                </button>
              </div>
            );
          })}
          <IconButton
            variant="chrome"
            size="icon-xs"
            label={t("chat:bottomTerminal_newTab")}
            tooltip={
              newTabLabel
                ? `${t("chat:bottomTerminal_newTab")} (${newTabLabel})`
                : t("chat:bottomTerminal_newTab")
            }
            tooltipSide="top"
            className={cn(DOCK_HEADER_ICON_BUTTON_CLASS, "!size-5")}
            onClick={() => addTab(props.hostThreadId)}
          >
            <PlusIcon className="size-3" />
          </IconButton>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {activeTabZoomed ? (
            <span className="mr-1 rounded bg-muted px-1.5 py-0.5 text-ui-xs text-muted-foreground">
              {t("chat:bottomTerminal_zoomed")}
            </span>
          ) : null}
          <IconButton
            variant="chrome"
            size="icon-xs"
            label={t("chat:bottomTerminal_splitRight")}
            tooltip={
              splitRightLabel
                ? `${t("chat:bottomTerminal_splitRight")} (${splitRightLabel})`
                : t("chat:bottomTerminal_splitRight")
            }
            tooltipSide="top"
            className={cn(DOCK_HEADER_ICON_BUTTON_CLASS, "!size-5")}
            onClick={() => splitFocusedPane(props.hostThreadId, "horizontal")}
          >
            <SquareSplitHorizontal className="size-3.5" />
          </IconButton>
          <IconButton
            variant="chrome"
            size="icon-xs"
            label={t("chat:bottomTerminal_splitDown")}
            tooltip={
              splitDownLabel
                ? `${t("chat:bottomTerminal_splitDown")} (${splitDownLabel})`
                : t("chat:bottomTerminal_splitDown")
            }
            tooltipSide="top"
            className={cn(DOCK_HEADER_ICON_BUTTON_CLASS, "!size-5")}
            onClick={() => splitFocusedPane(props.hostThreadId, "vertical")}
          >
            <SquareSplitVertical className="size-3.5" />
          </IconButton>
          <IconButton
            variant="chrome"
            size="icon-xs"
            label={
              bottomState.maximized
                ? t("chat:bottomTerminal_restore")
                : t("chat:bottomTerminal_expand")
            }
            tooltip={
              bottomState.maximized
                ? t("chat:bottomTerminal_restore")
                : t("chat:bottomTerminal_expand")
            }
            tooltipSide="top"
            aria-pressed={bottomState.maximized}
            className={cn(DOCK_HEADER_ICON_BUTTON_CLASS, "!size-5")}
            onClick={() => toggleMaximized(props.hostThreadId)}
          >
            {bottomState.maximized ? (
              <PanelCollapseIcon className="size-3.5" />
            ) : (
              <PanelExpandIcon className="size-3.5" />
            )}
          </IconButton>
          <IconButton
            variant="chrome"
            size="icon-xs"
            label={t("chat:bottomTerminal_hide")}
            tooltip={
              toggleLabel
                ? `${t("chat:bottomTerminal_hide")} (${toggleLabel})`
                : t("chat:bottomTerminal_hide")
            }
            tooltipSide="top"
            className={cn(DOCK_HEADER_ICON_BUTTON_CLASS, "!size-5")}
            onClick={() => setDrawerOpen(props.hostThreadId, false)}
          >
            <ChevronDownIcon className="size-3.5" />
          </IconButton>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {bottomState.tabs.map((tab) => (
          <BottomTerminalTabGrid
            key={tab.id}
            hostThreadId={props.hostThreadId}
            scopeId={scopeId}
            tab={tab}
            isActiveTab={tab.id === activeTab?.id}
            drawerOpen={bottomState.open}
            cwd={cwd}
            runtimeEnv={runtimeEnv}
            focusNonce={focusNonce}
            terminalLabelsById={terminalState.terminalLabelsById}
            terminalTitleOverridesById={terminalState.terminalTitleOverridesById}
            terminalCliKindsById={terminalState.terminalCliKindsById}
            onFocusPane={(paneId) => focusPane(props.hostThreadId, tab.id, paneId)}
            onClosePane={(paneId) => {
              void closeBottomTerminalPane({
                hostThreadId: props.hostThreadId,
                tabId: tab.id,
                paneId,
                confirmationEnabled: settings.confirmTerminalTabClose,
              });
            }}
            onSetSplitRatio={(splitNodeId, ratio) =>
              setSplitRatio(props.hostThreadId, tab.id, splitNodeId, ratio)
            }
            onSessionExited={handleSessionExited}
            onTerminalMetadataChange={terminal.setTerminalMetadata}
            onTerminalActivityChange={terminal.setTerminalActivity}
            onAddTerminalContext={composerTarget}
          />
        ))}
      </div>
    </section>
  );
}

export default CompactBottomTerminalDrawer;
