// FILE: Sidebar.logic.ts
// Purpose: Shared sidebar sorting and status helpers used by the thread list UI.
// Exports: Sidebar row state derivation, add-project error helpers, sort utilities, and visibility helpers.

import type { KeybindingCommand } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "../appSettings";
import type { ChatMessage, Project, SidebarThreadSummary, Thread } from "../types";
import { cn } from "../lib/utils";
import { workspaceRootsEqual } from "@t3tools/shared/threadWorkspace";
import {
  hasLiveLatestTurn,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  isLatestTurnSettled,
} from "../session-logic";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const SIDEBAR_THREAD_PREWARM_LIMIT = 10;
export type SidebarNewThreadEnvMode = "local" | "worktree";
type SidebarProject = {
  id: string;
  name: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};
type SidebarThreadSortInput = {
  createdAt: string;
  updatedAt?: string | undefined;
  latestUserMessageAt?: string | null | undefined;
  messages?: ReadonlyArray<Pick<ChatMessage, "role" | "createdAt">> | undefined;
};

const DUPLICATE_PROJECT_CREATE_ERROR_PREFIX =
  "Orchestration command invariant failed (project.create): Project '";
const THREAD_JUMP_COMMANDS = [
  "thread.jump.1",
  "thread.jump.2",
  "thread.jump.3",
  "thread.jump.4",
  "thread.jump.5",
  "thread.jump.6",
  "thread.jump.7",
  "thread.jump.8",
  "thread.jump.9",
] as const satisfies readonly KeybindingCommand[];

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  Working: 3,
  Connecting: 3,
  "Plan Ready": 2,
  Completed: 1,
};

type ThreadStatusInput = Pick<
  Thread,
  "interactionMode" | "latestTurn" | "lastVisitedAt" | "session"
> & {
  proposedPlans?: Thread["proposedPlans"] | undefined;
  hasActionableProposedPlan?: boolean | undefined;
  hasLiveTailWork?: boolean | undefined;
};

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

export function resolveSidebarNewThreadEnvMode(input: {
  requestedEnvMode?: SidebarNewThreadEnvMode;
  defaultEnvMode: SidebarNewThreadEnvMode;
}): SidebarNewThreadEnvMode {
  return input.requestedEnvMode ?? input.defaultEnvMode;
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const baseClassName =
    "h-8 w-full translate-x-0 cursor-pointer justify-start rounded-md pr-9 pl-8 text-left text-[13px] select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-primary/16 text-foreground/90 hover:bg-primary/20 hover:text-foreground dark:bg-primary/22 dark:hover:bg-primary/28",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-primary/12 text-foreground/88 hover:bg-primary/16 hover:text-foreground dark:bg-primary/18 dark:hover:bg-primary/24",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-accent/62 text-foreground/90 hover:bg-accent/72 hover:text-foreground dark:bg-accent/42 dark:hover:bg-accent/56",
    );
  }

  return cn(baseClassName, "text-foreground/78 hover:bg-accent/45 hover:text-foreground");
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
}): ThreadStatusPill | null {
  const { hasPendingApprovals, hasPendingUserInput, thread } = input;

  if (hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (thread.hasLiveTailWork) {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (
    thread.session?.status === "running" &&
    (thread.latestTurn === null || hasLiveLatestTurn(thread.latestTurn, thread.session))
  ) {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (thread.session?.status === "connecting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  const hasPlanReadyPrompt =
    !hasPendingUserInput &&
    !thread.hasLiveTailWork &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    (thread.hasActionableProposedPlan ??
      hasActionableProposedPlan(
        findLatestProposedPlan(thread.proposedPlans ?? [], thread.latestTurn?.turnId ?? null),
      ));
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  if (!thread.hasLiveTailWork && hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export function findWorkspaceRootMatch<T>(
  items: readonly T[],
  targetWorkspaceRoot: string,
  getWorkspaceRoot: (item: T) => string,
): T | undefined {
  return items.find((item) => workspaceRootsEqual(getWorkspaceRoot(item), targetWorkspaceRoot));
}

// Detects duplicate workspace-root failures so the UI can add a human explanation.
export function isDuplicateProjectCreateError(message: string): boolean {
  if (!message.startsWith(DUPLICATE_PROJECT_CREATE_ERROR_PREFIX)) {
    return false;
  }

  const duplicateMarkerIndex = message.indexOf("' already uses workspace root '");
  return duplicateMarkerIndex > DUPLICATE_PROJECT_CREATE_ERROR_PREFIX.length;
}

export function extractDuplicateProjectCreateProjectId(message: string): string | null {
  if (!isDuplicateProjectCreateError(message)) {
    return null;
  }

  const duplicateMarkerIndex = message.indexOf("' already uses workspace root '");
  return message.slice(DUPLICATE_PROJECT_CREATE_ERROR_PREFIX.length, duplicateMarkerIndex) || null;
}

// Translates low-level add-project failures into a short explanation without
// hiding the original error text that developers may need for diagnosis.
export function describeAddProjectError(message: string): string | null {
  if (isDuplicateProjectCreateError(message)) {
    return "This usually means the folder is already linked to an existing project. On Windows, the same folder can arrive with a different path format, so it looks new even when it is not.";
  }

  return null;
}

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
  const orderedRootRowIds: Thread["id"][] = [];
  const seenRootRowIds = new Set<Thread["id"]>();

  for (const entry of entries) {
    if (seenRootRowIds.has(entry.rootRowId)) {
      continue;
    }
    seenRootRowIds.add(entry.rootRowId);
    orderedRootRowIds.push(entry.rootRowId);
  }

  const hasHiddenEntries = orderedRootRowIds.length > previewLimit;
  if (!hasHiddenEntries || isExpanded) {
    return {
      hasHiddenEntries,
      visibleEntries: [...entries],
    };
  }

  const visibleRootRowIds = new Set(orderedRootRowIds.slice(0, previewLimit));
  const activeRootRowId =
    activeEntryId !== undefined
      ? (entries.find((entry) => entry.rowId === activeEntryId)?.rootRowId ?? null)
      : null;

  if (activeRootRowId) {
    visibleRootRowIds.add(activeRootRowId);
  }

  return {
    hasHiddenEntries: true,
    visibleEntries: entries.filter((entry) => visibleRootRowIds.has(entry.rootRowId)),
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

// Only prune persisted pins after the thread snapshot has hydrated.
export function shouldPrunePinnedThreads(input: { threadsHydrated: boolean }): boolean {
  return input.threadsHydrated;
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

// Resolve the next sidebar-visible thread for keyboard cycling with wraparound.
export function getNextVisibleSidebarThreadId(input: {
  visibleThreadIds: readonly Thread["id"][];
  activeThreadId: Thread["id"] | undefined;
  direction: "forward" | "backward";
}): Thread["id"] | null {
  const { activeThreadId, direction, visibleThreadIds } = input;
  if (visibleThreadIds.length === 0) {
    return null;
  }

  if (!activeThreadId) {
    return direction === "forward"
      ? (visibleThreadIds[0] ?? null)
      : (visibleThreadIds.at(-1) ?? null);
  }

  const activeIndex = visibleThreadIds.findIndex((threadId) => threadId === activeThreadId);
  if (activeIndex === -1) {
    return direction === "forward"
      ? (visibleThreadIds[0] ?? null)
      : (visibleThreadIds.at(-1) ?? null);
  }

  const nextIndex =
    direction === "forward"
      ? (activeIndex + 1) % visibleThreadIds.length
      : (activeIndex - 1 + visibleThreadIds.length) % visibleThreadIds.length;

  return visibleThreadIds[nextIndex] ?? null;
}

export function getSidebarThreadIdForJumpCommand(input: {
  visibleThreadIds: readonly Thread["id"][];
  command: string | null;
}): Thread["id"] | null {
  if (!input.command) {
    return null;
  }

  const jumpIndex = THREAD_JUMP_COMMANDS.indexOf(
    input.command as (typeof THREAD_JUMP_COMMANDS)[number],
  );
  if (jumpIndex === -1) {
    return null;
  }

  return input.visibleThreadIds[jumpIndex] ?? null;
}

export function getSidebarThreadIdsToPrewarm(input: {
  visibleThreadIds: readonly Thread["id"][];
  limit?: number;
}): Thread["id"][] {
  const limit = Math.max(0, input.limit ?? SIDEBAR_THREAD_PREWARM_LIMIT);
  return input.visibleThreadIds.slice(0, limit);
}

function toSortableTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function getLatestUserMessageTimestamp(thread: SidebarThreadSortInput): number {
  const latestUserMessageAt = toSortableTimestamp(thread.latestUserMessageAt ?? undefined);
  if (latestUserMessageAt !== null) {
    return latestUserMessageAt;
  }

  let latestUserMessageTimestamp: number | null = null;

  for (const message of thread.messages ?? []) {
    if (message.role !== "user") continue;
    const messageTimestamp = toSortableTimestamp(message.createdAt);
    if (messageTimestamp === null) continue;
    latestUserMessageTimestamp =
      latestUserMessageTimestamp === null
        ? messageTimestamp
        : Math.max(latestUserMessageTimestamp, messageTimestamp);
  }

  if (latestUserMessageTimestamp !== null) {
    return latestUserMessageTimestamp;
  }

  return toSortableTimestamp(thread.updatedAt ?? thread.createdAt) ?? Number.NEGATIVE_INFINITY;
}

function getThreadSortTimestamp(
  thread: SidebarThreadSortInput,
  sortOrder: SidebarThreadSortOrder | Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (sortOrder === "created_at") {
    return toSortableTimestamp(thread.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return getLatestUserMessageTimestamp(thread);
}

export function sortThreadsForSidebar<T extends { id: Thread["id"] } & SidebarThreadSortInput>(
  threads: readonly T[],
  sortOrder: SidebarThreadSortOrder,
): T[] {
  return threads.toSorted((left, right) => {
    const rightTimestamp = getThreadSortTimestamp(right, sortOrder);
    const leftTimestamp = getThreadSortTimestamp(left, sortOrder);
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) return byTimestamp;
    return right.id.localeCompare(left.id);
  });
}

export function getFallbackThreadIdAfterDelete<
  T extends { id: Thread["id"]; projectId: Thread["projectId"] } & SidebarThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreadsForSidebar(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}

export function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly SidebarThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends { projectId: Thread["projectId"] } & SidebarThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return [...projects].toSorted((left, right) => {
    const rightTimestamp = getProjectSortTimestamp(
      right,
      threadsByProjectId.get(right.id) ?? [],
      sortOrder,
    );
    const leftTimestamp = getProjectSortTimestamp(
      left,
      threadsByProjectId.get(left.id) ?? [],
      sortOrder,
    );
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) return byTimestamp;
    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
}
