// FILE: recentViewActivation.logic.ts
// Purpose: Pure activation helpers for restoring recent thread views.
// Layer: UI state logic
// Exports: split-pane resolution for Ctrl+Tab recent-view activation.

import {
  resolveSplitViewPaneIdForThread,
  type PaneId,
  type SplitView,
  type SplitViewId,
} from "./splitViewStore";
import type { RecentView } from "./recentViews.logic";

export interface RecentThreadSplitActivation {
  splitViewId: SplitViewId;
  paneId: PaneId;
}

export function resolveRecentThreadSplitActivation(input: {
  view: RecentView;
  splitViewsById: Readonly<Record<SplitViewId, SplitView | undefined>>;
}): RecentThreadSplitActivation | null {
  if (input.view.kind !== "thread" || !input.view.splitViewId) {
    return null;
  }

  const splitView = input.splitViewsById[input.view.splitViewId];
  if (!splitView) {
    return null;
  }

  const paneId = resolveSplitViewPaneIdForThread(splitView, input.view.threadId);
  return paneId ? { splitViewId: input.view.splitViewId, paneId } : null;
}
