// FILE: openSubagentThread.logic.ts
// Purpose: Decides where a subagent opens. A subagent never replaces the chat that launched
//          it: it opens as the right pane of a split beside its parent, and opening another
//          subagent swaps that pane. In a full split the pane beside the launcher takes it.
//          Threads already on screen get focus; anything that is not a subagent keeps plain
//          navigation.
// Layer: Chat navigation logic (pure)
// Exports: resolveSubagentOpenPlan, SubagentOpenPlan

import type { ProjectId, ThreadId } from "@synara/contracts";

import { canSubdividePane, collectLeaves, findParentSplitNode } from "../../splitView.logic";
import type { PaneId, SplitView, SplitViewId } from "../../splitViewStore";

export type SubagentOpenPlan =
  | { kind: "navigate"; threadId: ThreadId }
  | { kind: "focus-pane"; splitViewId: SplitViewId; paneId: PaneId; threadId: ThreadId }
  | { kind: "replace-pane"; splitViewId: SplitViewId; paneId: PaneId; threadId: ThreadId }
  | { kind: "split-pane"; splitViewId: SplitViewId; paneId: PaneId; threadId: ThreadId }
  | {
      kind: "create-split";
      sourceThreadId: ThreadId;
      ownerProjectId: ProjectId;
      threadId: ThreadId;
    };

export interface SubagentOpenThreadInfo {
  readonly parentThreadId: ThreadId | null;
  readonly projectId: ProjectId | null;
}

export function resolveSubagentOpenPlan(input: {
  /** The thread to open. */
  targetThreadId: ThreadId;
  /** The chat whose surface asked to open it (its transcript card or dock list). */
  hostThreadId: ThreadId | null;
  /** The split view on screen, if any. */
  splitView: SplitView | null;
  readThread: (threadId: ThreadId) => SubagentOpenThreadInfo | null;
}): SubagentOpenPlan {
  const { targetThreadId, hostThreadId, splitView, readThread } = input;
  const navigate: SubagentOpenPlan = { kind: "navigate", threadId: targetThreadId };
  const leaves = splitView ? collectLeaves(splitView.root) : [];
  const targetLeaf = leaves.find((leaf) => leaf.threadId === targetThreadId);
  if (splitView && targetLeaf) {
    return {
      kind: "focus-pane",
      splitViewId: splitView.id,
      paneId: targetLeaf.id,
      threadId: targetThreadId,
    };
  }

  const target = readThread(targetThreadId);
  // Only subagents open beside their launcher; the parent row, links and other
  // threads keep the usual navigation.
  if (!target?.parentThreadId) return navigate;
  const isSubagent = (threadId: ThreadId | null) =>
    threadId !== null && Boolean(readThread(threadId)?.parentThreadId);

  if (splitView) {
    const hostLeaf = leaves.find((leaf) => leaf.threadId === hostThreadId) ?? null;
    // Another subagent pane is the subagent slot: swap it rather than stacking panes.
    // Opened from a subagent pane itself (its dock list), that pane is the slot.
    const subagentLeaf =
      (hostLeaf && isSubagent(hostLeaf.threadId) ? hostLeaf : null) ??
      leaves.find((leaf) => leaf !== hostLeaf && isSubagent(leaf.threadId)) ??
      null;
    if (subagentLeaf) {
      return {
        kind: "replace-pane",
        splitViewId: splitView.id,
        paneId: subagentLeaf.id,
        threadId: targetThreadId,
      };
    }
    if (!hostLeaf) return navigate;
    if (canSubdividePane(splitView.root, hostLeaf.id, "horizontal")) {
      return {
        kind: "split-pane",
        splitViewId: splitView.id,
        paneId: hostLeaf.id,
        threadId: targetThreadId,
      };
    }
    // No room for another column: the pane beside the launcher takes the subagent,
    // so the launcher itself always stays on screen.
    const parentNode = findParentSplitNode(splitView.root, hostLeaf.id);
    const sibling = parentNode
      ? parentNode.first.id === hostLeaf.id
        ? parentNode.second
        : parentNode.first
      : null;
    if (sibling?.kind === "leaf") {
      return {
        kind: "replace-pane",
        splitViewId: splitView.id,
        paneId: sibling.id,
        threadId: targetThreadId,
      };
    }
    return navigate;
  }

  // From a subagent opened full-width, put its parent back on the left.
  const host = hostThreadId ? readThread(hostThreadId) : null;
  const sourceThreadId = host?.parentThreadId ?? hostThreadId;
  if (!sourceThreadId || sourceThreadId === targetThreadId) return navigate;
  const ownerProjectId = readThread(sourceThreadId)?.projectId ?? target.projectId;
  if (!ownerProjectId) return navigate;
  return { kind: "create-split", sourceThreadId, ownerProjectId, threadId: targetThreadId };
}
