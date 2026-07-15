// FILE: useKanbanBoard.ts
// Purpose: Subscribes to app/composer/kanban stores and derives the memoized kanban board.
// Layer: UI state hook (projection only — board math lives in kanban.logic.ts)
// Exports: useKanbanBoard

import type { ProjectId, ThreadId } from "@synara/contracts";
import { useEffect, useMemo, useRef } from "react";

import { useAppSettings } from "~/appSettings";
import { toastManager } from "~/components/ui/toast";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useKanbanUiStore } from "../../kanbanUiStore";
import { isHomeChatContainerProject } from "../../lib/chatProjects";
import { isStudioContainerProject } from "../../lib/studioProjects";
import { useStore } from "../../store";
import { createSidebarDisplayThreadsSelector } from "../../storeSelectors";
import { useTerminalStateStore } from "../../terminalStateStore";
import { useWorkspaceStore } from "../../workspaceStore";
import { sortProjectsForSidebar } from "../Sidebar.logic";
import {
  areKanbanComposerDraftSnapshotsEqual,
  buildKanbanBoard,
  buildKanbanComposerDraftSnapshot,
  deriveKanbanColumn,
  resolveOptimisticDispatchOutcome,
  type KanbanBoard,
  type KanbanComposerDraftSnapshot,
  type KanbanDraftThreadSnapshot,
} from "./kanban.logic";

// An optimistic dispatch that never produces a runtime signal (provider died
// silently, server unreachable mid-flight) reverts to Draft after this window.
// Generous on purpose: slow provider session init (e.g. Cursor) is the normal case.
const OPTIMISTIC_DISPATCH_TIMEOUT_MS = 30_000;
const OPTIMISTIC_DISPATCH_EXPIRY_CHECK_MS = 5_000;

export function useKanbanBoard(): KanbanBoard {
  const selectDisplayThreads = useMemo(() => createSidebarDisplayThreadsSelector(), []);
  const threads = useStore(selectDisplayThreads);
  const allProjects = useStore((state) => state.projects);
  const threadsHydrated = useStore((state) => state.threadsHydrated);
  const homeDir = useWorkspaceStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspaceStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspaceStore((state) => state.studioWorkspaceRoot);
  const { settings } = useAppSettings();
  const projectSortOrder = settings.sidebarProjectSortOrder;

  // Mirror the sidebar's grouping: projects in the user's sidebar sort order, then one
  // "Chats" board for the hidden home chat container. Stale duplicate containers (cleaned
  // up lazily by chatProjects fixup) are aliased into the canonical one — mirroring
  // findCanonicalHomeProject — so they never surface as extra empty boards.
  const { projects, projectIdAliases } = useMemo(() => {
    const chatContainers = allProjects.filter((project) =>
      isHomeChatContainerProject(project, { homeDir, chatWorkspaceRoot }),
    );
    const otherProjects = allProjects.filter(
      (project) =>
        !isHomeChatContainerProject(project, { homeDir, chatWorkspaceRoot }) &&
        !isStudioContainerProject(project, { homeDir, chatWorkspaceRoot, studioWorkspaceRoot }),
    );
    const canonicalContainer =
      chatContainers.find((project) => project.kind === "chat") ?? chatContainers[0] ?? null;
    const aliases: Record<string, ProjectId> = {};
    for (const container of chatContainers) {
      if (canonicalContainer && container.id !== canonicalContainer.id) {
        aliases[container.id] = canonicalContainer.id;
      }
    }
    return {
      projects: [
        ...sortProjectsForSidebar(otherProjects, threads, projectSortOrder),
        ...(canonicalContainer
          ? [{ id: canonicalContainer.id, kind: canonicalContainer.kind, name: "Chats" }]
          : []),
      ],
      projectIdAliases: aliases,
    };
  }, [allProjects, chatWorkspaceRoot, homeDir, projectSortOrder, studioWorkspaceRoot, threads]);
  const draftsByThreadId = useComposerDraftStore((state) => state.draftsByThreadId);
  const draftThreadsByThreadId = useComposerDraftStore((state) => state.draftThreadsByThreadId);
  const draftOrderByProjectId = useKanbanUiStore((state) => state.draftOrderByProjectId);
  const optimisticDispatchByThreadId = useKanbanUiStore(
    (state) => state.optimisticDispatchByThreadId,
  );
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);

  // Terminal-first threads are terminals, not provider chats — same rule as the
  // sidebar, which swaps the provider avatar for the terminal glyph.
  const terminalEntryThreadIds = useMemo(() => {
    const result = new Set<string>();
    for (const [threadId, terminalState] of Object.entries(terminalStateByThreadId)) {
      if (terminalState.entryPoint === "terminal") {
        result.add(threadId);
      }
    }
    return result;
  }, [terminalStateByThreadId]);

  // Drop persisted manual draft orders for projects that no longer exist, so the
  // localStorage payload doesn't grow forever as projects come and go.
  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }
    const knownProjectIds = new Set<string>(allProjects.map((project) => project.id));
    const kanbanUi = useKanbanUiStore.getState();
    for (const projectId of Object.keys(kanbanUi.draftOrderByProjectId)) {
      if (!knownProjectIds.has(projectId)) {
        kanbanUi.clearDraftOrder(projectId);
      }
    }
  }, [allProjects, threadsHydrated]);

  // Settle optimistic dispatches once runtime state catches up: from then on the
  // derived column owns the card and the overlay must stop overriding it. A
  // provider failure (session error after the drop, no turn) reverts immediately
  // with the real error instead of waiting for the expiry safety net.
  useEffect(() => {
    const entries = Object.entries(optimisticDispatchByThreadId);
    if (entries.length === 0) {
      return;
    }
    const kanbanUi = useKanbanUiStore.getState();
    for (const [threadId, entry] of entries) {
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (!thread) {
        continue;
      }
      const outcome = resolveOptimisticDispatchOutcome(entry, thread);
      if (outcome === "pending") {
        continue;
      }
      kanbanUi.clearOptimisticDispatch(threadId);
      if (outcome === "failed") {
        toastManager.add({
          type: "error",
          title: "Task didn't start",
          description: thread.session?.lastError ?? `${entry.title} was moved back to Draft.`,
        });
      }
    }
  }, [optimisticDispatchByThreadId, threads]);

  // Safety net: a dispatch whose runtime signal never arrives reverts to Draft
  // instead of leaving a ghost card In Progress forever. Keyed on a boolean so
  // new entries don't reset the interval and stretch older entries' deadlines;
  // the interval reads the live thread list through a ref (assigned post-commit
  // so a discarded concurrent render can never leak into it).
  const threadsRef = useRef(threads);
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);
  const hasOptimisticDispatches = Object.keys(optimisticDispatchByThreadId).length > 0;
  useEffect(() => {
    if (!hasOptimisticDispatches) {
      return;
    }
    const intervalId = window.setInterval(() => {
      const expired = useKanbanUiStore
        .getState()
        .expireOptimisticDispatches(Date.now() - OPTIMISTIC_DISPATCH_TIMEOUT_MS);
      for (const [threadId, entry] of expired) {
        // Entries that outlive the window while the session is still connecting
        // (slow provider) just stop watching for failure — the card is already
        // In Progress from derived state, so a revert toast would be a lie.
        const thread = threadsRef.current.find((candidate) => candidate.id === threadId);
        if (thread && deriveKanbanColumn(thread) === "inProgress") {
          continue;
        }
        toastManager.add({
          type: "error",
          title: "Task didn't start",
          description: `${entry.title} was moved back to Draft.`,
        });
      }
    }, OPTIMISTIC_DISPATCH_EXPIRY_CHECK_MS);
    return () => window.clearInterval(intervalId);
  }, [hasOptimisticDispatches]);

  // Project composer drafts down to the few fields the board needs. Empty drafts
  // are dropped so routine composer churn (focus, selections, modes) rarely
  // changes the content — and the identity cache below keeps the same object
  // when it doesn't, sparing the downstream board rebuild entirely. The cache
  // ref is written during render on purpose: it is a pure memo cache, so a
  // discarded concurrent render at worst stores a value-equal object.
  const composerDraftCacheRef = useRef<Record<string, KanbanComposerDraftSnapshot>>({});
  const composerDraftByThreadId = useMemo(() => {
    const result: Record<string, KanbanComposerDraftSnapshot> = {};
    for (const [threadId, draft] of Object.entries(draftsByThreadId)) {
      const snapshot = buildKanbanComposerDraftSnapshot(draft);
      if (snapshot && (snapshot.prompt.trim().length > 0 || snapshot.hasAttachments)) {
        result[threadId] = snapshot;
      }
    }
    if (areKanbanComposerDraftSnapshotsEqual(composerDraftCacheRef.current, result)) {
      return composerDraftCacheRef.current;
    }
    composerDraftCacheRef.current = result;
    return result;
  }, [draftsByThreadId]);

  const draftThreads = useMemo(() => {
    const result: KanbanDraftThreadSnapshot[] = [];
    for (const [threadId, draftThread] of Object.entries(draftThreadsByThreadId)) {
      // Promoted drafts already surface through their durable thread; temporary and
      // terminal-first drafts have no chat prompt to track on the board.
      if (draftThread.promotedTo || draftThread.isTemporary || draftThread.entryPoint !== "chat") {
        continue;
      }
      result.push({
        threadId: threadId as ThreadId,
        projectId: draftThread.projectId,
        createdAt: draftThread.createdAt,
        branch: draftThread.branch,
        envMode: draftThread.envMode,
        worktreePath: draftThread.worktreePath,
      });
    }
    return result;
  }, [draftThreadsByThreadId]);

  return useMemo(
    () =>
      buildKanbanBoard({
        projects,
        threads,
        draftThreads,
        composerDraftByThreadId,
        draftOrderByProjectId,
        projectIdAliases,
        terminalEntryThreadIds,
        optimisticDispatchByThreadId,
      }),
    [
      projects,
      threads,
      draftThreads,
      composerDraftByThreadId,
      draftOrderByProjectId,
      projectIdAliases,
      terminalEntryThreadIds,
      optimisticDispatchByThreadId,
    ],
  );
}
