// FILE: Sidebar.logic.tree.ts
// Purpose: Project/thread tree construction, preview-window visibility, and per-project row derivation.
// Layer: Sidebar logic (pure).
// Exports: tree/entry types, buildProjectThreadTree, visibility helpers, groupSidebarThreadsByProjectId, deriveSidebarProjectData.

import type { ProjectId, ThreadId } from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "../appSettings";
import type { Project, SidebarThreadSummary, Thread } from "../types";
import { sortThreadsForSidebar, type SidebarThreadSortInput } from "./Sidebar.logic.sorting";
import { resolveProjectStatusIndicator, resolveThreadStatusPill } from "./Sidebar.logic.status";

export type SidebarProjectEntry = {
  kind: "thread";
  rowId: ThreadId;
  rootRowId: ThreadId;
  thread: SidebarThreadSummary;
  depth: number;
  childCount: number;
  isExpanded: boolean;
};

export type SidebarDerivedProjectData = {
  allProjectThreadCount: number;
  projectThreads: SidebarThreadSummary[];
  orderedProjectThreadIds: ThreadId[];
  visibleEntries: SidebarProjectEntry[];
  hasHiddenThreads: boolean;
  isThreadListExpanded: boolean;
  activeEntryId: ThreadId | null;
  projectStatus: ReturnType<typeof resolveProjectStatusIndicator>;
};

export function getVisibleThreadsForProject<T extends Pick<SidebarThreadSummary, "id">>(input: {
  threads: readonly T[];
  activeThreadId: Thread["id"] | undefined;
  isThreadListExpanded: boolean;
  previewLimit: number;
}): {
  hasHiddenThreads: boolean;
  visibleThreads: T[];
} {
  const { activeThreadId, isThreadListExpanded, previewLimit, threads } = input;
  const hasHiddenThreads = threads.length > previewLimit;

  if (!hasHiddenThreads || isThreadListExpanded) {
    return {
      hasHiddenThreads,
      visibleThreads: [...threads],
    };
  }

  const previewThreads = threads.slice(0, previewLimit);
  if (!activeThreadId || previewThreads.some((thread) => thread.id === activeThreadId)) {
    return {
      hasHiddenThreads: true,
      visibleThreads: previewThreads,
    };
  }

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  if (!activeThread) {
    return {
      hasHiddenThreads: true,
      visibleThreads: previewThreads,
    };
  }

  const visibleThreadIds = new Set([...previewThreads, activeThread].map((thread) => thread.id));

  return {
    hasHiddenThreads: true,
    visibleThreads: threads.filter((thread) => visibleThreadIds.has(thread.id)),
  };
}

export interface SidebarThreadTreeRow<
  T extends Pick<SidebarThreadSummary, "id" | "parentThreadId">,
> {
  thread: T;
  depth: number;
  rootThreadId: T["id"];
  childCount: number;
  isExpanded: boolean;
}

function collectForcedExpandedParentIds<
  T extends Pick<SidebarThreadSummary, "id" | "parentThreadId">,
>(threadById: Map<T["id"], T>, forceVisibleThreadId: T["id"] | undefined): Set<T["id"]> {
  const forcedParentIds = new Set<T["id"]>();
  let currentThreadId = forceVisibleThreadId;

  while (currentThreadId) {
    const parentThreadId = threadById.get(currentThreadId)?.parentThreadId ?? undefined;
    if (!parentThreadId) {
      break;
    }
    forcedParentIds.add(parentThreadId);
    currentThreadId = parentThreadId;
  }

  return forcedParentIds;
}

// Build the project-local parent/child thread tree while preserving sort order from the input list.
export function buildProjectThreadTree<
  T extends Pick<SidebarThreadSummary, "id" | "parentThreadId">,
>(input: {
  threads: readonly T[];
  expandedParentThreadIds?: ReadonlySet<T["id"]> | undefined;
  forceVisibleThreadId?: T["id"] | undefined;
}): SidebarThreadTreeRow<T>[] {
  const { expandedParentThreadIds, forceVisibleThreadId, threads } = input;
  const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
  const childrenByParentId = new Map<T["id"], T[]>();
  const roots: T[] = [];

  for (const thread of threads) {
    const parentThreadId = thread.parentThreadId ?? null;
    if (!parentThreadId || !threadById.has(parentThreadId)) {
      roots.push(thread);
      continue;
    }
    const siblings = childrenByParentId.get(parentThreadId) ?? [];
    siblings.push(thread);
    childrenByParentId.set(parentThreadId, siblings);
  }

  const forcedExpandedParentIds = collectForcedExpandedParentIds(threadById, forceVisibleThreadId);
  const orderedRows: SidebarThreadTreeRow<T>[] = [];

  const visit = (thread: T, depth: number, rootThreadId: T["id"]) => {
    const childThreads = childrenByParentId.get(thread.id) ?? [];
    const isExpanded =
      childThreads.length > 0 &&
      (expandedParentThreadIds?.has(thread.id) === true || forcedExpandedParentIds.has(thread.id));

    orderedRows.push({
      thread,
      depth,
      rootThreadId,
      childCount: childThreads.length,
      isExpanded,
    });

    if (!isExpanded) {
      return;
    }

    for (const child of childThreads) {
      visit(child, depth + 1, rootThreadId);
    }
  };

  for (const root of roots) {
    visit(root, 0, root.id);
  }

  return orderedRows;
}

export function getVisibleSidebarEntriesForPreview<
  T extends {
    rowId: Thread["id"];
    rootRowId: Thread["id"];
  },
>(input: {
  entries: readonly T[];
  activeEntryId: Thread["id"] | undefined;
  isExpanded: boolean;
  previewLimit: number;
}): {
  hasHiddenEntries: boolean;
  visibleEntries: T[];
} {
  const { activeEntryId, entries, isExpanded, previewLimit } = input;
  const hasHiddenEntries = entries.length > previewLimit;
  if (!hasHiddenEntries || isExpanded) {
    return {
      hasHiddenEntries,
      visibleEntries: [...entries],
    };
  }

  const previewEntries = entries.slice(0, previewLimit);
  const activeRootRowId =
    activeEntryId !== undefined
      ? (entries.find((entry) => entry.rowId === activeEntryId)?.rootRowId ?? null)
      : null;

  if (
    !activeRootRowId ||
    previewEntries.some(
      (entry) => entry.rowId === activeEntryId || entry.rootRowId === activeRootRowId,
    )
  ) {
    return {
      hasHiddenEntries: true,
      visibleEntries: previewEntries,
    };
  }

  const visibleRowIds = new Set(previewEntries.map((entry) => entry.rowId));
  return {
    hasHiddenEntries: true,
    visibleEntries: entries.filter(
      (entry) => visibleRowIds.has(entry.rowId) || entry.rootRowId === activeRootRowId,
    ),
  };
}

// Preserve the persisted pin order while discarding ids that no longer exist locally.
export function getPinnedThreadsForSidebar<T extends Pick<Thread, "id">>(
  threads: readonly T[],
  pinnedThreadIds: readonly T["id"][],
): T[] {
  const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));
  const seen = new Set<T["id"]>();
  const pinnedThreads: T[] = [];

  for (const threadId of pinnedThreadIds) {
    if (seen.has(threadId)) continue;
    seen.add(threadId);
    const thread = threadById.get(threadId);
    if (thread) {
      pinnedThreads.push(thread);
    }
  }

  return pinnedThreads;
}

// Hide globally pinned rows from the per-project lists so the sidebar doesn't duplicate chats.
export function getUnpinnedThreadsForSidebar<T extends Pick<Thread, "id">>(
  threads: readonly T[],
  pinnedThreadIds: readonly T["id"][],
): T[] {
  if (pinnedThreadIds.length === 0) {
    return [...threads];
  }

  const pinnedThreadIdSet = new Set(pinnedThreadIds);
  return threads.filter((thread) => !pinnedThreadIdSet.has(thread.id));
}

// Match the exact rows the sidebar renders for one project, including folded previews.
export function getRenderedThreadsForSidebarProject<
  T extends Pick<SidebarThreadSummary, "id"> & SidebarThreadSortInput,
>(input: {
  project: Pick<Project, "expanded">;
  threads: readonly T[];
  activeThreadId: Thread["id"] | undefined;
  isThreadListExpanded: boolean;
  previewLimit: number;
}): {
  hasHiddenThreads: boolean;
  renderedThreads: T[];
} {
  const { activeThreadId, isThreadListExpanded, previewLimit, project, threads } = input;
  const pinnedCollapsedThread =
    !project.expanded && activeThreadId
      ? (threads.find((thread) => thread.id === activeThreadId) ?? null)
      : null;
  const { hasHiddenThreads, visibleThreads } = getVisibleThreadsForProject({
    threads,
    activeThreadId,
    isThreadListExpanded,
    previewLimit,
  });

  return {
    hasHiddenThreads,
    renderedThreads: pinnedCollapsedThread ? [pinnedCollapsedThread] : visibleThreads,
  };
}

// Flatten the sidebar's current project/thread visibility into the same order the user sees.
export function getVisibleSidebarThreadIds(input: {
  projects: readonly Pick<Project, "id" | "expanded">[];
  threads: readonly (Pick<SidebarThreadSummary, "id" | "projectId" | "parentThreadId"> &
    SidebarThreadSortInput)[];
  activeThreadId: Thread["id"] | undefined;
  expandedThreadListsByProject: ReadonlySet<Project["id"]>;
  expandedSubagentParentIds?: ReadonlySet<Thread["id"]>;
  previewLimit: number;
  threadSortOrder: SidebarThreadSortOrder;
}): Thread["id"][] {
  const {
    activeThreadId,
    expandedSubagentParentIds,
    expandedThreadListsByProject,
    previewLimit,
    projects,
    threadSortOrder,
    threads,
  } = input;
  const visibleThreadIds: Thread["id"][] = [];

  for (const project of projects) {
    const projectThreads = sortThreadsForSidebar(
      threads.filter((thread) => thread.projectId === project.id),
      threadSortOrder,
    );
    const projectThreadTree = buildProjectThreadTree({
      threads: projectThreads,
      expandedParentThreadIds: expandedSubagentParentIds,
    });
    const { visibleEntries } = getVisibleSidebarEntriesForPreview({
      entries: projectThreadTree.map((row) => ({
        rowId: row.thread.id,
        rootRowId: row.rootThreadId,
        threadId: row.thread.id,
      })),
      activeEntryId: activeThreadId,
      isExpanded: expandedThreadListsByProject.has(project.id),
      previewLimit,
    });
    const pinnedCollapsedThread =
      !project.expanded && activeThreadId
        ? (projectThreads.find((thread) => thread.id === activeThreadId) ?? null)
        : null;

    if (pinnedCollapsedThread) {
      visibleThreadIds.push(pinnedCollapsedThread.id);
      continue;
    }

    for (const entry of visibleEntries) {
      visibleThreadIds.push(entry.threadId);
    }
  }

  return visibleThreadIds;
}

// Groups thread summaries once so project-specific sidebar derivations can reuse the same slices.
export function groupSidebarThreadsByProjectId(
  threads: readonly SidebarThreadSummary[],
): ReadonlyMap<ProjectId, SidebarThreadSummary[]> {
  const byProjectId = new Map<ProjectId, SidebarThreadSummary[]>();
  for (const thread of threads) {
    const existing = byProjectId.get(thread.projectId);
    if (existing) {
      existing.push(thread);
    } else {
      byProjectId.set(thread.projectId, [thread]);
    }
  }
  return byProjectId;
}

// Centralizes the expensive per-project row derivation so Sidebar.tsx can mostly orchestrate UI state.
export function deriveSidebarProjectData(input: {
  projects: readonly Pick<Project, "id" | "cwd" | "expanded">[];
  sortedSidebarThreadsByProjectId: ReadonlyMap<ProjectId, SidebarThreadSummary[]>;
  pinnedThreadIds: readonly ThreadId[];
  expandedParentThreadIds: ReadonlySet<ThreadId>;
  expandedThreadListProjectCwds: ReadonlySet<string>;
  normalizeProjectCwd: (cwd: string) => string;
  activeSidebarThreadId: ThreadId | undefined;
  previewLimit: number;
  resolveThreadStatus?: (
    thread: SidebarThreadSummary,
  ) => ReturnType<typeof resolveThreadStatusPill>;
}): ReadonlyMap<ProjectId, SidebarDerivedProjectData> {
  const byProjectId = new Map<ProjectId, SidebarDerivedProjectData>();

  for (const project of input.projects) {
    const allProjectThreads = input.sortedSidebarThreadsByProjectId.get(project.id) ?? [];
    const projectThreads = getUnpinnedThreadsForSidebar(allProjectThreads, input.pinnedThreadIds);
    const projectStatus = resolveProjectStatusIndicator(
      allProjectThreads.map((thread) =>
        input.resolveThreadStatus
          ? input.resolveThreadStatus(thread)
          : resolveThreadStatusPill({
              thread,
              hasPendingApprovals: thread.hasPendingApprovals,
              hasPendingUserInput: thread.hasPendingUserInput,
            }),
      ),
    );
    const isThreadListExpanded = input.expandedThreadListProjectCwds.has(
      input.normalizeProjectCwd(project.cwd),
    );
    const orderedProjectThreadIds = projectThreads.map((thread) => thread.id);

    // Collapsed folders should not build or render their full tree; large projects can
    // contain hundreds of rows and folder toggles are on the sidebar hot path.
    if (!project.expanded) {
      const activeThread =
        input.activeSidebarThreadId === undefined
          ? null
          : (projectThreads.find((thread) => thread.id === input.activeSidebarThreadId) ?? null);
      const childCount =
        activeThread === null
          ? 0
          : projectThreads.filter((thread) => thread.parentThreadId === activeThread.id).length;
      const visibleEntries =
        activeThread === null
          ? []
          : [
              {
                kind: "thread" as const,
                rowId: activeThread.id,
                rootRowId: activeThread.id,
                thread: activeThread,
                depth: 0,
                childCount,
                isExpanded: false,
              },
            ];

      byProjectId.set(project.id, {
        allProjectThreadCount: allProjectThreads.length,
        projectThreads,
        orderedProjectThreadIds,
        visibleEntries,
        hasHiddenThreads: projectThreads.length > visibleEntries.length,
        isThreadListExpanded,
        activeEntryId: activeThread?.id ?? null,
        projectStatus,
      });
      continue;
    }

    const projectThreadTree = buildProjectThreadTree({
      threads: projectThreads,
      expandedParentThreadIds: input.expandedParentThreadIds,
    });
    const orderedEntries: SidebarProjectEntry[] = projectThreadTree.map(
      ({ thread, depth, rootThreadId, childCount, isExpanded }) => ({
        kind: "thread",
        rowId: thread.id,
        rootRowId: rootThreadId,
        thread,
        depth,
        childCount,
        isExpanded,
      }),
    );

    const activeEntry =
      input.activeSidebarThreadId === undefined
        ? null
        : (orderedEntries.find((entry) => entry.rowId === input.activeSidebarThreadId) ?? null);
    const { visibleEntries: renderedEntries } = getVisibleSidebarEntriesForPreview({
      entries: orderedEntries,
      activeEntryId: activeEntry?.rowId,
      isExpanded: isThreadListExpanded,
      previewLimit: input.previewLimit,
    });

    byProjectId.set(project.id, {
      allProjectThreadCount: allProjectThreads.length,
      projectThreads,
      orderedProjectThreadIds,
      visibleEntries: renderedEntries,
      hasHiddenThreads: renderedEntries.length < orderedEntries.length,
      isThreadListExpanded,
      activeEntryId: activeEntry?.rowId ?? null,
      projectStatus,
    });
  }

  return byProjectId;
}
