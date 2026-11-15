// FILE: useOpenSubagentThread.ts
// Purpose: Opens a thread from a chat's subagent surfaces (transcript card, Subagents dock,
//          child-thread links). Subagents open in a split beside the chat that launched them
//          instead of replacing it; see openSubagentThread.logic.ts for the placement rules.
// Layer: Chat hooks
// Exports: useOpenSubagentThread

import type { ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { startTransition, useCallback } from "react";

import { stripDiffSearchParams } from "../../diffRouteSearch";
import { useStore } from "../../store";
import { useSplitViewStore } from "../../splitViewStore";
import { resolveSubagentOpenPlan, type SubagentOpenPlan } from "./openSubagentThread.logic";

export function useOpenSubagentThread(input: {
  /** The chat whose surface opens the thread. */
  hostThreadId: ThreadId | null;
  /** The split view on screen (the route's `splitViewId`), if any. */
  splitViewId: string | null;
  /** Plain navigation for threads that are not subagents (defaults to the chat route). */
  onNavigate?: ((threadId: ThreadId) => void) | undefined;
}): (threadId: ThreadId) => SubagentOpenPlan["kind"] {
  const navigate = useNavigate();
  const { hostThreadId, splitViewId: routeSplitViewId, onNavigate } = input;

  return useCallback(
    (threadId: ThreadId) => {
      const splitStore = useSplitViewStore.getState();
      const splitView = routeSplitViewId
        ? (splitStore.splitViewsById[routeSplitViewId] ?? null)
        : null;
      const shells = useStore.getState().threadShellById;
      const plan = resolveSubagentOpenPlan({
        targetThreadId: threadId,
        hostThreadId,
        splitView,
        readThread: (id) => {
          const shell = shells?.[id];
          return shell
            ? {
                parentThreadId: shell.parentThreadId ?? null,
                sourceThreadId: shell.sourceThreadId ?? null,
                projectId: shell.projectId,
              }
            : null;
        },
      });

      const showInSplit = (splitViewId: string, replace: boolean) =>
        startTransition(() => {
          void navigate({
            to: "/$threadId",
            params: { threadId: plan.threadId },
            replace,
            search: (previous) => ({ ...stripDiffSearchParams(previous), splitViewId }),
          });
        });

      switch (plan.kind) {
        case "navigate":
          if (onNavigate) {
            onNavigate(plan.threadId);
            return plan.kind;
          }
          void navigate({
            to: "/$threadId",
            params: { threadId: plan.threadId },
            search: (previous) => stripDiffSearchParams(previous),
          });
          return plan.kind;
        case "focus-pane":
          splitStore.setFocusedPane(plan.splitViewId, plan.paneId);
          showInSplit(plan.splitViewId, true);
          return plan.kind;
        case "replace-pane":
          splitStore.replacePaneThread(plan.splitViewId, plan.paneId, plan.threadId);
          splitStore.setPanePanelState(plan.splitViewId, plan.paneId, {
            diffTurnId: null,
            diffFilePath: null,
          });
          splitStore.setFocusedPane(plan.splitViewId, plan.paneId);
          showInSplit(plan.splitViewId, true);
          return plan.kind;
        case "split-pane":
          if (
            !splitStore.dropThreadOnPane({
              splitViewId: plan.splitViewId,
              targetPaneId: plan.paneId,
              direction: plan.direction,
              side: "second",
              threadId: plan.threadId,
            })
          ) {
            return plan.kind;
          }
          showInSplit(plan.splitViewId, true);
          return plan.kind;
        case "create-split": {
          const splitViewId = splitStore.createFromDrop({
            sourceThreadId: plan.sourceThreadId,
            ownerProjectId: plan.ownerProjectId,
            droppedThreadId: plan.threadId,
            direction: "horizontal",
            side: "second",
          });
          // Pushed, so Back returns to the full-width chat.
          showInSplit(splitViewId, false);
          return plan.kind;
        }
      }
    },
    [hostThreadId, navigate, onNavigate, routeSplitViewId],
  );
}
