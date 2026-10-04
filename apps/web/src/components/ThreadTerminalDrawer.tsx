// FILE: ThreadTerminalDrawer.tsx
// Purpose: Hosts terminal workspace chrome, reusing the shared xterm viewport.
// Layer: Chat terminal workspace UI

import { Plus, SquareSplitHorizontal, SquareSplitVertical, Trash2 } from "~/lib/icons";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  buildTerminalRuntimeKey,
  terminalRuntimeRegistry,
} from "./terminal/terminalRuntimeRegistry";
import { type ThreadId } from "@synara/contracts";
import { type TerminalActivityState, type TerminalCliKind } from "@synara/shared/terminalThreads";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import {
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
  type ThreadTerminalPresentationMode,
} from "../types";
import { cn } from "~/lib/utils";
import {
  type TerminalChromeActionItem,
  TerminalSidebar,
  TerminalWorkspaceTabBar,
} from "./terminal/TerminalChrome";
import { resolveThreadTerminalLayout } from "./terminal/TerminalLayout";
import TerminalViewportPane from "./terminal/TerminalViewportPane";
import TerminalViewport from "./terminal/TerminalViewport";
import { useTerminalDrawerHeight } from "./terminal/useTerminalDrawerHeight";

interface ThreadTerminalDrawerProps {
  threadId: ThreadId;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  height: number;
  presentationMode: ThreadTerminalPresentationMode;
  isVisible?: boolean;
  terminalIds: string[];
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
  terminalCliKindsById: Record<string, TerminalCliKind>;
  terminalAttentionStatesById: Record<string, "attention" | "review">;
  runningTerminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  focusRequestId: number;
  onSplitTerminal: () => void;
  onSplitTerminalDown: () => void;
  onNewTerminal: () => void;
  onNewTerminalTab: (terminalId: string) => void;
  onMoveTerminalToGroup: (terminalId: string) => void;
  splitShortcutLabel?: string | undefined;
  splitDownShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  workspaceCloseShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onTerminalSessionExited: (terminalId: string) => void;
  onCloseTerminalGroup: (groupId: string) => void;
  onHeightChange: (height: number) => void;
  onResizeTerminalSplit: (groupId: string, splitId: string, weights: number[]) => void;
  onTerminalMetadataChange: (
    terminalId: string,
    metadata: { cliKind: TerminalCliKind | null; label: string },
  ) => void;
  onTerminalActivityChange: (
    terminalId: string,
    activity: { hasRunningSubprocess: boolean; agentState: TerminalActivityState | null },
  ) => void;
  onAddTerminalContext?: ((selection: TerminalContextSelection) => void) | undefined;
  onTogglePresentationMode?: (() => void) | undefined;
  onTogglePanel?: (() => void) | undefined;
  isPanelOpen?: boolean | undefined;
}

export default function ThreadTerminalDrawer({
  threadId,
  cwd,
  runtimeEnv,
  height,
  presentationMode,
  isVisible: isVisibleProp,
  terminalIds,
  terminalLabelsById,
  terminalTitleOverridesById,
  terminalCliKindsById,
  terminalAttentionStatesById,
  runningTerminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  focusRequestId,
  onSplitTerminal,
  onSplitTerminalDown,
  onNewTerminal,
  onNewTerminalTab,
  onMoveTerminalToGroup,
  splitShortcutLabel,
  splitDownShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  workspaceCloseShortcutLabel,
  onActiveTerminalChange,
  onCloseTerminal,
  onTerminalSessionExited,
  onCloseTerminalGroup,
  onHeightChange,
  onResizeTerminalSplit,
  onTerminalMetadataChange,
  onTerminalActivityChange,
  onAddTerminalContext,
  onTogglePresentationMode,
  onTogglePanel,
  isPanelOpen,
}: ThreadTerminalDrawerProps) {
  const isVisible = isVisibleProp ?? true;
  const isWorkspaceMode = presentationMode === "workspace";
  const previousRuntimeKeysRef = useRef<Set<string>>(new Set());
  const { drawerHeight, handleResizePointerDown, handleResizePointerMove, handleResizePointerEnd } =
    useTerminalDrawerHeight({
      height,
      onHeightChange,
      resetKey: threadId,
    });

  const {
    normalizedTerminalIds,
    resolvedActiveTerminalId,
    resolvedActiveGroupId,
    resolvedTerminalGroups,
    activeGroupLayout,
    hasTerminalSidebar,
    showGroupHeaders,
    hasReachedSplitLimit,
    terminalVisualIdentityById,
  } = useMemo(
    () =>
      resolveThreadTerminalLayout({
        activeTerminalGroupId,
        activeTerminalId,
        runningTerminalIds,
        terminalAttentionStatesById,
        terminalCliKindsById,
        terminalGroups,
        terminalIds,
        terminalLabelsById,
        terminalTitleOverridesById,
      }),
    [
      activeTerminalGroupId,
      activeTerminalId,
      runningTerminalIds,
      terminalAttentionStatesById,
      terminalCliKindsById,
      terminalGroups,
      terminalIds,
      terminalLabelsById,
      terminalTitleOverridesById,
    ],
  );

  useEffect(() => {
    const nextRuntimeKeySet = new Set(
      normalizedTerminalIds.map((terminalId) => buildTerminalRuntimeKey(threadId, terminalId)),
    );
    for (const previousRuntimeKey of previousRuntimeKeysRef.current) {
      if (nextRuntimeKeySet.has(previousRuntimeKey)) {
        continue;
      }
      terminalRuntimeRegistry.dispose(previousRuntimeKey);
    }
    previousRuntimeKeysRef.current = nextRuntimeKeySet;
  }, [normalizedTerminalIds, threadId]);

  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split Terminal (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitShortcutLabel
      ? `Split Right (${splitShortcutLabel})`
      : "Split Right";
  const splitTerminalDownActionLabel = hasReachedSplitLimit
    ? `Split Down (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitDownShortcutLabel
      ? `Split Down (${splitDownShortcutLabel})`
      : "Split Down";
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : "New Terminal";
  const resolvedCloseShortcutLabel = isWorkspaceMode
    ? (workspaceCloseShortcutLabel ?? closeShortcutLabel)
    : closeShortcutLabel;
  const closeTerminalActionLabel = resolvedCloseShortcutLabel
    ? `Close Terminal (${resolvedCloseShortcutLabel})`
    : "Close Terminal";
  const onSplitTerminalAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminal();
  }, [hasReachedSplitLimit, onSplitTerminal]);
  const onSplitTerminalDownAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminalDown();
  }, [hasReachedSplitLimit, onSplitTerminalDown]);
  const onNewTerminalAction = useCallback(() => {
    onNewTerminal();
  }, [onNewTerminal]);

  const terminalChromeActions: TerminalChromeActionItem[] = [
    {
      label: splitTerminalActionLabel,
      onClick: onSplitTerminalAction,
      disabled: hasReachedSplitLimit,
      children: <SquareSplitHorizontal className="size-3.25" />,
    },
    {
      label: splitTerminalDownActionLabel,
      onClick: onSplitTerminalDownAction,
      disabled: hasReachedSplitLimit,
      children: <SquareSplitVertical className="size-3.25" />,
    },
    {
      label: newTerminalActionLabel,
      onClick: onNewTerminalAction,
      children: <Plus className="size-3.25" />,
    },
    {
      label: closeTerminalActionLabel,
      onClick: () => onCloseTerminal(resolvedActiveTerminalId),
      children: <Trash2 className="size-3.25" />,
    },
  ];
  const showTerminalGroupTabs = resolvedTerminalGroups.length > 1;
  const topTabBarActions = terminalChromeActions;

  return (
    <aside
      className={cn(
        "thread-terminal-drawer relative flex w-full min-w-0 flex-col overflow-hidden app-content-surface",
        isWorkspaceMode ? "h-full min-h-0" : "shrink-0 border-t border-border/70",
      )}
      style={isWorkspaceMode ? undefined : { height: `${drawerHeight}px` }}
    >
      {!isWorkspaceMode ? (
        <div
          className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerEnd}
          onPointerCancel={handleResizePointerEnd}
        />
      ) : null}

      {showTerminalGroupTabs ? (
        <TerminalWorkspaceTabBar
          terminalGroups={resolvedTerminalGroups}
          activeGroupId={resolvedActiveGroupId}
          terminalVisualIdentityById={terminalVisualIdentityById}
          actions={topTabBarActions}
          onActiveGroupChange={(groupId) => {
            const nextGroup = resolvedTerminalGroups.find((group) => group.id === groupId);
            if (!nextGroup) return;
            onActiveTerminalChange(nextGroup.activeTerminalId);
          }}
          onCloseGroup={onCloseTerminalGroup}
        />
      ) : null}

      <div className="min-h-0 w-full flex-1">
        <div
          className={cn(
            "flex h-full min-h-0",
            hasTerminalSidebar && !isWorkspaceMode ? "gap-1.5" : "",
          )}
        >
          <div className="min-w-0 flex-1 h-full">
            <TerminalViewportPane
              groupId={resolvedActiveGroupId}
              layout={activeGroupLayout}
              resolvedActiveTerminalId={resolvedActiveTerminalId}
              terminalVisualIdentityById={terminalVisualIdentityById}
              onActiveTerminalChange={onActiveTerminalChange}
              onResizeSplit={onResizeTerminalSplit}
              onSplitTerminalRight={
                hasReachedSplitLimit
                  ? undefined
                  : (terminalId) => {
                      onActiveTerminalChange(terminalId);
                      onSplitTerminal();
                    }
              }
              onSplitTerminalDown={
                hasReachedSplitLimit
                  ? undefined
                  : (terminalId) => {
                      onActiveTerminalChange(terminalId);
                      onSplitTerminalDown();
                    }
              }
              onNewTerminalTab={
                hasReachedSplitLimit
                  ? undefined
                  : (terminalId) => {
                      onNewTerminalTab(terminalId);
                    }
              }
              onMoveTerminalToGroup={isWorkspaceMode ? onMoveTerminalToGroup : undefined}
              onCloseTerminal={onCloseTerminal}
              presentationMode={presentationMode}
              onTogglePresentationMode={onTogglePresentationMode}
              onTogglePanel={onTogglePanel}
              isPanelOpen={isPanelOpen}
              renderViewport={(terminalId, options) => (
                <TerminalViewport
                  key={terminalId}
                  threadId={threadId}
                  terminalId={terminalId}
                  terminalLabel={terminalVisualIdentityById.get(terminalId)?.title ?? "Terminal"}
                  terminalCliKind={terminalVisualIdentityById.get(terminalId)?.cliKind ?? null}
                  cwd={cwd}
                  {...(runtimeEnv ? { runtimeEnv } : {})}
                  onSessionExited={() => onTerminalSessionExited(terminalId)}
                  onTerminalMetadataChange={onTerminalMetadataChange}
                  onTerminalActivityChange={onTerminalActivityChange}
                  onAddTerminalContext={onAddTerminalContext}
                  focusRequestId={focusRequestId}
                  autoFocus={options.autoFocus}
                  isVisible={isVisible && options.isVisible}
                />
              )}
            />
          </div>

          {hasTerminalSidebar && !isWorkspaceMode ? (
            <TerminalSidebar
              terminalIds={normalizedTerminalIds}
              terminalGroups={resolvedTerminalGroups}
              activeTerminalId={resolvedActiveTerminalId}
              activeGroupId={resolvedActiveGroupId}
              showGroupHeaders={showGroupHeaders}
              closeShortcutLabel={resolvedCloseShortcutLabel}
              terminalVisualIdentityById={terminalVisualIdentityById}
              actions={terminalChromeActions}
              onActiveTerminalChange={onActiveTerminalChange}
              onCloseTerminal={onCloseTerminal}
            />
          ) : null}
        </div>
      </div>
    </aside>
  );
}
