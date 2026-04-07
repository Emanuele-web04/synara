// FILE: splitView.logic.ts
// Purpose: Centralizes split-surface fallback rules so deletion and cleanup flows stay consistent.
// Layer: UI state helpers
// Exports: split-view mutation helpers used by the store and split-aware navigation flows

import type { ThreadId } from "@t3tools/contracts";
import type { SplitView, SplitViewPane, SplitViewPanePanelState } from "./splitViewStore";

export interface SplitViewThreadRemovalResult {
  removedPane: SplitViewPane | null;
  nextFocusedPane: SplitViewPane | null;
  nextFocusedThreadId: ThreadId | null;
  nextSplitView: SplitView | null;
}

export function clearSplitViewPanePanelState(
  panelState: SplitViewPanePanelState,
): SplitViewPanePanelState {
  return {
    ...panelState,
    panel: null,
    diffTurnId: null,
    diffFilePath: null,
  };
}

export function removeThreadFromSplitView(
  splitView: SplitView,
  threadId: ThreadId,
): SplitViewThreadRemovalResult {
  const leftMatches = splitView.leftThreadId === threadId;
  const rightMatches = splitView.rightThreadId === threadId;
  if (!leftMatches && !rightMatches) {
    return {
      removedPane: null,
      nextFocusedPane: splitView.focusedPane,
      nextFocusedThreadId:
        splitView.focusedPane === "left"
          ? (splitView.leftThreadId ?? splitView.rightThreadId)
          : (splitView.rightThreadId ?? splitView.leftThreadId),
      nextSplitView: splitView,
    };
  }

  const nextLeftThreadId = leftMatches ? null : splitView.leftThreadId;
  const nextRightThreadId = rightMatches ? null : splitView.rightThreadId;

  if (!nextLeftThreadId && !nextRightThreadId) {
    return {
      removedPane: leftMatches ? "left" : "right",
      nextFocusedPane: null,
      nextFocusedThreadId: null,
      nextSplitView: null,
    };
  }

  const nextFocusedPane =
    splitView.focusedPane === "left"
      ? nextLeftThreadId
        ? "left"
        : "right"
      : nextRightThreadId
        ? "right"
        : "left";
  const nextFocusedThreadId = nextFocusedPane === "left" ? nextLeftThreadId : nextRightThreadId;

  return {
    removedPane: leftMatches ? "left" : "right",
    nextFocusedPane,
    nextFocusedThreadId,
    nextSplitView: {
      ...splitView,
      leftThreadId: nextLeftThreadId,
      rightThreadId: nextRightThreadId,
      leftPanel: leftMatches
        ? clearSplitViewPanePanelState(splitView.leftPanel)
        : splitView.leftPanel,
      rightPanel: rightMatches
        ? clearSplitViewPanePanelState(splitView.rightPanel)
        : splitView.rightPanel,
      focusedPane: nextFocusedPane,
      updatedAt: new Date().toISOString(),
    },
  };
}
