// FILE: taskCompletion.tsx
// Purpose: Bridges thread completion and attention-needed events to in-app toasts and OS notifications.
// Layer: Notification runtime
// Exports: TaskCompletionNotifications and browser permission helpers

import { ThreadId, type Bot } from "@synara/contracts";
import { useNavigate, useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { useMemo, useEffect, useRef, useState } from "react";
import { toastManager } from "../components/ui/toast";
import { resolveVisibleToastThreadIds } from "../components/ui/toastRouteVisibility";
import { useAppSettings } from "../appSettings";
import { SYNBOT_ON } from "../betaFeatures";
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
import {
  botHasOpenWork,
  botsNewlyWaiting,
  botWaitReason,
  isBotOnScreen,
  synbotPageForThread,
  type BotWaitReason,
} from "../synbot/synbotNotifications.logic";
import { botByThreadId } from "../synbot/synbotState.logic";
import { useSynbotStore } from "../synbot/synbotStore";
import { t } from "~/i18n";

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

/** SynBot (Beta): the bot whose chat `threadId` is; bot chats notify and open as the bot. */
function synbotBotForThread(threadId: string) {
  return SYNBOT_ON ? botByThreadId(useSynbotStore.getState().data, threadId) : null;
}

/** SynBot (Beta): the line a bot that starts waiting on the user notifies with. */
function botWaitText(reason: BotWaitReason): string {
  switch (reason.kind) {
    case "start":
      return t("synbot:notifyStart", { brief: reason.brief.split("\n")[0] });
    case "approval":
      return t("synbot:notifyApproval");
    case "question":
      return t("synbot:notifyQuestion");
    case "task":
      return t("synbot:notifyTask", { title: reason.title });
    case "unknown":
      return t("synbot:status_waiting");
  }
}

/** Waits this long before naming why a bot waits, so the hand-off behind it has arrived. */
const BOT_WAIT_SETTLE_MS = 1_200;

// Notification opens are generic thread activations, so they clear splitViewId
// instead of resurrecting a hidden split pairing. A bot's chat (or one of its tasks' threads)
// opens on the SynBot page.
function focusThread(threadId: Thread["id"], navigate: ReturnType<typeof useNavigate>): void {
  const synbotPage = SYNBOT_ON
    ? synbotPageForThread(useSynbotStore.getState().data, threadId)
    : null;
  if (synbotPage) {
    void navigate({ to: "/synbot", search: synbotPage });
    return;
  }
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
      "aria-label": t("common:open", { title }),
      children: t("onboarding:notification_open"),
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
  // SynBot (Beta): the bot chat on screen ("" is SynBot's), null off the SynBot page.
  const synbotPageBot = useRouterState({
    select: (state) =>
      SYNBOT_ON && state.location.pathname === "/synbot"
        ? ((state.location.search as { readonly bot?: string }).bot ?? "")
        : null,
  });
  const synbotBots = useSynbotStore((store) => store.data.bots);
  const router = useRouter();
  const previousThreadsRef = useRef<readonly Thread[]>([]);
  const previousTerminalStateRef = useRef(terminalStateByThreadId);
  // Lazy state init: evaluated once, keeping the impure Date.now() call out
  // of re-renders (useRef(Date.now()) re-evaluates its argument every render).
  const [runtimeStartedAtMs] = useState(() => Date.now());
  const readyRef = useRef(false);
  const notifiedCompletionKeysRef = useRef(new Set<string>());
  const notifiedSnoozeKeysRef = useRef(new Set<string>());
  const previousBotStatusRef = useRef<ReadonlyMap<string, Bot["status"]> | null>(null);

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
          title: reminder.title.trim() || t("workspace:searchPalette_untitledThread"),
          body: t("common:readyToPickThisThreadBackUp"),
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

  // SynBot (Beta): a bot that starts waiting on the user (a Start, an approval, a question, a
  // task) notifies once, as the bot. Its status is the signal: a bot chat's requests are only
  // loaded while that chat is open.
  useEffect(() => {
    if (!SYNBOT_ON) return;
    const previous = previousBotStatusRef.current;
    previousBotStatusRef.current = new Map(synbotBots.map((bot) => [bot.id, bot.status]));
    const entered = previous ? botsNewlyWaiting(previous, synbotBots) : [];
    if (entered.length === 0) return;
    // Not cleared on the next change: a later bot event must not drop this one.
    window.setTimeout(() => {
      const data = useSynbotStore.getState().data;
      const systemEnabled = shouldAttemptSystemTaskNotification({
        enabled: settings.enableSystemTaskCompletionNotifications,
        isWindowForeground: isWindowForeground(),
      });
      const { location } = router.state;
      const pageBot =
        location.pathname === "/synbot"
          ? ((location.search as { readonly bot?: string }).bot ?? "")
          : null;
      for (const { id } of entered) {
        const bot = data.bots.find((candidate) => candidate.id === id);
        if (!bot || bot.status !== "waiting") continue;
        const reason = botWaitReason(
          data,
          bot,
          useStore.getState().threadShellById?.[bot.threadId],
        );
        const copy = { title: bot.name, body: botWaitText(reason) };
        // A task's request opens next to the bot's chat, in the task pane.
        const threadId = reason.kind === "task" && reason.threadId ? reason.threadId : bot.threadId;
        if (settings.enableTaskCompletionToasts && !isBotOnScreen(bot, pageBot)) {
          showThreadToast(copy, threadId, "warning", navigate);
        }
        if (systemEnabled) {
          void showSystemThreadNotification(copy, threadId, navigate);
        }
      }
    }, BOT_WAIT_SETTLE_MS);
  }, [
    navigate,
    router,
    settings.enableSystemTaskCompletionNotifications,
    settings.enableTaskCompletionToasts,
    synbotBots,
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
    // SynBot (Beta): a bot's chat notifies under the bot's name and toasts unless it is on screen.
    const asBot = (threadId: Thread["id"], copy: ThreadNotificationCopy) => {
      const bot = synbotBotForThread(threadId);
      return bot ? { ...copy, title: bot.name } : copy;
    };
    const shouldToast = (threadId: Thread["id"]) => {
      const bot = synbotBotForThread(threadId);
      return bot
        ? !isBotOnScreen(bot, synbotPageBot)
        : shouldShowThreadNotificationToast({ threadId, visibleThreadIds });
    };

    for (const completion of completions) {
      notifiedCompletionKeysRef.current.add(completedThreadNotificationKey(completion));
      // A bot's turn that handed work out or started a task stays quiet: the report or recap
      // that follows once the work settles is the one that notifies.
      const bot = synbotBotForThread(completion.threadId);
      if (bot && botHasOpenWork(useSynbotStore.getState().data, bot)) continue;
      const copy = asBot(completion.threadId, buildTaskCompletionCopy(completion));
      if (settings.enableTaskCompletionToasts && shouldToast(completion.threadId)) {
        showThreadToast(copy, completion.threadId, "success", navigate);
      }

      if (shouldAttemptSystemNotification) {
        void showSystemThreadNotification(copy, completion.threadId, navigate);
      }
    }

    for (const candidate of inputNeededCandidates) {
      // A bot's request (its chat's or one of its tasks') notifies through its waiting status.
      if (SYNBOT_ON && synbotPageForThread(useSynbotStore.getState().data, candidate.threadId)) {
        continue;
      }
      const copy = buildInputNeededCopy(candidate);
      if (settings.enableTaskCompletionToasts && shouldToast(candidate.threadId)) {
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
    runtimeStartedAtMs,
    terminalStateByThreadId,
    snoozedThreadIds,
    synbotPageBot,
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
    return t("common:desktopAppNotificationsUseYourOperatingSystemNotificationCenter");
  }
  switch (permissionState) {
    case "granted":
      return t("common:browserNotificationsAreEnabledForThisApp");
    case "denied":
      return t("common:browserNotificationsAreBlockedReEnableThemInYour");
    case "insecure":
      return t("common:browserNotificationsNeedASecureContextLocalhostWorksPlain");
    case "unsupported":
      return t("common:thisBrowserDoesNotSupportDesktopNotifications");
    case "default":
      return t("common:allowBrowserNotificationsToGetAlertsWhenChatsOr");
  }
}
