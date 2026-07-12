// FILE: useRecentViewSwitcher.ts
// Purpose: Own the Ctrl+Tab recent-primary-view MRU wiring for the chat shell.
// Layer: UI hook
// Exports: useRecentViewSwitcher

import { ThreadId, type ProjectId } from "@synara/contracts";
import type { ResolvedTerminalVisualIdentity } from "@synara/shared/terminalThreads";
import { useLocation, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { usePinnedThreadsStore } from "../pinnedThreadsStore";
import {
  buildRecentViewDisplayEntries,
  deriveCurrentRecentView,
  pruneRecentViews,
  recentViewKey,
  resolveRecentViewNavigationIndex,
  type RecentView,
  type RecentViewAvailability,
  type RecentViewDisplayEntry,
  type RecentViewThreadDraftSummary,
} from "../recentViews.logic";
import { resolveRecentThreadSplitActivation } from "../recentViewActivation.logic";
import { useRecentViewsStore } from "../recentViewsStore";
import { collectLeaves } from "../splitView.logic";
import { useSplitViewStore } from "../splitViewStore";
import { useStore } from "../store";
import { useThreadDetailPrewarm } from "../threadDetailPrewarm";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import {
  resolveTerminalVisualIdentityMap,
  selectRepresentativeTerminalVisualIdentity,
} from "../terminalVisualIdentity";
import { useWorkspaceStore } from "../workspaceStore";
import type { useHandleNewThread } from "./useHandleNewThread";

type NewThreadContext = ReturnType<typeof useHandleNewThread>;

const EMPTY_RECENT_VIEW_ENTRIES: RecentViewDisplayEntry[] = [];

interface RecentViewSwitcherState {
  selectedIndex: number;
  selectedKey: string;
}

interface UseRecentViewSwitcherInput {
  activeContextThreadId: NewThreadContext["activeContextThreadId"];
  activeDraftThread: NewThreadContext["activeDraftThread"];
  projects: NewThreadContext["projects"];
}

// Encapsulates recent-view persistence, pruning, prewarm, and activation.
export function useRecentViewSwitcher(input: UseRecentViewSwitcherInput) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const routeWorkspaceId = useParams({
    strict: false,
    select: (params) => (typeof params.workspaceId === "string" ? params.workspaceId : null),
  });
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const [recentSwitcherState, setRecentSwitcherState] = useState<RecentViewSwitcherState | null>(
    null,
  );
  const recentViews = useRecentViewsStore((state) => state.recentViews);
  const recordRecentView = useRecentViewsStore((state) => state.recordRecentView);
  const pruneRecentViewsStore = useRecentViewsStore((state) => state.pruneRecentViews);
  const { prewarmThreadDetail, prewarmThreadDetails } = useThreadDetailPrewarm();
  const persistedPinnedThreadIds = usePinnedThreadsStore((state) => state.pinnedThreadIds);
  const workspacePages = useWorkspaceStore((state) => state.workspacePages);
  const draftThreadsByThreadId = useComposerDraftStore((state) => state.draftThreadsByThreadId);
  const sidebarThreadSummaryById = useStore((state) => state.sidebarThreadSummaryById);
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const openChatThreadPage = useTerminalStateStore((state) => state.openChatThreadPage);
  const openTerminalThreadPage = useTerminalStateStore((state) => state.openTerminalThreadPage);
  const threadsHydrated = useStore((state) => state.threadsHydrated);
  const routeSplitViewId =
    typeof routeSearch.splitViewId === "string" ? routeSearch.splitViewId : undefined;
  const settingsSection = typeof routeSearch.section === "string" ? routeSearch.section : undefined;
  const currentRecentView = useMemo(
    () =>
      deriveCurrentRecentView({
        pathname,
        routeThreadId,
        activeThreadId: routeThreadId ? (input.activeContextThreadId ?? routeThreadId) : null,
        routeWorkspaceId,
        splitViewId: routeSplitViewId,
        settingsSection,
      }),
    [
      input.activeContextThreadId,
      pathname,
      routeSplitViewId,
      routeThreadId,
      routeWorkspaceId,
      settingsSection,
    ],
  );
  const currentRecentViewKey = currentRecentView ? recentViewKey(currentRecentView) : null;
  const recentThreadIds = useMemo(
    () => recentViews.flatMap((view) => (view.kind === "thread" ? [view.threadId] : [])),
    [recentViews],
  );
  const switcherOpen = recentSwitcherState !== null;
  const recentViewEntries = useMemo<RecentViewDisplayEntry[]>(() => {
    if (!switcherOpen) {
      return EMPTY_RECENT_VIEW_ENTRIES;
    }
    const terminalVisualIdentityByThreadId = new Map<ThreadId, ResolvedTerminalVisualIdentity>();
    for (const view of recentViews) {
      if (view.kind !== "thread") continue;
      const terminalState = selectThreadTerminalState(terminalStateByThreadId, view.threadId);
      if (terminalState.entryPoint === "terminal") {
        const terminalVisualIdentityById = resolveTerminalVisualIdentityMap({
          runningTerminalIds: terminalState.runningTerminalIds,
          terminalAttentionStatesById: terminalState.terminalAttentionStatesById,
          terminalCliKindsById: terminalState.terminalCliKindsById,
          terminalIds: terminalState.terminalIds,
          terminalLabelsById: terminalState.terminalLabelsById,
          terminalTitleOverridesById: terminalState.terminalTitleOverridesById,
        });
        const representativeIdentity = selectRepresentativeTerminalVisualIdentity({
          activeTerminalId: terminalState.activeTerminalId,
          terminalIds: terminalState.terminalIds,
          terminalVisualIdentityById,
        });
        if (representativeIdentity) {
          terminalVisualIdentityByThreadId.set(view.threadId, representativeIdentity.identity);
        }
      }
    }
    const draftThreadsById: Record<string, RecentViewThreadDraftSummary> = {};
    for (const [threadId, draftThread] of Object.entries(draftThreadsByThreadId)) {
      draftThreadsById[threadId] = {
        id: ThreadId.makeUnsafe(threadId),
        projectId: draftThread.projectId,
      };
    }
    if (input.activeDraftThread && input.activeContextThreadId) {
      draftThreadsById[input.activeContextThreadId] = {
        id: input.activeContextThreadId,
        projectId: input.activeDraftThread.projectId,
      };
    }
    return buildRecentViewDisplayEntries({
      recentViews,
      currentView: currentRecentView,
      threadsById: sidebarThreadSummaryById,
      draftThreadsById,
      projects: input.projects,
      pinnedThreadIds: persistedPinnedThreadIds,
      workspacePages,
      terminalVisualIdentityByThreadId,
    });
  }, [
    input.activeContextThreadId,
    input.activeDraftThread,
    currentRecentView,
    draftThreadsByThreadId,
    input.projects,
    persistedPinnedThreadIds,
    recentViews,
    sidebarThreadSummaryById,
    switcherOpen,
    terminalStateByThreadId,
    workspacePages,
  ]);
  const currentRecentViewRef = useRef<RecentView | null>(currentRecentView);
  const recentSwitcherStateRef = useRef<RecentViewSwitcherState | null>(recentSwitcherState);
  const recentViewsRef = useRef(recentViews);
  const activeContextThreadIdRef = useRef(input.activeContextThreadId);
  const activeDraftThreadRef = useRef(input.activeDraftThread);
  const didHydrationPruneRef = useRef(false);

  useEffect(() => {
    currentRecentViewRef.current = currentRecentView;
  }, [currentRecentView]);

  useEffect(() => {
    recentSwitcherStateRef.current = recentSwitcherState;
  }, [recentSwitcherState]);

  useEffect(() => {
    recentViewsRef.current = recentViews;
  }, [recentViews]);

  useEffect(() => {
    activeContextThreadIdRef.current = input.activeContextThreadId;
  }, [input.activeContextThreadId]);

  useEffect(() => {
    activeDraftThreadRef.current = input.activeDraftThread;
  }, [input.activeDraftThread]);

  const buildRecentViewAvailability = useCallback((): RecentViewAvailability => {
    const sidebarThreadSummaryById = useStore.getState().sidebarThreadSummaryById;
    const draftThreadsByThreadId = useComposerDraftStore.getState().draftThreadsByThreadId;
    const splitViewsById = useSplitViewStore.getState().splitViewsById;
    const workspacePages = useWorkspaceStore.getState().workspacePages;
    const activeContextThreadId = activeContextThreadIdRef.current;
    const activeDraftThread = activeDraftThreadRef.current;

    const availableThreadIds = new Set<ThreadId>();
    for (const threadId of Object.keys(sidebarThreadSummaryById)) {
      availableThreadIds.add(ThreadId.makeUnsafe(threadId));
    }
    for (const threadId of Object.keys(draftThreadsByThreadId)) {
      availableThreadIds.add(ThreadId.makeUnsafe(threadId));
    }
    if (activeDraftThread && activeContextThreadId) {
      availableThreadIds.add(activeContextThreadId);
    }

    const availableWorkspaceIds = new Set(workspacePages.map((workspace) => workspace.id));
    const availableSplitViewIds = new Set(
      Object.keys(splitViewsById).filter((splitViewId) => Boolean(splitViewsById[splitViewId])),
    );
    const threadIdsBySplitViewId = new Map<string, Set<ThreadId>>();
    for (const [splitViewId, splitView] of Object.entries(splitViewsById)) {
      if (!splitView) continue;
      const threadIds = new Set<ThreadId>();
      for (const leaf of collectLeaves(splitView.root)) {
        if (leaf.threadId) {
          threadIds.add(leaf.threadId);
        }
      }
      threadIdsBySplitViewId.set(splitViewId, threadIds);
    }

    return {
      availableThreadIds,
      availableWorkspaceIds,
      availableSplitViewIds,
      threadIdsBySplitViewId,
    };
  }, []);

  useEffect(() => {
    if (!currentRecentView) return;
    recordRecentView(currentRecentView);
  }, [currentRecentView, currentRecentViewKey, recordRecentView]);

  useEffect(() => {
    prewarmThreadDetails(recentThreadIds);
  }, [prewarmThreadDetails, recentThreadIds]);

  useEffect(() => {
    if (!threadsHydrated || didHydrationPruneRef.current) return;
    didHydrationPruneRef.current = true;
    pruneRecentViewsStore(buildRecentViewAvailability());
  }, [buildRecentViewAvailability, pruneRecentViewsStore, threadsHydrated]);

  const activateRecentView = useCallback(
    (view: RecentView) => {
      switch (view.kind) {
        case "thread": {
          if (!buildRecentViewAvailability().availableThreadIds.has(view.threadId)) {
            return;
          }
          prewarmThreadDetail(view.threadId);
          const splitActivation = resolveRecentThreadSplitActivation({
            view,
            splitViewsById: useSplitViewStore.getState().splitViewsById,
          });
          if (splitActivation) {
            useSplitViewStore
              .getState()
              .setFocusedPane(splitActivation.splitViewId, splitActivation.paneId);
          }
          const terminalState = selectThreadTerminalState(
            useTerminalStateStore.getState().terminalStateByThreadId,
            view.threadId,
          );
          if (terminalState.entryPoint === "terminal") {
            openTerminalThreadPage(view.threadId);
          } else {
            openChatThreadPage(view.threadId);
          }
          void navigate({
            to: "/$threadId",
            params: { threadId: view.threadId },
            search: () => (splitActivation ? { splitViewId: splitActivation.splitViewId } : {}),
          });
          return;
        }
        case "workspace": {
          const workspaceExists = useWorkspaceStore
            .getState()
            .workspacePages.some((workspace) => workspace.id === view.workspaceId);
          if (!workspaceExists) {
            return;
          }
          void navigate({
            to: "/workspace/$workspaceId",
            params: { workspaceId: view.workspaceId },
          });
          return;
        }
        case "settings":
          void navigate({
            to: "/settings",
            search: () => (view.section ? { section: view.section } : {}),
          });
          return;
        case "plugins":
          void navigate({ to: "/plugins" });
          return;
      }
    },
    [
      buildRecentViewAvailability,
      navigate,
      openChatThreadPage,
      openTerminalThreadPage,
      prewarmThreadDetail,
    ],
  );

  const commitRecentSwitcherSelection = useCallback(() => {
    const state = recentSwitcherStateRef.current;
    if (!state) return;
    const views = recentViewsRef.current;
    const view =
      views.find((candidate) => recentViewKey(candidate) === state.selectedKey) ??
      views[state.selectedIndex];
    setRecentSwitcherState(null);
    if (!view) return;
    activateRecentView(view);
  }, [activateRecentView]);

  const cancelRecentSwitcher = useCallback(() => {
    setRecentSwitcherState(null);
  }, []);

  const openOrAdvanceRecentSwitcher = useCallback(
    (direction: "next" | "previous") => {
      const currentState = recentSwitcherStateRef.current;
      let views = recentViewsRef.current;
      if (currentState === null) {
        const availability = buildRecentViewAvailability();
        pruneRecentViewsStore(availability);
        views = pruneRecentViews(views, availability);
      }
      const selectedIndex = resolveRecentViewNavigationIndex({
        recentViews: views,
        currentView: currentRecentViewRef.current,
        selectedKey: currentState?.selectedKey,
        direction,
      });

      if (selectedIndex === null) {
        return false;
      }

      const selectedView = views[selectedIndex];
      if (!selectedView) {
        return false;
      }

      if (selectedView.kind === "thread") {
        prewarmThreadDetail(selectedView.threadId);
      }

      setRecentSwitcherState({
        selectedIndex,
        selectedKey: recentViewKey(selectedView),
      });
      return true;
    },
    [buildRecentViewAvailability, prewarmThreadDetail, pruneRecentViewsStore],
  );

  useEffect(() => {
    const onWindowKeyUp = (event: KeyboardEvent) => {
      if (!recentSwitcherStateRef.current || event.ctrlKey) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      commitRecentSwitcherSelection();
    };
    const onWindowBlur = () => {
      commitRecentSwitcherSelection();
    };

    window.addEventListener("keyup", onWindowKeyUp, { capture: true });
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keyup", onWindowKeyUp, { capture: true });
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [commitRecentSwitcherSelection]);

  return {
    recentSwitcherState,
    recentViewEntries,
    openOrAdvanceRecentSwitcher,
    commitRecentSwitcherSelection,
    cancelRecentSwitcher,
  };
}
