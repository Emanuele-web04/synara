// FILE: GitActionsControl.useProgressToast.ts
// Purpose: Manage the live git-action progress toast (WS progress events + elapsed-time refresh).
// Layer: Header action control (hook)
// Exports: useGitActionProgressToast

import { useCallback, useEffect, useRef } from "react";
import type { GitActionProgressEvent, ThreadId } from "@t3tools/contracts";
import { toastManager } from "~/components/ui/toast";
import { readNativeApi } from "~/nativeApi";
import {
  resolveProgressDescription,
  type ActiveGitActionProgress,
} from "./GitActionsControl.logic";

interface UseGitActionProgressToastInput {
  gitCwd: string | null;
  threadToastData: { threadId: ThreadId } | undefined;
}

type GitActionToastId = ReturnType<typeof toastManager.add>;
type ActiveGitActionProgressEntry = Omit<ActiveGitActionProgress, "toastId"> & {
  toastId: GitActionToastId;
};

interface UseGitActionProgressToastResult {
  activeGitActionProgressRef: React.RefObject<ActiveGitActionProgressEntry | null>;
  updateActiveProgressToast: () => void;
}

export function useGitActionProgressToast({
  gitCwd,
  threadToastData,
}: UseGitActionProgressToastInput): UseGitActionProgressToastResult {
  const activeGitActionProgressRef = useRef<ActiveGitActionProgressEntry | null>(null);

  const updateActiveProgressToast = useCallback(() => {
    const progress = activeGitActionProgressRef.current;
    if (!progress) {
      return;
    }
    toastManager.update(progress.toastId, {
      type: "loading",
      title: progress.title,
      description: resolveProgressDescription(progress),
      timeout: 0,
      data: threadToastData,
    });
  }, [threadToastData]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) {
      return;
    }

    const applyProgressEvent = (event: GitActionProgressEvent) => {
      const progress = activeGitActionProgressRef.current;
      if (!progress) {
        return;
      }
      if (gitCwd && event.cwd !== gitCwd) {
        return;
      }
      if (progress.actionId !== event.actionId) {
        return;
      }

      const now = Date.now();
      switch (event.kind) {
        case "action_started":
          progress.phaseStartedAtMs = now;
          progress.hookStartedAtMs = null;
          progress.hookName = null;
          progress.lastOutputLine = null;
          break;
        case "phase_started":
          progress.title = event.label;
          progress.currentPhaseLabel = event.label;
          progress.phaseStartedAtMs = now;
          progress.hookStartedAtMs = null;
          progress.hookName = null;
          progress.lastOutputLine = null;
          break;
        case "hook_started":
          progress.title = `Running ${event.hookName}...`;
          progress.hookName = event.hookName;
          progress.hookStartedAtMs = now;
          progress.lastOutputLine = null;
          break;
        case "hook_output":
          progress.lastOutputLine = event.text;
          break;
        case "hook_finished":
          progress.title = progress.currentPhaseLabel ?? "Committing...";
          progress.hookName = null;
          progress.hookStartedAtMs = null;
          progress.lastOutputLine = null;
          break;
        case "action_finished":
          // Don't clear timestamps here — the HTTP response handler in
          // runGitActionWithToast sets activeGitActionProgressRef to null and
          // shows the success toast. Clearing timestamps early causes the
          // "Running for Xs" description to disappear before the success state
          // renders, leaving a bare "Pushing..." toast in the gap between the
          // WS event and HTTP response.
          return;
        case "action_failed":
          // Same reasoning as action_finished — let the HTTP error handler
          // manage the final toast state to avoid a flash of bare title.
          return;
      }

      updateActiveProgressToast();
    };

    return api.git.onActionProgress(applyProgressEvent);
  }, [gitCwd, updateActiveProgressToast]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!activeGitActionProgressRef.current) {
        return;
      }
      updateActiveProgressToast();
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [updateActiveProgressToast]);

  return { activeGitActionProgressRef, updateActiveProgressToast };
}
