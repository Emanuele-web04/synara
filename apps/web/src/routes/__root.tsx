import {
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type ServerConfig,
} from "@t3tools/contracts";
import { defaultTerminalTitleForCliKind } from "@t3tools/shared/terminalThreads";
import {
  Outlet,
  createRootRouteWithContext,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";

import { APP_DISPLAY_NAME } from "../branding";
import ShortcutsDialog from "../components/ShortcutsDialog";
import WhatsNewDialog from "../components/WhatsNewDialog";
import { useWhatsNew } from "../whatsNew/useWhatsNew";
import { WhatsNewPopoutCard } from "../whatsNew/WhatsNewPopoutCard";
import { shouldRenderTerminalWorkspace } from "../components/ChatView.logic";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { useGitProgressToastPreview } from "../components/useGitProgressToastPreview";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { useFeatureFlags } from "../featureFlags";
import { useFocusedChatContext } from "../focusedChatContext";
import { isTerminalFocused } from "../lib/terminalFocus";
import {
  serverConfigQueryOptions,
  serverQueryKeys,
  serverSettingsQueryOptions,
} from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { terminalActivityFromEvent } from "../terminalActivity";
import {
  onServerConfigUpdated,
  onServerProviderStatusesUpdated,
  onServerSettingsUpdated,
  onServerWelcome,
} from "../wsNativeApi";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { projectQueryKeys } from "../lib/projectReactQuery";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";
import { dockTerminalThreadId } from "../lib/dockTerminalScope";
import { TaskCompletionNotifications } from "../notifications/taskCompletion";
import { useWorkspaceStore, workspaceThreadId } from "../workspaceStore";
import {
  subscribeRetainedThreadDetailIdChanges,
  useRetainedThreadDetailIds,
} from "../threadDetailSubscriptionRetention";
import { useAppTypography } from "../hooks/useAppTypography";
import { useChatCodeFont } from "../hooks/useChatCodeFont";
import { useTheme } from "../hooks/useTheme";
import { useUIFont } from "../hooks/useUIFont";
import { useNativeFontSmoothing } from "../hooks/useNativeFontSmoothing";
import { invalidateGitQueries, invalidateGitQueriesForCwds } from "../lib/gitReactQuery";
import { hasLiveThreadsWithMissingProjects } from "../lib/desktopProjectRecovery";
import { useDiffRouteSearch } from "../hooks/useDiffRouteSearch";
import { resolveSplitViewThreadIds, selectSplitView, useSplitViewStore } from "../splitViewStore";
import { providerDiscoveryQueryKeys } from "../lib/providerDiscoveryReactQuery";
import {
  getGitInvalidationThreadIdForEvent,
  resolveGitInvalidationCwdForThreadId,
  shouldInvalidateGitQueriesForEvent,
  shouldInvalidateProviderQueriesForEvent,
} from "./-rootEventInvalidation";
import {
  coalesceOrchestrationUiEvents,
  isThreadDetailEventForThread,
  reconcilePromotedDraftFromThreadDetail,
  reconcilePromotedDraftsFromShellThreads,
  shouldFlushDomainEventImmediately,
  shouldPollThreadDetailCatchup,
} from "./-rootEventCoalescing";
import { ProviderUpdateNotifications } from "./-ProviderUpdateNotifications";
import { RootRouteErrorView } from "./-RootRouteError";

const SHELL_SNAPSHOT_BOOTSTRAP_FALLBACK_DELAY_MS = 1_500;
const THREAD_DETAIL_CATCHUP_INTERVAL_MS = 1_500;

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
  useAppTypography();
  useChatCodeFont();
  useNativeFontSmoothing();
  useTheme();
  useUIFont();

  if (!readNativeApi()) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Connecting to {APP_DISPLAY_NAME} server...
          </p>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider position="top-center">
      <AnchoredToastProvider>
        <GitProgressToastPreviewDev />
        <EventRouter />
        <GlobalShortcutsDialog />
        <GlobalWhatsNewSurface />
        <TaskCompletionNotifications />
        <ProviderUpdateNotifications />
        <DesktopProjectBootstrap />
        <Outlet />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function GitProgressToastPreviewDev() {
  const featureFlags = useFeatureFlags();
  const enabled = import.meta.env.DEV && featureFlags["pin-git-progress-toast-preview"];
  useGitProgressToastPreview(enabled);
  return null;
}

function GlobalShortcutsDialog() {
  const [open, setOpen] = useState(false);
  const { focusedThreadId, activeProject } = useFocusedChatContext();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? [];
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const activeThreadTerminalState = useTerminalStateStore((state) =>
    focusedThreadId
      ? selectThreadTerminalState(state.terminalStateByThreadId, focusedThreadId)
      : null,
  );
  const terminalOpen = activeThreadTerminalState?.terminalOpen ?? false;
  const terminalWorkspaceOpen = shouldRenderTerminalWorkspace({
    activeProjectExists: activeProject !== null,
    presentationMode: activeThreadTerminalState?.presentationMode ?? "drawer",
    terminalOpen,
  });

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "show-shortcuts") {
        setOpen(true);
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  return (
    <ShortcutsDialog
      open={open}
      onOpenChange={setOpen}
      keybindings={keybindings}
      projectScripts={activeProject?.kind === "project" ? activeProject.scripts : []}
      platform={platform}
      context={{
        terminalFocus: isTerminalFocused(),
        terminalOpen,
        terminalWorkspaceOpen,
      }}
    />
  );
}

function GlobalWhatsNewSurface() {
  // Single mount point per app session. The hook owns the "popout visible" and
  // "dialog open" booleans and the seen-marker persistence; this component is
  // just the plumbing that renders them together so they share one entry.
  const {
    currentEntry,
    allEntries,
    currentVersion,
    isPopoutVisible,
    isDialogOpen,
    openDialog,
    dismissPopout,
    onDialogOpenChange,
  } = useWhatsNew();

  if (!currentEntry) {
    // Silent-bootstrap or noop — nothing to render on either surface.
    return null;
  }

  return (
    <>
      {isPopoutVisible && (
        <WhatsNewPopoutCard
          entry={currentEntry}
          currentVersion={currentVersion}
          onOpen={openDialog}
          onDismiss={dismissPopout}
        />
      )}
      <WhatsNewDialog
        open={isDialogOpen}
        onOpenChange={onDialogOpenChange}
        currentEntry={currentEntry}
        allEntries={allEntries}
        currentVersion={currentVersion}
      />
    </>
  );
}

function EventRouter() {
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const syncServerThreadDetailHotPath = useStore((store) => store.syncServerThreadDetailHotPath);
  const applyShellEvent = useStore((store) => store.applyShellEvent);
  const applyOrchestrationEventsHotPath = useStore(
    (store) => store.applyOrchestrationEventsHotPath,
  );
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const removeOrphanedTerminalStates = useTerminalStateStore(
    (store) => store.removeOrphanedTerminalStates,
  );
  const setWorkspaceHomeDir = useWorkspaceStore((store) => store.setHomeDir);
  const workspacePages = useWorkspaceStore((store) => store.workspacePages);
  const serverThreads = useStore((store) => store.threads);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const routeSearch = useDiffRouteSearch();
  const activeSplitView = useSplitViewStore(selectSplitView(routeSearch.splitViewId ?? null));
  const visibleThreadIds = useMemo(() => {
    if (activeSplitView) {
      return resolveSplitViewThreadIds(activeSplitView);
    }
    return routeThreadId ? [routeThreadId] : [];
  }, [activeSplitView, routeThreadId]);
  const retainedThreadIds = useRetainedThreadDetailIds();
  const serverThreadIds = useMemo(
    () => new Set(serverThreads.map((thread) => thread.id)),
    [serverThreads],
  );
  const subscribedThreadIds = useMemo(() => {
    const nextThreadIds = new Set<ThreadId>();
    for (const threadId of visibleThreadIds) {
      // Visible draft routes need a detail subscription before their shell row exists.
      // Otherwise fast provider responses can complete before the promoted thread is
      // known to the shell list, leaving the chat detail stuck on its optimistic state.
      nextThreadIds.add(threadId);
    }
    for (const threadId of retainedThreadIds) {
      if (serverThreadIds.has(threadId)) {
        nextThreadIds.add(threadId);
      }
    }
    return [...nextThreadIds];
  }, [retainedThreadIds, serverThreadIds, visibleThreadIds]);
  const workspacePagesRef = useRef(workspacePages);
  const pathnameRef = useRef(pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const routeVisibleThreadIdsRef = useRef(visibleThreadIds);
  const visibleThreadIdsRef = useRef(subscribedThreadIds);
  const reconcileThreadSubscriptionsRef = useRef<
    ((threadIds: readonly ThreadId[]) => Promise<void>) | null
  >(null);

  workspacePagesRef.current = workspacePages;
  pathnameRef.current = pathname;
  routeVisibleThreadIdsRef.current = visibleThreadIds;
  visibleThreadIdsRef.current = subscribedThreadIds;

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    let disposed = false;
    let needsProviderInvalidation = false;
    let needsBroadGitInvalidation = false;
    let pendingGitInvalidationThreadIds = new Set<ThreadId>();
    let pendingDomainEvents: OrchestrationEvent[] = [];
    const immediatelyFlushedStreamKeys = new Set<string>();
    let shellSnapshotSequence = -1;
    let pendingShellEvents: OrchestrationShellStreamEvent[] = [];
    const subscribedThreadIds = new Set<ThreadId>();
    const threadSnapshotSequenceById = new Map<ThreadId, number>();
    const pendingThreadEventsById = new Map<ThreadId, OrchestrationEvent[]>();
    const threadSnapshotRequestInFlight = new Set<ThreadId>();
    const threadReplayRequestInFlight = new Set<ThreadId>();
    let reconcileThreadSubscriptionsChain = Promise.resolve();

    const beginThreadSubscription = (threadId: ThreadId) => {
      threadSnapshotSequenceById.delete(threadId);
      pendingThreadEventsById.set(threadId, []);
      threadSnapshotRequestInFlight.delete(threadId);
    };

    // Draft routes can subscribe before the server thread exists. Once the shell
    // row appears, explicitly request the first thread snapshot so buffered detail
    // events can flush instead of waiting forever.
    const requestThreadSnapshot = async (threadId: ThreadId) => {
      if (threadSnapshotSequenceById.has(threadId) || threadSnapshotRequestInFlight.has(threadId)) {
        return;
      }
      threadSnapshotRequestInFlight.add(threadId);
      try {
        await api.orchestration.subscribeThread({ threadId });
      } catch {
        // Keep the pending buffer intact and retry on the next shell/detail update.
      } finally {
        threadSnapshotRequestInFlight.delete(threadId);
      }
    };

    const flushThreadBuffer = (threadId: ThreadId, snapshotSequence: number) => {
      const pendingEvents = pendingThreadEventsById.get(threadId) ?? [];
      pendingThreadEventsById.delete(threadId);
      let latestThreadSequence = threadSnapshotSequenceById.get(threadId) ?? snapshotSequence;
      for (const event of pendingEvents.toSorted((left, right) => left.sequence - right.sequence)) {
        if (event.sequence > latestThreadSequence) {
          latestThreadSequence = event.sequence;
          threadSnapshotSequenceById.set(threadId, latestThreadSequence);
          queueDomainEvent(event);
        }
      }
    };

    const flushShellBuffer = (snapshotSequence: number) => {
      const nextPending = pendingShellEvents
        .filter((event) => event.sequence > snapshotSequence)
        .toSorted((left, right) => left.sequence - right.sequence);
      pendingShellEvents = [];
      for (const event of nextPending) {
        shellSnapshotSequence = Math.max(shellSnapshotSequence, event.sequence);
        applyShellEvent(event);
      }
    };

    const reconcileThreadSubscriptions = async (threadIds: readonly ThreadId[]) => {
      const nextThreadIds = new Set(threadIds);
      const removals = [...subscribedThreadIds].filter((threadId) => !nextThreadIds.has(threadId));
      const additions = [...nextThreadIds].filter((threadId) => !subscribedThreadIds.has(threadId));

      // Start new detail snapshots first so route changes can paint from the hot thread cache.
      for (const threadId of additions) {
        beginThreadSubscription(threadId);
        subscribedThreadIds.add(threadId);
      }
      await Promise.all(
        additions.map((threadId) =>
          api.orchestration.subscribeThread({ threadId }).catch(() => undefined),
        ),
      );

      for (const threadId of removals) {
        threadSnapshotSequenceById.delete(threadId);
        pendingThreadEventsById.delete(threadId);
        threadSnapshotRequestInFlight.delete(threadId);
        threadReplayRequestInFlight.delete(threadId);
        subscribedThreadIds.delete(threadId);
      }
      await Promise.all(
        removals.map((threadId) =>
          api.orchestration.unsubscribeThread({ threadId }).catch(() => undefined),
        ),
      );
    };

    const enqueueThreadSubscriptionReconcile = (threadIds: readonly ThreadId[]) => {
      const nextThreadIds = [...threadIds];
      reconcileThreadSubscriptionsChain = reconcileThreadSubscriptionsChain
        .catch(() => undefined)
        .then(() => reconcileThreadSubscriptions(nextThreadIds));
      return reconcileThreadSubscriptionsChain;
    };

    const unsubscribeRetainedThreadIdChanges = subscribeRetainedThreadDetailIdChanges(
      (nextRetainedThreadIds) => {
        const nextThreadIds = new Set(routeVisibleThreadIdsRef.current);
        for (const threadId of nextRetainedThreadIds) {
          nextThreadIds.add(threadId);
        }
        void enqueueThreadSubscriptionReconcile([...nextThreadIds]);
      },
    );

    const shouldApplyBootstrapShellSnapshot = (snapshot: OrchestrationShellSnapshot) => {
      if (disposed) {
        return false;
      }
      const currentState = useStore.getState();
      if (!currentState.threadsHydrated) {
        return true;
      }
      // Desktop can briefly hydrate from an empty startup stream before the
      // projection reader is fully ready. Let the later non-empty shell query win.
      return (
        (currentState.projects.length === 0 && snapshot.projects.length > 0) ||
        (currentState.threads.length === 0 && snapshot.threads.length > 0)
      );
    };

    const loadShellSnapshotOnce = async () => {
      const snapshot = await api.orchestration.getShellSnapshot();
      if (!shouldApplyBootstrapShellSnapshot(snapshot)) {
        return;
      }
      shellSnapshotSequence = snapshot.snapshotSequence;
      syncServerShellSnapshot(snapshot);
      reconcilePromotedDraftsFromShellThreads(snapshot.threads);
      removeOrphanedTerminalsForCurrentState();
      flushShellBuffer(snapshot.snapshotSequence);
    };

    const ensureScopedSubscriptions = async () => {
      shellSnapshotSequence = -1;
      pendingShellEvents = [];
      subscribedThreadIds.clear();
      threadSnapshotSequenceById.clear();
      pendingThreadEventsById.clear();
      threadReplayRequestInFlight.clear();
      await api.orchestration.subscribeShell().catch(() => loadShellSnapshotOnce());
      await enqueueThreadSubscriptionReconcile(visibleThreadIdsRef.current);
    };

    const removeOrphanedTerminalsForCurrentState = () => {
      const draftThreadIds = Object.keys(
        useComposerDraftStore.getState().draftThreadsByThreadId,
      ) as ThreadId[];
      const activeThreadIds = collectActiveTerminalThreadIds({
        snapshotThreads: useStore.getState().threads.map((thread) => ({
          id: thread.id,
          deletedAt: null,
          archivedAt: thread.archivedAt ?? null,
        })),
        draftThreadIds,
        retainedThreadIds: workspacePagesRef.current.map((workspace) =>
          workspaceThreadId(workspace.id),
        ),
      });
      // Right-dock terminals live under a synthetic scope derived from each active
      // thread; retain those scopes so docked terminals are not pruned mid-session.
      // Snapshot first: we mutate the set while iterating its prior membership.
      for (const activeThreadId of Array.from(activeThreadIds)) {
        activeThreadIds.add(dockTerminalThreadId(activeThreadId));
      }
      removeOrphanedTerminalStates(activeThreadIds);
    };

    const flushPendingDomainEvents = () => {
      if (pendingDomainEvents.length > 0) {
        applyOrchestrationEventsHotPath(coalesceOrchestrationUiEvents(pendingDomainEvents));
        pendingDomainEvents = [];
      }
      if (needsProviderInvalidation) {
        needsProviderInvalidation = false;
        void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
        // Invalidate workspace entry queries so the @-mention file picker
        // reflects files created, deleted, or restored during this turn.
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
      }
      if (needsBroadGitInvalidation) {
        needsBroadGitInvalidation = false;
        pendingGitInvalidationThreadIds = new Set();
        void invalidateGitQueries(queryClient);
      } else if (pendingGitInvalidationThreadIds.size > 0) {
        const currentState = useStore.getState();
        const scopedCwds = new Set<string>();
        let hasUnresolvedThread = false;
        for (const threadId of pendingGitInvalidationThreadIds) {
          const cwd = resolveGitInvalidationCwdForThreadId(currentState, threadId);
          if (cwd) {
            scopedCwds.add(cwd);
          } else {
            hasUnresolvedThread = true;
          }
        }
        pendingGitInvalidationThreadIds = new Set();
        if (hasUnresolvedThread || scopedCwds.size === 0) {
          void invalidateGitQueries(queryClient);
        } else {
          void invalidateGitQueriesForCwds(queryClient, scopedCwds);
        }
      }
    };

    const queueDomainEvent = (event: OrchestrationEvent) => {
      pendingDomainEvents.push(event);
      if (shouldInvalidateProviderQueriesForEvent(event)) {
        needsProviderInvalidation = true;
      }
      if (shouldInvalidateGitQueriesForEvent(event)) {
        const threadId = getGitInvalidationThreadIdForEvent(event);
        if (threadId) {
          pendingGitInvalidationThreadIds.add(threadId);
        } else {
          needsBroadGitInvalidation = true;
        }
      }
      if (shouldFlushDomainEventImmediately(event, immediatelyFlushedStreamKeys)) {
        domainEventFlushThrottler.cancel();
        flushPendingDomainEvents();
        return;
      }
      domainEventFlushThrottler.maybeExecute();
    };

    const replayThreadEvents = async (
      threadId: ThreadId,
      targetSequence?: number,
    ): Promise<void> => {
      if (disposed || threadReplayRequestInFlight.has(threadId)) {
        return;
      }
      const fromSequence = threadSnapshotSequenceById.get(threadId);
      if (
        fromSequence === undefined ||
        (targetSequence !== undefined && fromSequence >= targetSequence)
      ) {
        return;
      }
      threadReplayRequestInFlight.add(threadId);
      try {
        const replayedEvents = await api.orchestration.replayEvents(fromSequence);
        for (const event of replayedEvents
          .filter((candidate) => isThreadDetailEventForThread(candidate, threadId))
          .filter(
            (candidate) => targetSequence === undefined || candidate.sequence <= targetSequence,
          )
          .toSorted((left, right) => left.sequence - right.sequence)) {
          const latestThreadSequence = threadSnapshotSequenceById.get(threadId) ?? fromSequence;
          if (event.sequence <= latestThreadSequence) {
            continue;
          }
          threadSnapshotSequenceById.set(threadId, event.sequence);
          queueDomainEvent(event);
        }
      } finally {
        threadReplayRequestInFlight.delete(threadId);
      }
    };

    const domainEventFlushThrottler = new Throttler(
      () => {
        flushPendingDomainEvents();
      },
      {
        wait: 100,
        leading: false,
        trailing: true,
      },
    );

    reconcileThreadSubscriptionsRef.current = (threadIds) =>
      enqueueThreadSubscriptionReconcile(threadIds);

    const unsubShellEvent = api.orchestration.onShellEvent((item) => {
      if (item.kind === "snapshot") {
        shellSnapshotSequence = item.snapshot.snapshotSequence;
        syncServerShellSnapshot(item.snapshot);
        reconcilePromotedDraftsFromShellThreads(item.snapshot.threads);
        removeOrphanedTerminalsForCurrentState();
        flushShellBuffer(item.snapshot.snapshotSequence);
        return;
      }

      if (shellSnapshotSequence < 0) {
        pendingShellEvents.push(item);
        return;
      }
      if (item.sequence <= shellSnapshotSequence) {
        return;
      }
      shellSnapshotSequence = item.sequence;
      applyShellEvent(item);
      if (item.kind === "thread-upserted") {
        reconcilePromotedDraftsFromShellThreads([item.thread]);
      }
      if (
        item.kind === "thread-upserted" &&
        subscribedThreadIds.has(item.thread.id) &&
        !threadSnapshotSequenceById.has(item.thread.id)
      ) {
        void requestThreadSnapshot(item.thread.id);
      }
      if (item.kind === "thread-upserted" && subscribedThreadIds.has(item.thread.id)) {
        void replayThreadEvents(item.thread.id, item.sequence).catch(() => undefined);
      }
    });
    const unsubThreadEvent = api.orchestration.onThreadEvent((item) => {
      if (item.kind === "snapshot") {
        const threadId = item.snapshot.thread.id;
        threadSnapshotSequenceById.set(threadId, item.snapshot.snapshotSequence);
        threadSnapshotRequestInFlight.delete(threadId);
        syncServerThreadDetailHotPath(item.snapshot.thread);
        reconcilePromotedDraftFromThreadDetail(item.snapshot.thread);
        flushThreadBuffer(threadId, item.snapshot.snapshotSequence);
        return;
      }

      const threadId = ThreadId.makeUnsafe(String(item.event.aggregateId));
      const latestThreadSequence = threadSnapshotSequenceById.get(threadId);
      if (latestThreadSequence === undefined) {
        const pendingThreadEvents = pendingThreadEventsById.get(threadId) ?? [];
        pendingThreadEvents.push(item.event);
        pendingThreadEventsById.set(threadId, pendingThreadEvents);
        if (subscribedThreadIds.has(threadId)) {
          void requestThreadSnapshot(threadId);
        }
        return;
      }
      if (item.event.sequence <= latestThreadSequence) {
        return;
      }
      threadSnapshotSequenceById.set(threadId, item.event.sequence);
      queueDomainEvent(item.event);
    });
    const unsubTerminalEvent = api.terminal.onEvent((event) => {
      const terminalThreadId = ThreadId.makeUnsafe(event.threadId);
      if (event.type === "activity") {
        if (event.cliKind) {
          useTerminalStateStore.getState().setTerminalMetadata(terminalThreadId, event.terminalId, {
            cliKind: event.cliKind,
            label: defaultTerminalTitleForCliKind(event.cliKind),
          });
        }
      }
      const activity = terminalActivityFromEvent(event);
      if (activity === null) {
        return;
      }
      useTerminalStateStore.getState().setTerminalActivity(terminalThreadId, event.terminalId, {
        hasRunningSubprocess: activity.hasRunningSubprocess,
        agentState: activity.agentState,
      });
    });
    const unsubWelcome = onServerWelcome((payload) => {
      void (async () => {
        setWorkspaceHomeDir(payload.homeDir);
        await ensureScopedSubscriptions();
        if (disposed) {
          return;
        }
        await loadShellSnapshotOnce();

        if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
          return;
        }
        setProjectExpanded(payload.bootstrapProjectId, true);

        if (pathnameRef.current !== "/") {
          return;
        }
        if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
          return;
        }
        await navigate({
          to: "/$threadId",
          params: { threadId: payload.bootstrapThreadId },
          replace: true,
        });
        handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
      })().catch(() => undefined);
    });
    // onServerConfigUpdated replays the latest cached value synchronously
    // during subscribe. Skip the toast for that replay so effect re-runs
    // don't produce duplicate toasts.
    let subscribed = false;
    const unsubServerConfigUpdated = onServerConfigUpdated((payload) => {
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
      if (!subscribed) return;
      const issue = payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      if (!issue) {
        return;
      }

      toastManager.add({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: issue.message,
        actionProps: {
          children: "Open keybindings.json",
          onClick: () => {
            void queryClient
              .ensureQueryData(serverConfigQueryOptions())
              .then((config) => {
                const editor = resolveAndPersistPreferredEditor(config.availableEditors);
                if (!editor) {
                  throw new Error("No available editors found.");
                }
                return api.shell.openInEditor(config.keybindingsConfigPath, editor);
              })
              .catch((error) => {
                toastManager.add({
                  type: "error",
                  title: "Unable to open keybindings file",
                  description:
                    error instanceof Error ? error.message : "Unknown error opening file.",
                });
              });
          },
        },
      });
    });
    const unsubProviderStatusesUpdated = onServerProviderStatusesUpdated((payload) => {
      const currentConfig = queryClient.getQueryData<ServerConfig>(serverQueryKeys.config());
      if (!currentConfig) {
        void queryClient.fetchQuery(serverConfigQueryOptions()).catch(() => undefined);
        return;
      }
      queryClient.setQueryData(serverQueryKeys.config(), {
        ...currentConfig,
        providers: payload.providers,
      });
      // OpenCode-compatible model availability depends on which underlying providers are connected.
      void queryClient.invalidateQueries({
        queryKey: ["provider-discovery", "models", "kilo"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["provider-discovery", "models", "opencode"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["provider-discovery", "models", "cursor"],
      });
      void queryClient.invalidateQueries({
        queryKey: providerDiscoveryQueryKeys.agents("kilo"),
      });
      void queryClient.invalidateQueries({
        queryKey: providerDiscoveryQueryKeys.agents("opencode"),
      });
    });
    const unsubServerSettingsUpdated = onServerSettingsUpdated((payload) => {
      queryClient.setQueryData(serverQueryKeys.settings(), payload.settings);
      void queryClient.invalidateQueries({
        queryKey: serverSettingsQueryOptions().queryKey,
      });
    });
    subscribed = true;
    void ensureScopedSubscriptions();
    // The shell stream normally delivers the sidebar snapshot. If it fails before
    // the first event, use the same lightweight query instead of the full history.
    const shellBootstrapFallbackTimer = window.setTimeout(() => {
      void loadShellSnapshotOnce().catch(() => undefined);
    }, SHELL_SNAPSHOT_BOOTSTRAP_FALLBACK_DELAY_MS);
    const threadDetailCatchupInterval = window.setInterval(() => {
      for (const threadId of subscribedThreadIds) {
        if (shouldPollThreadDetailCatchup(threadId)) {
          if (!threadSnapshotSequenceById.has(threadId)) {
            void requestThreadSnapshot(threadId);
          } else {
            void replayThreadEvents(threadId).catch(() => undefined);
          }
        }
      }
    }, THREAD_DETAIL_CATCHUP_INTERVAL_MS);

    return () => {
      flushPendingDomainEvents();
      disposed = true;
      window.clearTimeout(shellBootstrapFallbackTimer);
      window.clearInterval(threadDetailCatchupInterval);
      needsProviderInvalidation = false;
      needsBroadGitInvalidation = false;
      pendingGitInvalidationThreadIds = new Set();
      domainEventFlushThrottler.cancel();
      reconcileThreadSubscriptionsRef.current = null;
      void api.orchestration.unsubscribeShell().catch(() => undefined);
      void Promise.all(
        [...subscribedThreadIds].map((threadId) =>
          api.orchestration.unsubscribeThread({ threadId }).catch(() => undefined),
        ),
      );
      unsubscribeRetainedThreadIdChanges();
      unsubShellEvent();
      unsubThreadEvent();
      unsubTerminalEvent();
      unsubWelcome();
      unsubServerConfigUpdated();
      unsubProviderStatusesUpdated();
      unsubServerSettingsUpdated();
    };
  }, [
    applyOrchestrationEventsHotPath,
    applyShellEvent,
    navigate,
    queryClient,
    removeOrphanedTerminalStates,
    setProjectExpanded,
    setWorkspaceHomeDir,
    syncServerShellSnapshot,
    syncServerThreadDetailHotPath,
  ]);

  useLayoutEffect(() => {
    const reconcile = reconcileThreadSubscriptionsRef.current;
    if (!reconcile) {
      return;
    }
    void reconcile(subscribedThreadIds);
  }, [subscribedThreadIds]);

  return null;
}

function DesktopProjectBootstrap() {
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const attemptedRecoveryRef = useRef(false);

  useEffect(() => {
    const api = readNativeApi();
    if (!api || attemptedRecoveryRef.current || !threadsHydrated) {
      return;
    }

    const projectIds = new Set(projects.map((project) => project.id));
    const hasThreadWithoutProject = threads.some((thread) => !projectIds.has(thread.projectId));
    if (projects.length > 0 && !hasThreadWithoutProject) {
      return;
    }

    attemptedRecoveryRef.current = true;

    // Shell subscriptions should normally hydrate the sidebar. If project rows
    // are missing while live threads exist, repair before accepting the snapshot.
    void api.orchestration
      .getShellSnapshot()
      .then((snapshot) => {
        const needsRepair =
          (snapshot.projects.length === 0 && snapshot.threads.length === 0) ||
          hasLiveThreadsWithMissingProjects(snapshot);
        if (!needsRepair) {
          useStore.getState().syncServerShellSnapshot(snapshot);
          return snapshot;
        }
        return api.orchestration.repairState().then((repairedSnapshot) => {
          syncServerReadModel(repairedSnapshot);
          return repairedSnapshot;
        });
      })
      .catch(() => {
        attemptedRecoveryRef.current = false;
      });
  }, [projects, syncServerReadModel, threads, threadsHydrated]);

  // Desktop hydration normally runs through EventRouter project + orchestration sync.
  return null;
}
