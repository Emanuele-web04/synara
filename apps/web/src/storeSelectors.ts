import type { ProjectId, ThreadEnvironmentMode, ThreadId } from "@synara/contracts";
import { isAutomationRunThread } from "@synara/shared/automationMode";
import { isSidechatThread, sidechatContextMatchesGitHubItem } from "@synara/shared/sidechatThread";
import { collectSubagentDescendants } from "@synara/shared/threadHierarchy";

import type { AppState } from "./storeState";
import { ACCOUNT_RATE_LIMIT_ACTIVITY_KINDS } from "./lib/rateLimits";
import { resolveThreadDisplayProvider } from "./lib/threadDisplayProvider";
import { collectByIds, getThreadFromState, getThreadsFromState } from "./threadDerivation";
import type {
  ComposerThreadMentionSource,
  Project,
  SidebarThreadSummary,
  Thread,
  ThreadShell,
} from "./types";

const EMPTY_THREAD_SHELLS: ThreadShell[] = [];

export interface ThreadWorkspaceMetadata {
  envMode: ThreadEnvironmentMode | undefined;
  worktreePath: string | null;
  workingDirectory: string | null;
}

const EMPTY_THREAD_WORKSPACE_METADATA: ThreadWorkspaceMetadata = Object.freeze({
  envMode: undefined,
  worktreePath: null,
  workingDirectory: null,
});

function createStableEntitySelector<T extends { id: string }>(
  selectItems: (state: AppState) => readonly T[],
  id: string | null | undefined,
): (state: AppState) => T | undefined {
  let previousItems: readonly T[] | undefined;
  let previousMatch: T | undefined;

  return (state) => {
    if (!id) {
      return undefined;
    }

    const items = selectItems(state);
    if (items === previousItems) {
      return previousMatch;
    }

    previousItems = items;
    previousMatch = items.find((item) => item.id === id);
    return previousMatch;
  };
}

export function createProjectSelector(
  projectId: ProjectId | null | undefined,
): (state: AppState) => Project | undefined {
  return createStableEntitySelector((state) => state.projects, projectId);
}

export function createThreadSelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => Thread | undefined {
  return (state) => (threadId ? getThreadFromState(state, threadId) : undefined);
}

export function createAllThreadsSelector(): (state: AppState) => readonly Thread[] {
  let previousThreadIds: readonly ThreadId[] | undefined;
  let previousThreadShellById = {} as AppState["threadShellById"];
  let previousThreadSessionById = {} as AppState["threadSessionById"];
  let previousThreadTurnStateById = {} as AppState["threadTurnStateById"];
  let previousMessageIdsByThreadId = {} as AppState["messageIdsByThreadId"];
  let previousMessageByThreadId = {} as AppState["messageByThreadId"];
  let previousActivityIdsByThreadId = {} as AppState["activityIdsByThreadId"];
  let previousActivityByThreadId = {} as AppState["activityByThreadId"];
  let previousProposedPlanIdsByThreadId = {} as AppState["proposedPlanIdsByThreadId"];
  let previousProposedPlanByThreadId = {} as AppState["proposedPlanByThreadId"];
  let previousTurnDiffIdsByThreadId = {} as AppState["turnDiffIdsByThreadId"];
  let previousTurnDiffSummaryByThreadId = {} as AppState["turnDiffSummaryByThreadId"];
  let previousThreads: readonly Thread[] = [];

  return (state) => {
    if (
      previousThreadIds === state.threadIds &&
      previousThreadShellById === state.threadShellById &&
      previousThreadSessionById === state.threadSessionById &&
      previousThreadTurnStateById === state.threadTurnStateById &&
      previousMessageIdsByThreadId === state.messageIdsByThreadId &&
      previousMessageByThreadId === state.messageByThreadId &&
      previousActivityIdsByThreadId === state.activityIdsByThreadId &&
      previousActivityByThreadId === state.activityByThreadId &&
      previousProposedPlanIdsByThreadId === state.proposedPlanIdsByThreadId &&
      previousProposedPlanByThreadId === state.proposedPlanByThreadId &&
      previousTurnDiffIdsByThreadId === state.turnDiffIdsByThreadId &&
      previousTurnDiffSummaryByThreadId === state.turnDiffSummaryByThreadId
    ) {
      return previousThreads;
    }

    previousThreadIds = state.threadIds;
    previousThreadShellById = state.threadShellById;
    previousThreadSessionById = state.threadSessionById;
    previousThreadTurnStateById = state.threadTurnStateById;
    previousMessageIdsByThreadId = state.messageIdsByThreadId;
    previousMessageByThreadId = state.messageByThreadId;
    previousActivityIdsByThreadId = state.activityIdsByThreadId;
    previousActivityByThreadId = state.activityByThreadId;
    previousProposedPlanIdsByThreadId = state.proposedPlanIdsByThreadId;
    previousProposedPlanByThreadId = state.proposedPlanByThreadId;
    previousTurnDiffIdsByThreadId = state.turnDiffIdsByThreadId;
    previousTurnDiffSummaryByThreadId = state.turnDiffSummaryByThreadId;
    previousThreads = getThreadsFromState(state);
    return previousThreads;
  };
}

export interface AccountRateLimitThreadActivities {
  readonly activities: Thread["activities"];
}

const EMPTY_RATE_LIMIT_THREADS: readonly AccountRateLimitThreadActivities[] = [];

/** Threads narrowed to just their account rate-limit activities (the only input
 *  `deriveAccountRateLimits` reads). Unlike `createAllThreadsSelector`, this ignores message
 *  slices entirely and returns a reference-stable result while ordinary activities stream in:
 *  the result only changes when a rate-limit activity itself is added, removed, or replaced.
 *  Usage chips subscribe here so a streaming turn does not re-render them per store flush. */
export function createAccountRateLimitThreadsSelector(): (
  state: AppState,
) => readonly AccountRateLimitThreadActivities[] {
  let previousThreadIds: AppState["threadIds"] | undefined;
  let previousActivityIdsByThreadId: AppState["activityIdsByThreadId"] | undefined;
  let previousActivityByThreadId: AppState["activityByThreadId"] | undefined;
  let previousResult: readonly AccountRateLimitThreadActivities[] = EMPTY_RATE_LIMIT_THREADS;

  return (state) => {
    if (
      previousThreadIds === state.threadIds &&
      previousActivityIdsByThreadId === state.activityIdsByThreadId &&
      previousActivityByThreadId === state.activityByThreadId
    ) {
      return previousResult;
    }

    previousThreadIds = state.threadIds;
    previousActivityIdsByThreadId = state.activityIdsByThreadId;
    previousActivityByThreadId = state.activityByThreadId;

    const nextResult: AccountRateLimitThreadActivities[] = [];
    for (const threadId of state.threadIds ?? []) {
      const activityIds = state.activityIdsByThreadId?.[threadId];
      const activityById = state.activityByThreadId?.[threadId];
      if (!activityIds || activityIds.length === 0 || !activityById) {
        continue;
      }
      let matched: Thread["activities"][number][] | undefined;
      for (const activityId of activityIds) {
        const activity = activityById[activityId];
        if (activity && ACCOUNT_RATE_LIMIT_ACTIVITY_KINDS.has(activity.kind)) {
          (matched ??= []).push(activity);
        }
      }
      if (matched) {
        nextResult.push({ activities: matched });
      }
    }

    const unchanged =
      nextResult.length === previousResult.length &&
      nextResult.every((entry, entryIndex) => {
        const previousEntry = previousResult[entryIndex];
        return (
          previousEntry !== undefined &&
          entry.activities.length === previousEntry.activities.length &&
          entry.activities.every(
            (activity, activityIndex) => previousEntry.activities[activityIndex] === activity,
          )
        );
      });
    if (unchanged) {
      return previousResult;
    }

    previousResult = nextResult.length > 0 ? nextResult : EMPTY_RATE_LIMIT_THREADS;
    return previousResult;
  };
}

/** Shell-only projection of all threads, in `threadIds` order.
 *
 *  It reads only `threadIds` + `threadShellById`, so it never rebuilds for message/activity
 *  *content* changes — but it is NOT fully stable while a turn streams: `ThreadShell.updatedAt`
 *  is part of the shell, and `threadShellsEqual` compares it, so every delta that advances
 *  `updatedAt` writes a new shell and yields a new array here. That comparison has to stay:
 *  the shell is where `updatedAt` lives, and the sidebar both sorts by it
 *  (`components/Sidebar.logic.ts`) and renders it (`components/SidebarSearchPalette.tsx`).
 *
 *  So: cheaper and far less churny than `createAllThreadsSelector` (one new array per delta
 *  instead of rebuilding every thread's message/activity lists), but subscribers that must not
 *  re-render during streaming should select a narrower slice (e.g.
 *  `createThreadWorkspaceMetadataSelector`) rather than relying on this being stable. */
export function createThreadShellsSelector(): (state: AppState) => readonly ThreadShell[] {
  return (state) => collectByIds(state.threadIds, state.threadShellById, EMPTY_THREAD_SHELLS);
}

/** True when no known thread has any messages (vacuously true with zero threads).
 *  Reads message id lists only, so streaming content updates do not invalidate it. */
export function createAllThreadsMessagelessSelector(): (state: AppState) => boolean {
  let previousThreadIds: readonly ThreadId[] | undefined;
  let previousMessageIdsByThreadId: AppState["messageIdsByThreadId"] | undefined;
  let previousResult = true;

  return (state) => {
    if (
      previousThreadIds === state.threadIds &&
      previousMessageIdsByThreadId === state.messageIdsByThreadId
    ) {
      return previousResult;
    }

    previousThreadIds = state.threadIds;
    previousMessageIdsByThreadId = state.messageIdsByThreadId;
    previousResult = (state.threadIds ?? []).every(
      (threadId) => (state.messageIdsByThreadId?.[threadId]?.length ?? 0) === 0,
    );
    return previousResult;
  };
}

/** A thread's shell without `updatedAt`, the one field every streamed delta rewrites. */
export type ThreadShellSettings = Omit<ThreadShell, "updatedAt">;

function threadShellSettingsEqual(left: ThreadShell, right: ThreadShell): boolean {
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (key !== "updatedAt" && left[key as keyof ThreadShell] !== right[key as keyof ThreadShell]) {
      return false;
    }
  }
  return true;
}

/** One thread's shell for subscribers that act on its settings (project, model, modes,
 *  workspace) and must not re-render while it streams: the result keeps its identity until
 *  a field other than `updatedAt` changes. */
export function createThreadShellSettingsSelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => ThreadShellSettings | undefined {
  let previousSource: ThreadShell | undefined;
  let previousResult: ThreadShell | undefined;

  return (state) => {
    const source = threadId ? state.threadShellById?.[threadId] : undefined;
    if (source === previousSource) {
      return previousResult;
    }
    previousSource = source;
    if (!source || !previousResult || !threadShellSettingsEqual(source, previousResult)) {
      previousResult = source;
    }
    return previousResult;
  };
}

export function createThreadProjectIdSelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => ProjectId | null {
  return (state) => {
    if (!threadId) {
      return null;
    }
    return state.threadShellById?.[threadId]?.projectId ?? null;
  };
}

export function createThreadWorkspaceMetadataSelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => ThreadWorkspaceMetadata {
  let previousEnvMode: ThreadEnvironmentMode | undefined = undefined;
  let previousWorktreePath: string | null = null;
  let previousWorkingDirectory: string | null = null;
  let previousResult = EMPTY_THREAD_WORKSPACE_METADATA;

  return (state) => {
    if (!threadId) {
      return EMPTY_THREAD_WORKSPACE_METADATA;
    }

    // Shell-only: avoid subscribing preview panes to live message/activity detail slices.
    const source = state.threadShellById?.[threadId];
    const envMode = source?.envMode;
    const worktreePath = source?.worktreePath ?? null;
    const workingDirectory = source?.workingDirectory ?? null;
    if (
      previousEnvMode === envMode &&
      previousWorktreePath === worktreePath &&
      previousWorkingDirectory === workingDirectory
    ) {
      return previousResult;
    }

    previousEnvMode = envMode;
    previousWorktreePath = worktreePath;
    previousWorkingDirectory = workingDirectory;
    previousResult =
      envMode === undefined && worktreePath === null && workingDirectory === null
        ? EMPTY_THREAD_WORKSPACE_METADATA
        : { envMode, worktreePath, workingDirectory };
    return previousResult;
  };
}

export interface ThreadGitActionsMetadata {
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly associatedWorktreeBranch: string | null | undefined;
  readonly createBranchFlowCompleted: boolean;
  readonly title: string | undefined;
}

const EMPTY_THREAD_GIT_ACTIONS_METADATA: ThreadGitActionsMetadata = {
  worktreePath: null,
  branch: null,
  associatedWorktreeBranch: null,
  createBranchFlowCompleted: false,
  title: undefined,
};

/** Shell-only git-action inputs (worktree, branch, title) that stay reference-stable
 *  while a turn streams. The git actions control is always mounted on the chat
 *  surface and only reads these fields; subscribing it to the full derived Thread
 *  re-rendered it on every message/activity delta. */
export function createThreadGitActionsMetadataSelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => ThreadGitActionsMetadata {
  let previousResult = EMPTY_THREAD_GIT_ACTIONS_METADATA;

  return (state) => {
    if (!threadId) {
      return EMPTY_THREAD_GIT_ACTIONS_METADATA;
    }
    const source = state.threadShellById?.[threadId];
    if (!source) {
      previousResult = EMPTY_THREAD_GIT_ACTIONS_METADATA;
      return previousResult;
    }
    const worktreePath = source.worktreePath ?? null;
    const branch = source.branch ?? null;
    const associatedWorktreeBranch = source.associatedWorktreeBranch;
    const createBranchFlowCompleted = source.createBranchFlowCompleted ?? false;
    const title = source.title;
    if (
      previousResult.worktreePath === worktreePath &&
      previousResult.branch === branch &&
      previousResult.associatedWorktreeBranch === associatedWorktreeBranch &&
      previousResult.createBranchFlowCompleted === createBranchFlowCompleted &&
      previousResult.title === title
    ) {
      return previousResult;
    }
    previousResult = {
      worktreePath,
      branch,
      associatedWorktreeBranch,
      createBranchFlowCompleted,
      title,
    };
    return previousResult;
  };
}

export function createThreadExistsSelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => boolean {
  return (state) => (threadId ? Boolean(state.threadShellById?.[threadId]) : false);
}

export function createSidebarThreadSummariesSelector(): (
  state: AppState,
) => readonly SidebarThreadSummary[] {
  let previousThreadIds: readonly ThreadId[] | undefined;
  let previousSummaryById: Record<string, SidebarThreadSummary> | undefined;
  let previousSummaries: readonly SidebarThreadSummary[] = [];

  return (state) => {
    const threadIds = state.threadIds;
    if (threadIds === previousThreadIds && state.sidebarThreadSummaryById === previousSummaryById) {
      return previousSummaries;
    }

    previousThreadIds = threadIds;
    previousSummaryById = state.sidebarThreadSummaryById;
    previousSummaries = (threadIds ?? []).flatMap((threadId) => {
      const summary = state.sidebarThreadSummaryById[threadId];
      return summary ? [summary] : [];
    });
    return previousSummaries;
  };
}

/**
 * Per-thread durable last-activity stamp (epoch ms), keyed by thread id. The
 * kanban heartbeat reads this because `SidebarThreadSummary.updatedAt` freezes
 * during streaming (the sidebar summary build is skipped on the streaming hot
 * path), while the durable thread shell's `updatedAt` advances on every appended
 * message — a busy-but-quiet turn must keep its heartbeat fresh. Derives only
 * from reference-stable records (`threadIds` / `threadShellById`) and returns
 * the previous result by reference when no surfaced timestamp actually advanced,
 * so the board only re-derives when a thread's durable activity really moved.
 */
const EMPTY_LAST_ACTIVITY_TIMESTAMP: Readonly<Record<string, number | null>> = Object.freeze({});

export function createLastActivityTimestampSelector(): (
  state: AppState,
) => Readonly<Record<string, number | null>> {
  let previousThreadIds: readonly ThreadId[] | undefined;
  let previousThreadShellById: AppState["threadShellById"] | undefined;
  let previousResult: Readonly<Record<string, number | null>> = EMPTY_LAST_ACTIVITY_TIMESTAMP;
  let previousShellUpdatedAtByThreadId: Record<string, string | undefined> = {};

  return (state) => {
    if (
      state.threadIds === previousThreadIds &&
      state.threadShellById === previousThreadShellById
    ) {
      return previousResult;
    }
    previousThreadIds = state.threadIds;
    previousThreadShellById = state.threadShellById;

    if (!previousThreadIds || previousThreadIds.length === 0) {
      previousResult = EMPTY_LAST_ACTIVITY_TIMESTAMP;
      previousShellUpdatedAtByThreadId = {};
      return previousResult;
    }

    // Fast path: when no thread's durable stamp moved since the last surface,
    // keep the existing result object so board consumers do not re-derive for
    // unrelated shell churn (e.g. meta-only bumps that keep `updatedAt`).
    let anyChanged = false;
    for (const threadId of previousThreadIds) {
      const stamp = previousThreadShellById?.[threadId]?.updatedAt;
      if (stamp !== previousShellUpdatedAtByThreadId[threadId]) {
        anyChanged = true;
        break;
      }
    }
    if (!anyChanged) {
      return previousResult;
    }
    const nextShellUpdatedAtByThreadId: Record<string, string | undefined> = {};
    for (const threadId of previousThreadIds) {
      const stamp = previousThreadShellById?.[threadId]?.updatedAt;
      nextShellUpdatedAtByThreadId[threadId] = stamp;
    }
    previousShellUpdatedAtByThreadId = nextShellUpdatedAtByThreadId;

    const nextResult: Record<string, number | null> = {};
    let hasEntry = false;
    for (const threadId of previousThreadIds) {
      const stamp = nextShellUpdatedAtByThreadId[threadId];
      if (!stamp) {
        // Absent shell / stamp: do not conflate with an explicit null — a
        // pruned shell must read as "no durable stamp" (C1) so the heartbeat
        // never falls back to the frozen sidebar summary.
        continue;
      }
      const parsed = Date.parse(stamp);
      nextResult[threadId] = Number.isFinite(parsed) ? parsed : null;
      hasEntry = true;
    }
    previousResult = hasEntry ? nextResult : EMPTY_LAST_ACTIVITY_TIMESTAMP;
    return previousResult;
  };
}

export function createComposerThreadMentionSourcesSelector(): (
  state: AppState,
) => readonly ComposerThreadMentionSource[] {
  let previousThreadIds: AppState["threadIds"] | undefined;
  let previousSummaryById: AppState["sidebarThreadSummaryById"] | undefined;
  let previousSources: readonly ComposerThreadMentionSource[] = [];

  return (state) => {
    const threadIds = state.threadIds;
    const summaryById = state.sidebarThreadSummaryById;
    if (threadIds === previousThreadIds && summaryById === previousSummaryById) {
      return previousSources;
    }
    previousThreadIds = threadIds;
    previousSummaryById = summaryById;

    const nextSources = (threadIds ?? []).flatMap((threadId) => {
      const thread = summaryById[threadId];
      return thread && !isSidechatThread(thread)
        ? [
            {
              id: thread.id,
              projectId: thread.projectId,
              title: thread.title,
              provider: resolveThreadDisplayProvider(thread),
              createdAt: thread.createdAt,
              latestUserMessageAt: thread.latestUserMessageAt,
              ...(thread.archivedAt !== undefined ? { archivedAt: thread.archivedAt } : {}),
              ...(thread.lastVisitedAt !== undefined
                ? { lastVisitedAt: thread.lastVisitedAt }
                : {}),
            } satisfies ComposerThreadMentionSource,
          ]
        : [];
    });
    if (
      nextSources.length === previousSources.length &&
      nextSources.every((source, index) => {
        const previous = previousSources[index];
        return (
          source.id === previous?.id &&
          source.projectId === previous.projectId &&
          source.title === previous.title &&
          source.provider === previous.provider &&
          source.createdAt === previous.createdAt &&
          source.archivedAt === previous.archivedAt &&
          source.lastVisitedAt === previous.lastVisitedAt &&
          source.latestUserMessageAt === previous.latestUserMessageAt
        );
      })
    ) {
      return previousSources;
    }
    previousSources = nextSources;
    return previousSources;
  };
}

export interface SidebarThreadVisibilityOptions {
  readonly hideAutomationRunThreads?: boolean;
  /** Explicit access for Snoozed sections and user-initiated search. */
  readonly includeSnoozed?: boolean;
}

/** A snoozed task also hides its subagent subtree, including pinned children. */
export function collectSnoozedThreadIds(
  threads: readonly Pick<SidebarThreadSummary, "id" | "parentThreadId" | "snoozedUntil">[],
): ReadonlySet<ThreadId> {
  const snoozed = threads.filter((thread) => thread.snoozedUntil != null);
  const ids = new Set(snoozed.map((thread) => thread.id));
  for (const thread of snoozed) {
    for (const descendant of collectSubagentDescendants(threads, thread.id)) {
      ids.add(descendant.id);
    }
  }
  return ids;
}

/**
 * Whether a thread row belongs in user-facing thread lists (sidebar tree, Kanban,
 * project picker, search). Housekeeping consumers that must see every thread
 * (retention and reconciliation) read the unfiltered summaries selector instead.
 */
export function isSidebarThreadVisible(
  thread: SidebarThreadSummary,
  options?: SidebarThreadVisibilityOptions,
): boolean {
  // Sidechats live in their host's dock (a thread's, or the inbox's for standalone ones).
  if (isSidechatThread(thread)) return false;
  if (thread.snoozedUntil != null && !options?.includeSnoozed) return false;
  if (!options?.hideAutomationRunThreads) return true;
  if (thread.isPinned) return true;
  return !isAutomationRunThread(thread);
}

// Newest activity first, so index 0 is the sidechat a host reopens.
function createSortedSidechatSummariesSelector(
  matches: (thread: SidebarThreadSummary) => boolean,
): (state: AppState) => readonly SidebarThreadSummary[] {
  const selectSidebarSummaries = createSidebarThreadSummariesSelector();
  let previousSummaries: readonly SidebarThreadSummary[] | undefined;
  let previousSidechats: readonly SidebarThreadSummary[] = [];

  return (state) => {
    const summaries = selectSidebarSummaries(state);
    if (summaries === previousSummaries) return previousSidechats;
    previousSummaries = summaries;
    const nextSidechats = summaries
      .filter((thread) => thread.archivedAt == null && matches(thread))
      .toSorted(
        (left, right) =>
          Date.parse(right.sidechatLastActivityAt ?? right.updatedAt ?? right.createdAt) -
          Date.parse(left.sidechatLastActivityAt ?? left.updatedAt ?? left.createdAt),
      );
    if (
      nextSidechats.length === previousSidechats.length &&
      nextSidechats.every((thread, index) => thread === previousSidechats[index])
    ) {
      return previousSidechats;
    }
    previousSidechats = nextSidechats;
    return previousSidechats;
  };
}

export function createSidechatSummariesForSourceSelector(
  sourceThreadId: ThreadId,
): (state: AppState) => readonly SidebarThreadSummary[] {
  return createSortedSidechatSummariesSelector(
    (thread) => thread.sidechatSourceThreadId === sourceThreadId,
  );
}

/** Sidechats for one GitHub item; Ask can scope reuse to its chosen project. */
export function createSidechatSummariesForGitHubItemSelector(item: {
  readonly projectId?: ProjectId;
  readonly repository: string;
  readonly number: number;
}): (state: AppState) => readonly SidebarThreadSummary[] {
  return createSortedSidechatSummariesSelector(
    (thread) =>
      (item.projectId === undefined || thread.projectId === item.projectId) &&
      sidechatContextMatchesGitHubItem(thread.sidechatContext, item),
  );
}

export function createSidebarDisplayThreadsSelector(
  options?: SidebarThreadVisibilityOptions,
): (state: AppState) => readonly SidebarThreadSummary[] {
  const selectSidebarSummaries = createSidebarThreadSummariesSelector();
  let previousSummaries: readonly SidebarThreadSummary[] | undefined;
  let previousDisplaySummaries: readonly SidebarThreadSummary[] = [];

  return (state) => {
    const sidebarSummaries = selectSidebarSummaries(state);
    if (sidebarSummaries === previousSummaries) {
      return previousDisplaySummaries;
    }

    previousSummaries = sidebarSummaries;
    previousDisplaySummaries = sidebarSummaries.filter(
      (thread) =>
        !thread.parentThreadId &&
        thread.archivedAt == null &&
        isSidebarThreadVisible(thread, options),
    );
    return previousDisplaySummaries;
  };
}

// unlike the flat display selector, this keeps child (subagent) threads so the tree can nest them under the parent row; flat consumers keep using the display selector
export function createSidebarTreeThreadsSelector(
  options?: SidebarThreadVisibilityOptions,
): (state: AppState) => readonly SidebarThreadSummary[] {
  const selectSidebarSummaries = createSidebarThreadSummariesSelector();
  let previousSummaries: readonly SidebarThreadSummary[] | undefined;
  let previousTreeSummaries: readonly SidebarThreadSummary[] = [];

  return (state) => {
    const sidebarSummaries = selectSidebarSummaries(state);
    if (sidebarSummaries === previousSummaries) {
      return previousTreeSummaries;
    }

    previousSummaries = sidebarSummaries;
    const snoozedThreadIds = options?.includeSnoozed
      ? null
      : collectSnoozedThreadIds(sidebarSummaries);
    previousTreeSummaries = sidebarSummaries.filter(
      (thread) =>
        thread.archivedAt == null &&
        !snoozedThreadIds?.has(thread.id) &&
        isSidebarThreadVisible(thread, options),
    );
    return previousTreeSummaries;
  };
}

/**
 * Last time each project was actually *used*, i.e. when a thread of that project last received a
 * user message (falling back to the thread's creation time for threads never written to).
 *
 * Deliberately not `Project.updatedAt`: that timestamp only moves when project *metadata* changes
 * (creation, rename, pin, scripts), so ranking by it surfaces the most recently created project
 * instead of the one you were last talking in. Deliberately not thread `updatedAt` either: that
 * churns on every streamed token and would rebuild this map continuously.
 */
export function createProjectLastActivityAtSelector(): (
  state: AppState,
) => ReadonlyMap<ProjectId, string> {
  let previousThreadIds: AppState["threadIds"] | undefined;
  let previousSummaryById: AppState["sidebarThreadSummaryById"] | undefined;
  let previousActivity: ReadonlyMap<ProjectId, string> = new Map();

  return (state) => {
    const threadIds = state.threadIds;
    const summaryById = state.sidebarThreadSummaryById;
    if (threadIds === previousThreadIds && summaryById === previousSummaryById) {
      return previousActivity;
    }
    previousThreadIds = threadIds;
    previousSummaryById = summaryById;

    const nextActivity = new Map<ProjectId, string>();
    for (const threadId of threadIds ?? []) {
      const thread = summaryById[threadId];
      if (!thread) {
        continue;
      }
      const activityAt = thread.latestUserMessageAt ?? thread.createdAt;
      const current = nextActivity.get(thread.projectId);
      if (current === undefined || current < activityAt) {
        nextActivity.set(thread.projectId, activityAt);
      }
    }

    if (
      nextActivity.size === previousActivity.size &&
      [...nextActivity].every(
        ([projectId, activityAt]) => previousActivity.get(projectId) === activityAt,
      )
    ) {
      return previousActivity;
    }
    previousActivity = nextActivity;
    return previousActivity;
  };
}

export function createFirstProjectSelector(): (state: AppState) => Project | undefined {
  let previousProjects: readonly Project[] | undefined;
  let previousFirstProject: Project | undefined;

  return (state) => {
    if (state.projects === previousProjects) {
      return previousFirstProject;
    }

    previousProjects = state.projects;
    previousFirstProject = state.projects.find((project) => project.kind === "project");
    return previousFirstProject;
  };
}
