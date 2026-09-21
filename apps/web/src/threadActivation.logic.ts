import type { ThreadId } from "@synara/contracts";
import {
  resolveSplitViewPaneIdForThread,
  type PaneId,
  type SplitView,
  type SplitViewId,
} from "./splitViewStore";

export type ThreadCommandActivation =
  | { kind: "ignore" }
  | { kind: "single"; threadId: ThreadId }
  | { kind: "split"; threadId: ThreadId; splitViewId: SplitViewId; paneId: PaneId };

// callers decide which split is "preferred" — the currently active split first, then persisted blocks with deterministic ownership
export function resolveThreadCommandActivation(input: {
  threadId: ThreadId;
  threadExists: boolean;
  activeSidebarThreadId: ThreadId | null | undefined;
  preferredSplitViewId: SplitViewId | null;
  splitPaneId: PaneId | null;
}): ThreadCommandActivation {
  if (!input.threadExists) {
    return { kind: "ignore" };
  }

  if (input.preferredSplitViewId && input.splitPaneId) {
    return {
      kind: "split",
      threadId: input.threadId,
      splitViewId: input.preferredSplitViewId,
      paneId: input.splitPaneId,
    };
  }

  if (input.threadId === input.activeSidebarThreadId) {
    return { kind: "ignore" };
  }

  return { kind: "single", threadId: input.threadId };
}

// while a split is active its panes win; otherwise persisted blocks restore, and ambiguous non-source membership falls back to single chat instead of guessing
export function resolvePreferredSplitForCommand(input: {
  activeSplitView: SplitView | null;
  splitViewsById: Record<SplitViewId, SplitView | undefined>;
  threadId: ThreadId;
}): { splitViewId: SplitViewId; paneId: PaneId } | null {
  if (input.activeSplitView) {
    const paneId = resolveSplitViewPaneIdForThread(input.activeSplitView, input.threadId);
    if (paneId) {
      return { splitViewId: input.activeSplitView.id, paneId };
    }
  }

  const matchingSplits = Object.values(input.splitViewsById)
    .filter((splitView): splitView is SplitView => splitView !== undefined)
    .map((splitView) => ({
      splitView,
      paneId: resolveSplitViewPaneIdForThread(splitView, input.threadId),
    }))
    .filter((match): match is { splitView: SplitView; paneId: PaneId } => match.paneId !== null);

  const sourceMatch = matchingSplits.find(
    ({ splitView }) => splitView.sourceThreadId === input.threadId,
  );
  const match = sourceMatch ?? (matchingSplits.length === 1 ? matchingSplits[0] : null);
  return match ? { splitViewId: match.splitView.id, paneId: match.paneId } : null;
}
