// FILE: useOpenThreadTabs.ts
// Purpose: Connect the open-thread tab store to the app: derive display tabs from live
//          thread/draft state, record the thread on screen as open, and switch threads
//          from a tab the same way the sidebar and Ctrl+Tab switcher do.
// Layer: UI hooks
// Exports: useOpenThreadTabs, useRecordOpenThreadTab, useActivateThreadTab,
//          useReadRouteThreadId

import type { ProjectId, ThreadId } from "@synara/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";

import { getProviderInstanceOptions, useAppSettings } from "../appSettings";
import { resolveDraftFallbackModelSelection } from "../components/ChatView.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { stripDiffSearchParams } from "../diffRouteSearch";
import {
  getActiveComposerSendThreadIds,
  subscribeComposerSends,
} from "../lib/composerSendOwnership";
import { resolveUnsentComposerProvider } from "../lib/providerAvailability";
import { hasReconciledServerProviderStatuses } from "../lib/serverReactQuery";
import {
  buildOpenThreadTabs,
  canKeepOpenThreadTab,
  type OpenThreadTab,
  type OpenThreadTabSource,
} from "../openThreadTabs.logic";
import { useOpenThreadTabsStore } from "../openThreadTabsStore";
import { useStore } from "../store";
import { selectThreadActivities } from "../threadDerivation";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useThreadDetailPrewarm } from "../threadDetailPrewarm";
import { useProviderStatusesForLocalConfig } from "./useProviderStatusesForLocalConfig";

/**
 * Open threads as display tabs, in tab order. `projectId` scopes them to one project
 * (the editor view). Stale ids (deleted threads, discarded drafts) are dropped from the
 * persisted list once the thread snapshot has hydrated.
 */
export function useOpenThreadTabs(input: {
  activeThreadId: ThreadId | null;
  projectId?: ProjectId | null | undefined;
}): OpenThreadTab[] {
  const { activeThreadId } = input;
  const { settings } = useAppSettings();
  const providerInstances = getProviderInstanceOptions(settings);
  const threadIds = useOpenThreadTabsStore((state) => state.threadIds);
  const pruneThreadTabs = useOpenThreadTabsStore((state) => state.pruneThreadTabs);
  const threadsHydrated = useStore((state) => state.threadsHydrated);
  const activeComposerSendThreadIds = useSyncExternalStore(
    subscribeComposerSends,
    getActiveComposerSendThreadIds,
    getActiveComposerSendThreadIds,
  );
  // Per-id slices compared element-wise, so unrelated thread or composer churn (streaming,
  // typing) does not re-render the strip.
  const summaries = useStore(
    useShallow((state) => threadIds.map((threadId) => state.sidebarThreadSummaryById[threadId])),
  );
  // Subagent tabs name their agent from the parent's activity log, like the sidebar row.
  // Activity arrays are cached per thread, so this only changes when a parent logs one
  // (not on every streamed token, as the parent's whole Thread would).
  const parentActivities = useStore(
    useShallow((state) =>
      threadIds.map((threadId) => {
        const parentThreadId = state.sidebarThreadSummaryById[threadId]?.parentThreadId;
        return parentThreadId ? selectThreadActivities(state, parentThreadId) : undefined;
      }),
    ),
  );
  const drafts = useComposerDraftStore(
    useShallow((state) => threadIds.map((threadId) => state.draftThreadsByThreadId[threadId])),
  );
  const draftExplicitProviders = useComposerDraftStore(
    useShallow((state) =>
      threadIds.map((threadId) => {
        const composerState = state.draftsByThreadId[threadId];
        const instanceId = composerState?.activeProvider;
        return instanceId
          ? (composerState?.modelSelectionByProvider[instanceId]?.provider ??
              providerInstances.find((instance) => instance.instanceId === instanceId)?.provider ??
              null)
          : null;
      }),
    ),
  );
  const terminalEntryPoints = useTerminalStateStore(
    useShallow((state) =>
      threadIds.map(
        (threadId) =>
          selectThreadTerminalState(state.terminalStateByThreadId, threadId).entryPoint ===
          "terminal",
      ),
    ),
  );
  const projects = useStore((state) => state.projects);
  const queryClient = useQueryClient();
  const providerStatuses = useProviderStatusesForLocalConfig();
  const providerStatusesReconciled = hasReconciledServerProviderStatuses(queryClient);

  // Once per mount after hydration: pruning on every thread change would also drop tabs
  // for threads that only disappear transiently (a draft promoting to a server thread).
  // Between prunes, tab derivation already hides ids that cannot keep a tab.
  const didPruneRef = useRef(false);
  useEffect(() => {
    if (!threadsHydrated || didPruneRef.current) return;
    didPruneRef.current = true;
    const { draftThreadsByThreadId } = useComposerDraftStore.getState();
    const { sidebarThreadSummaryById } = useStore.getState();
    pruneThreadTabs(
      (threadId) =>
        threadId === activeThreadId ||
        canKeepOpenThreadTab(
          sidebarThreadSummaryById[threadId],
          draftThreadsByThreadId[threadId] !== undefined,
        ),
    );
  }, [activeThreadId, pruneThreadTabs, threadsHydrated]);

  const sources = threadIds.map((threadId, index): OpenThreadTabSource => {
    const draft = drafts[index];
    const summary = summaries[index];
    const activities = parentActivities[index];
    const project = draft ? projects.find((candidate) => candidate.id === draft.projectId) : null;
    return {
      threadId,
      summary,
      parentThread:
        summary?.parentThreadId && activities
          ? { id: summary.parentThreadId, activities }
          : undefined,
      draft: draft
        ? {
            projectId: draft.projectId,
            entryPoint: draft.entryPoint,
            // Same rule the draft's composer uses to pick its provider.
            provider: resolveUnsentComposerProvider({
              explicitProvider: draftExplicitProviders[index] ?? null,
              threadProvider: resolveDraftFallbackModelSelection({
                projectDefault: project?.defaultModelSelection,
                settingsDefaultProvider: settings.defaultProvider,
              }).provider,
              defaultProvider: settings.defaultProvider,
              statuses: providerStatusesReconciled ? providerStatuses : [],
              providerOrder: settings.providerOrder,
              hiddenProviders: settings.hiddenProviders,
            }),
          }
        : undefined,
      terminalEntryPoint: terminalEntryPoints[index] ?? false,
      isPreparingWorktree:
        activeComposerSendThreadIds.has(threadId) &&
        summary?.envMode === "worktree" &&
        summary.latestTurn === null &&
        summary.session === null,
    };
  });

  return buildOpenThreadTabs({ sources, activeThreadId, projectId: input.projectId });
}

/**
 * Marks the thread a chat surface is showing as open. A layout effect so a newly opened
 * thread's tab paints in the same frame as the thread itself.
 */
export function useRecordOpenThreadTab(threadId: ThreadId | null): void {
  const openThreadTab = useOpenThreadTabsStore((state) => state.openThreadTab);
  useLayoutEffect(() => {
    if (threadId) {
      openThreadTab(threadId);
    }
  }, [openThreadTab, threadId]);
}

/**
 * Switches to an open thread as a single chat, keeping its chat-vs-terminal page like
 * the sidebar and Ctrl+Tab switcher. A tab never lands in a split: splits have one
 * header per pane, so there is no strip to keep showing.
 */
export function useActivateThreadTab(): (threadId: ThreadId) => Promise<void> {
  const navigate = useNavigate();
  const { prewarmThreadDetail } = useThreadDetailPrewarm();
  const openChatThreadPage = useTerminalStateStore((state) => state.openChatThreadPage);
  const openTerminalThreadPage = useTerminalStateStore((state) => state.openTerminalThreadPage);

  return (threadId) => {
    prewarmThreadDetail(threadId);
    const { entryPoint } = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      threadId,
    );
    if (entryPoint === "terminal") {
      openTerminalThreadPage(threadId);
    } else {
      openChatThreadPage(threadId);
    }
    return navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => ({ ...stripDiffSearchParams(previous), splitViewId: undefined }),
    });
  };
}

/**
 * Reads the thread the route shows right now, for code that runs after a navigation
 * settles (render-time props still hold the thread from before it).
 */
export function useReadRouteThreadId(): () => ThreadId | null {
  const router = useRouter();
  return () => {
    for (const match of router.state.matches) {
      const threadId = (match.params as { threadId?: unknown }).threadId;
      if (typeof threadId === "string") {
        return threadId as ThreadId;
      }
    }
    return null;
  };
}
