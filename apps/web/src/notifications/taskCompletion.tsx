// FILE: taskCompletion.tsx
// Purpose: Bridges thread completion and attention-needed events to in-app toasts and OS notifications.
// Layer: Notification runtime
// Exports: TaskCompletionNotifications and browser permission helpers

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toastManager } from "../components/ui/toast";
import { useAppSettings } from "../appSettings";
import { isElectron } from "../env";
import { resolvePreferredSplitViewIdForThread, useSplitViewStore } from "../splitViewStore";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import type { Thread } from "../types";
import {
  buildTerminalAttentionCopy,
  buildTerminalCompletionCopy,
  buildInputNeededCopy,
  buildTaskCompletionCopy,
  collectCompletedThreadCandidates,
  collectCompletedTerminalCandidates,
  collectInputNeededThreadCandidates,
  collectTerminalAttentionCandidates,
} from "./taskCompletion.logic";

export type BrowserNotificationPermissionState =
  | NotificationPermission
  | "unsupported"
  | "insecure";

function isBrowserNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

// Browsers require secure contexts and a user gesture before asking for permission.
export function readBrowserNotificationPermissionState(): BrowserNotificationPermissionState {
  if (typeof window === "undefined") {
    return "unsupported";
  }
  if (!isBrowserNotificationSupported()) {
    return "unsupported";
  }
  if (!window.isSecureContext) {
    return "insecure";
  }
  return Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermissionState> {
  const current = readBrowserNotificationPermissionState();
  if (current === "unsupported" || current === "insecure" || current === "denied") {
    return current;
  }
  if (current === "granted") {
    return current;
  }
  return Notification.requestPermission();
}

function isWindowForeground(): boolean {
  if (typeof document === "undefined") {
    return true;
  }
  return document.visibilityState === "visible" && document.hasFocus();
}

interface ThreadNotificationCopy {
  title: string;
  body: string;
}

function focusThread(
  threadId: Thread["id"],
  navigate: ReturnType<typeof useNavigate>,
  splitViewId: string | null,
): void {
  void navigate({
    to: "/$threadId",
    params: { threadId },
    ...(splitViewId ? { search: () => ({ splitViewId }) } : {}),
  });
}

async function showSystemThreadNotification(
  copy: ThreadNotificationCopy,
  threadId: Thread["id"],
  navigate: ReturnType<typeof useNavigate>,
  splitViewId: string | null,
): Promise<boolean> {
  const { body, title } = copy;

  if (window.desktopBridge) {
    const supported = await window.desktopBridge.notifications.isSupported();
    if (!supported) {
      return false;
    }
    return window.desktopBridge.notifications.show({ title, body, silent: false, threadId });
  }

  if (readBrowserNotificationPermissionState() !== "granted") {
    return false;
  }

  const notification = new Notification(title, {
    body,
    tag: `thread-notification:${threadId}`,
  });
  notification.addEventListener("click", () => {
    window.focus();
    focusThread(threadId, navigate, splitViewId);
  });
  return true;
}

function showThreadToast(
  copy: ThreadNotificationCopy,
  threadId: Thread["id"],
  tone: "success" | "warning",
  navigate: ReturnType<typeof useNavigate>,
  splitViewId: string | null,
): void {
  const { body, title } = copy;
  toastManager.add({
    type: tone,
    title,
    description: body,
    data: {
      allowCrossThreadVisibility: true,
      threadId,
      dismissAfterVisibleMs: 8000,
    },
    actionProps: {
      children: "Open",
      onClick: () => focusThread(threadId, navigate, splitViewId),
    },
  });
}

export function TaskCompletionNotifications() {
  const { settings } = useAppSettings();
  const navigate = useNavigate();
  const threads = useStore((store) => store.threads);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const terminalStateByThreadId = useTerminalStateStore((store) => store.terminalStateByThreadId);
  const splitViewsById = useSplitViewStore((store) => store.splitViewsById);
  const splitViewIdBySourceThreadId = useSplitViewStore(
    (store) => store.splitViewIdBySourceThreadId,
  );
  const previousThreadsRef = useRef<readonly Thread[]>([]);
  const previousTerminalStateRef = useRef(terminalStateByThreadId);
  const readyRef = useRef(false);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      const prefix = "notification-open-thread:";
      if (!action.startsWith(prefix)) {
        return;
      }
      const threadId = action.slice(prefix.length).trim();
      if (threadId.length === 0) {
        return;
      }
      const preferredSplitViewId = resolvePreferredSplitViewIdForThread({
        splitViewsById,
        splitViewIdBySourceThreadId,
        threadId: threadId as Thread["id"],
      });
      focusThread(threadId as Thread["id"], navigate, preferredSplitViewId);
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, splitViewIdBySourceThreadId, splitViewsById]);

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    if (!readyRef.current) {
      previousThreadsRef.current = threads;
      previousTerminalStateRef.current = terminalStateByThreadId;
      readyRef.current = true;
      return;
    }

    const completions = collectCompletedThreadCandidates(previousThreadsRef.current, threads);
    const terminalCompletions = collectCompletedTerminalCandidates(
      previousTerminalStateRef.current,
      terminalStateByThreadId,
    );
    const inputNeededCandidates = collectInputNeededThreadCandidates(
      previousThreadsRef.current,
      threads,
    );
    const terminalAttentionCandidates = collectTerminalAttentionCandidates(
      previousTerminalStateRef.current,
      terminalStateByThreadId,
    );
    previousThreadsRef.current = threads;
    previousTerminalStateRef.current = terminalStateByThreadId;

    if (
      completions.length === 0 &&
      inputNeededCandidates.length === 0 &&
      terminalCompletions.length === 0 &&
      terminalAttentionCandidates.length === 0
    ) {
      return;
    }

    const shouldAttemptSystemNotification =
      settings.enableSystemTaskCompletionNotifications &&
      (window.desktopBridge ? true : !isWindowForeground());

    for (const completion of completions) {
      const preferredSplitViewId = resolvePreferredSplitViewIdForThread({
        splitViewsById,
        splitViewIdBySourceThreadId,
        threadId: completion.threadId,
      });
      const copy = buildTaskCompletionCopy(completion);
      if (shouldAttemptSystemNotification) {
        void showSystemThreadNotification(
          copy,
          completion.threadId,
          navigate,
          preferredSplitViewId,
        );
      }
    }

    for (const candidate of inputNeededCandidates) {
      const preferredSplitViewId = resolvePreferredSplitViewIdForThread({
        splitViewsById,
        splitViewIdBySourceThreadId,
        threadId: candidate.threadId,
      });
      const copy = buildInputNeededCopy(candidate);
      if (settings.enableTaskCompletionToasts) {
        showThreadToast(copy, candidate.threadId, "warning", navigate, preferredSplitViewId);
      }

      if (shouldAttemptSystemNotification) {
        void showSystemThreadNotification(copy, candidate.threadId, navigate, preferredSplitViewId);
      }
    }

    for (const completion of terminalCompletions) {
      const preferredSplitViewId = resolvePreferredSplitViewIdForThread({
        splitViewsById,
        splitViewIdBySourceThreadId,
        threadId: completion.threadId,
      });
      const copy = buildTerminalCompletionCopy(completion);
      if (shouldAttemptSystemNotification) {
        void showSystemThreadNotification(
          copy,
          completion.threadId,
          navigate,
          preferredSplitViewId,
        );
      }
    }

    for (const candidate of terminalAttentionCandidates) {
      const preferredSplitViewId = resolvePreferredSplitViewIdForThread({
        splitViewsById,
        splitViewIdBySourceThreadId,
        threadId: candidate.threadId,
      });
      const copy = buildTerminalAttentionCopy(candidate);
      if (settings.enableTaskCompletionToasts) {
        showThreadToast(copy, candidate.threadId, "warning", navigate, preferredSplitViewId);
      }

      if (shouldAttemptSystemNotification) {
        void showSystemThreadNotification(copy, candidate.threadId, navigate, preferredSplitViewId);
      }
    }
  }, [
    navigate,
    settings.enableSystemTaskCompletionNotifications,
    settings.enableTaskCompletionToasts,
    splitViewIdBySourceThreadId,
    splitViewsById,
    terminalStateByThreadId,
    threads,
    threadsHydrated,
  ]);

  return null;
}

export function buildNotificationSettingsSupportText(
  permissionState: BrowserNotificationPermissionState,
): string {
  if (isElectron) {
    return "Desktop app notifications use your operating system notification center.";
  }
  switch (permissionState) {
    case "granted":
      return "Browser notifications are enabled for this app.";
    case "denied":
      return "Browser notifications are blocked. Re-enable them in your browser site settings.";
    case "insecure":
      return "Browser notifications need a secure context. Localhost works; plain HTTP does not.";
    case "unsupported":
      return "This browser does not support desktop notifications.";
    case "default":
      return "Allow browser notifications to get alerts when chats or terminal agents finish or need input in the background.";
  }
}
