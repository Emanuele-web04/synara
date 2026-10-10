import { ThreadId } from "@synara/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useEffect, useRef, useState } from "react";
import { toastManager } from "../components/ui/toast";
import { resolveVisibleToastThreadIds } from "../components/ui/toastRouteVisibility";
import { useAppSettings } from "../appSettings";
import { isElectron } from "../env";
import { useDiffRouteSearch } from "../hooks/useDiffRouteSearch";
import { selectSplitView, useSplitViewStore } from "../splitViewStore";
import { selectRightDockState, useRightDockStore } from "../rightDockStore";
import { useStore } from "../store";
import {
  collectSnoozedThreadIds,
  createAllThreadsSelector,
  createSidebarThreadSummariesSelector,
} from "../storeSelectors";
import { useTerminalStateStore } from "../terminalStateStore";
import type { Thread } from "../types";
import {
  buildTerminalAttentionCopy,
  buildTerminalCompletionCopy,
  buildInputNeededCopy,
  buildTaskCompletionCopy,
  collectCompletedThreadCandidates,
  completedThreadNotificationKey,
  collectCompletedTerminalCandidates,
  collectInputNeededThreadCandidates,
  collectTerminalAttentionCandidates,
  collectSnoozeReminderCandidates,
  isNotificationRuntimeFreshTimestamp,
  shouldAttemptSystemTaskNotification,
  shouldShowThreadNotificationToast,
} from "./taskCompletion.logic";
import { claimSnoozeReminder } from "./snoozeReminderReceipts";

export type BrowserNotificationPermissionState =
  | NotificationPermission
  | "unsupported"
  | "insecure";

function isBrowserNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

// permission asks need a secure context and a user gesture
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

// notification opens clear splitViewId instead of resurrecting a hidden split pairing
function focusThread(threadId: Thread["id"], navigate: ReturnType<typeof useNavigate>): void {
  void navigate({
    to: "/$threadId",
    params: { threadId },
    search: (previous) => ({ ...previous, splitViewId: undefined }),
  });
}

async function showSystemThreadNotification(
  copy: ThreadNotificationCopy,
  threadId: Thread["id"],
  navigate: ReturnType<typeof useNavigate>,
): Promise<boolean> {
  const { body, title } = copy;

  if (window.desktopBridge) {
    const supported = await window.desktopBridge.notifications.isSupported();
    if (!supported) {
      return false;
    }
    return window.desktopBridge.notifications.show({
      title,
      body,
      silent: false,
      suppressWhenForeground: true,
      threadId,
    });
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
    focusThread(threadId, navigate);
  });
  return true;
}

function showThreadToast(
  copy: ThreadNotificationCopy,
  threadId: Thread["id"],
  tone: "success" | "warning",
  navigate: ReturnType<typeof useNavigate>,
): void {
  const { body, title } = copy;
  toastManager.add({
    type: tone,
    title,
    description: body,
    data: {
      allowCrossThreadVisibility: true,
      compactContextual: true,
      threadId,
      dismissAfterVisibleMs: 8000,
    },
    actionProps: {
      "aria-label": `Open ${title}`,
      children: "Open",
      onClick: () => focusThread(threadId, navigate),
    },
  });
}

export function TaskCompletionNotifications() {
  const { settings } = useAppSettings();
  const navigate = useNavigate();
  const activeThreadId = useParams({
    strict: false,
    select: (params) =>
      typeof params.threadId === "string" ? ThreadId.makeUnsafe(params.threadId) : null,
  });
  const routeSearch = useDiffRouteSearch();
  const splitView = useSplitViewStore(
    useMemo(() => selectSplitView(routeSearch.splitViewId ?? null), [routeSearch.splitViewId]),
  );
  const rightDockState = useRightDockStore(
    useMemo(() => selectRightDockState(activeThreadId), [activeThreadId]),
  );
  const [allThreadsSelector] = useState(() => createAllThreadsSelector());
  const threads = useStore(allThreadsSelector);
  const [sidebarSummariesSelector] = useState(() => createSidebarThreadSummariesSelector());
  const sidebarSummaries = useStore(sidebarSummariesSelector);
  const snoozedThreadIds = useMemo(
    () => collectSnoozedThreadIds(sidebarSummaries),
    [sidebarSummaries],
  );
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const terminalStateByThreadId = useTerminalStateStore((store) => store.terminalStateByThreadId);
  const visibleThreadIds = resolveVisibleToastThreadIds({
    activeThreadId,
    splitView,
    rightDockRendered: routeSearch.view !== "editor",
    rightDockState,
  });
  const previousThreadsRef = useRef<readonly Thread[]>([]);
  const previousTerminalStateRef = useRef(terminalStateByThreadId);
  // lazy init keeps the impure Date.now() out of re-renders
  const [runtimeStartedAtMs] = useState(() => Date.now());
  const readyRef = useRef(false);
  const notifiedCompletionKeysRef = useRef(new Set<string>());
  const notifiedSnoozeKeysRef = useRef(new Set<string>());

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
      focusThread(threadId as Thread["id"], navigate);
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  useEffect(() => {
    if (!threadsHydrated) return;
    // Parent ToastProvider subscribes in its passive effect, after this child.
    // Deliver after those effects so hydration cannot consume a lost toast.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      let storage: Storage | undefined;
      try {
        storage = window.localStorage;
      } catch {
        // In-memory receipts keep this runtime usable with storage blocked.
      }
      const systemEnabled = shouldAttemptSystemTaskNotification({
        enabled: settings.enableSystemTaskCompletionNotifications,
        isWindowForeground: isWindowForeground(),
      });
      for (const reminder of collectSnoozeReminderCandidates(sidebarSummaries)) {
        const key = `${reminder.threadId}:${reminder.reminderAt}`;
        if (notifiedSnoozeKeysRef.current.has(key)) continue;
        notifiedSnoozeKeysRef.current.add(key);
        if (!claimSnoozeReminder(reminder.threadId, reminder.reminderAt, storage)) continue;
        const copy = {
          title: reminder.title.trim() || "Untitled thread",
          body: "Ready to pick this thread back up.",
        };
        if (settings.enableTaskCompletionToasts) {
          showThreadToast(copy, reminder.threadId, "success", navigate);
        }
        if (systemEnabled) {
          void showSystemThreadNotification(copy, reminder.threadId, navigate);
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    navigate,
    settings.enableSystemTaskCompletionNotifications,
    settings.enableTaskCompletionToasts,
    sidebarSummaries,
    threadsHydrated,
  ]);

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

    const completions = collectCompletedThreadCandidates(previousThreadsRef.current, threads, {
      waitForSubagents: settings.notifyAfterSubagentsFinish,
    }).filter(
      (candidate) =>
        isNotificationRuntimeFreshTimestamp(candidate.completedAt, runtimeStartedAtMs) &&
        !snoozedThreadIds.has(candidate.threadId) &&
        !notifiedCompletionKeysRef.current.has(completedThreadNotificationKey(candidate)),
    );
    const terminalCompletions = collectCompletedTerminalCandidates(
      previousTerminalStateRef.current,
      terminalStateByThreadId,
    ).filter((candidate) => !snoozedThreadIds.has(candidate.threadId));
    const inputNeededCandidates = collectInputNeededThreadCandidates(
      previousThreadsRef.current,
      threads,
    ).filter(
      (candidate) =>
        isNotificationRuntimeFreshTimestamp(candidate.createdAt, runtimeStartedAtMs) &&
        !snoozedThreadIds.has(candidate.threadId),
    );
    const terminalAttentionCandidates = collectTerminalAttentionCandidates(
      previousTerminalStateRef.current,
      terminalStateByThreadId,
    ).filter((candidate) => !snoozedThreadIds.has(candidate.threadId));
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

    const shouldAttemptSystemNotification = shouldAttemptSystemTaskNotification({
      enabled: settings.enableSystemTaskCompletionNotifications,
      isWindowForeground: isWindowForeground(),
    });

    for (const completion of completions) {
      notifiedCompletionKeysRef.current.add(completedThreadNotificationKey(completion));
      const copy = buildTaskCompletionCopy(completion);
      if (
        settings.enableTaskCompletionToasts &&
        shouldShowThreadNotificationToast({
          threadId: completion.threadId,
          visibleThreadIds,
        })
      ) {
        showThreadToast(copy, completion.threadId, "success", navigate);
      }

      if (shouldAttemptSystemNotification) {
        void showSystemThreadNotification(copy, completion.threadId, navigate);
      }
    }

    for (const candidate of inputNeededCandidates) {
      const copy = buildInputNeededCopy(candidate);
      if (
        settings.enableTaskCompletionToasts &&
        shouldShowThreadNotificationToast({
          threadId: candidate.threadId,
          visibleThreadIds,
        })
      ) {
        showThreadToast(copy, candidate.threadId, "warning", navigate);
      }

      if (shouldAttemptSystemNotification) {
        void showSystemThreadNotification(copy, candidate.threadId, navigate);
      }
    }

    for (const completion of terminalCompletions) {
      const copy = buildTerminalCompletionCopy(completion);
      if (
        settings.enableTaskCompletionToasts &&
        shouldShowThreadNotificationToast({
          threadId: completion.threadId,
          visibleThreadIds,
        })
      ) {
        showThreadToast(copy, completion.threadId, "success", navigate);
      }

      if (shouldAttemptSystemNotification) {
        void showSystemThreadNotification(copy, completion.threadId, navigate);
      }
    }

    for (const candidate of terminalAttentionCandidates) {
      const copy = buildTerminalAttentionCopy(candidate);
      if (
        settings.enableTaskCompletionToasts &&
        shouldShowThreadNotificationToast({
          threadId: candidate.threadId,
          visibleThreadIds,
        })
      ) {
        showThreadToast(copy, candidate.threadId, "warning", navigate);
      }

      if (shouldAttemptSystemNotification) {
        void showSystemThreadNotification(copy, candidate.threadId, navigate);
      }
    }
  }, [
    navigate,
    settings.enableSystemTaskCompletionNotifications,
    settings.enableTaskCompletionToasts,
    settings.notifyAfterSubagentsFinish,
    terminalStateByThreadId,
    snoozedThreadIds,
    threads,
    threadsHydrated,
    visibleThreadIds,
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
