// FILE: groupOverview.logic.ts
// Purpose: Pure derivation of the Group panel Overview — which sidebar thread
//          summaries belong to a group, how they partition into live-state sections,
//          which pull requests and automations the group owns, and whether any member
//          thread needs the user's attention (drives the header + sidebar dot).
// Layer: Group overview logic

import type { AutomationDefinition, ProjectId, ProjectTask, ThreadId } from "@synara/contracts";

import type { AppState } from "../../../storeState";
import type { ThreadPullRequest } from "../../../hooks/useThreadPullRequests";
import type { SidebarThreadSummary } from "../../../types";
import { canSessionAnswerPendingRequests, isLatestTurnSettled } from "../../../session-logic";
import { isThreadActivelyWorking } from "../../Sidebar.logic";

export type GroupThreadSectionId = "waiting" | "working" | "review" | "idle" | "resolved";

export interface GroupThreadSectionSpec {
  readonly id: GroupThreadSectionId;
  readonly label: string;
  /** Fallback glyph when a row has no more specific status dot (e.g. error/dead states). */
  readonly dotClass: string;
  readonly pulse: boolean;
  /** "Resolved" starts collapsed — it is history, not attention. */
  readonly defaultOpen: boolean;
}

/** Display order mirrors Claude's Overview pane: attention first, history last. */
export const GROUP_THREAD_SECTIONS: readonly GroupThreadSectionSpec[] = [
  {
    id: "waiting",
    label: "Waiting on you",
    dotClass: "bg-amber-500 dark:bg-amber-300/90",
    pulse: false,
    defaultOpen: true,
  },
  {
    id: "working",
    label: "Working",
    dotClass: "bg-sky-500 dark:bg-sky-300/80",
    pulse: true,
    defaultOpen: true,
  },
  {
    id: "review",
    label: "Ready for review",
    dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
    pulse: false,
    defaultOpen: true,
  },
  {
    id: "idle",
    label: "Idle",
    dotClass: "bg-muted-foreground/50",
    pulse: false,
    defaultOpen: true,
  },
  {
    id: "resolved",
    label: "Resolved",
    dotClass: "bg-muted-foreground/40",
    pulse: false,
    defaultOpen: false,
  },
];

type GroupThreadStateThread = Pick<
  SidebarThreadSummary,
  | "archivedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasLiveTailWork"
  | "session"
  | "latestTurn"
>;

/**
 * A thread needs the user: a live approval/input request, or a failed session/turn.
 * Archived threads and dead sessions can't receive an answer, so their stale pending
 * flags never surface — this is the same masking `resolveThreadStatusPill` applies.
 */
export function groupThreadNeedsAttention(thread: GroupThreadStateThread): boolean {
  if (thread.archivedAt != null) {
    return false;
  }
  if (isGroupThreadErrored(thread)) {
    return true;
  }
  return (
    canSessionAnswerPendingRequests(thread.session) &&
    (thread.hasPendingApprovals || thread.hasPendingUserInput)
  );
}

function isGroupThreadErrored(thread: GroupThreadStateThread): boolean {
  return (
    thread.session?.status === "error" ||
    (thread.latestTurn?.state === "error" && isLatestTurnSettled(thread.latestTurn, thread.session))
  );
}

/**
 * Live-state bucket for one group thread, derived from the same inputs the sidebar
 * uses (pending request flags, session status, latest turn) plus the group's task
 * and PR data. Terminal markers (archive, finished task) win over stale pending
 * flags; an open non-draft PR only counts as "review" once the thread is not still
 * producing work, and a merged/closed PR resolves the thread.
 * There is no "landing" bucket: `useThreadPullRequests` does not expose review or
 * queue state, so an approved-but-unmerged PR cannot be distinguished here.
 */
export function resolveGroupThreadState(input: {
  readonly thread: GroupThreadStateThread;
  readonly task: Pick<ProjectTask, "status" | "archivedAt"> | null;
  readonly indexArchived: boolean;
  readonly pullRequest: Pick<NonNullable<ThreadPullRequest>, "state" | "isDraft"> | null;
}): GroupThreadSectionId {
  const { thread, task } = input;
  if (
    thread.archivedAt != null ||
    input.indexArchived ||
    task?.archivedAt != null ||
    task?.status === "done" ||
    task?.status === "cancelled"
  ) {
    return "resolved";
  }
  const canAnswer = canSessionAnswerPendingRequests(thread.session);
  const hasPendingRequest = canAnswer && (thread.hasPendingApprovals || thread.hasPendingUserInput);
  if (hasPendingRequest || isGroupThreadErrored(thread)) {
    return "waiting";
  }
  if (isThreadActivelyWorking(thread) || thread.session?.status === "connecting") {
    return "working";
  }
  const pullRequest = input.pullRequest;
  if (pullRequest?.state === "open" && pullRequest.isDraft !== true) {
    return "review";
  }
  if (pullRequest !== null && pullRequest.state !== "open") {
    return "resolved";
  }
  return "idle";
}

/**
 * Group membership: threads started inside the group folder plus threads the group
 * started elsewhere — surfaced via the group's task `assignedThreadId`s and its
 * thread index — minus the coordinator conversation itself, which the panel already
 * shows as its own row. `sidebarThreadSummaryById` covers every orchestration thread
 * the client knows, so linked-repo threads join through `memberThreadIds`.
 */
export function collectGroupThreadSummaries(input: {
  readonly threads: readonly SidebarThreadSummary[];
  readonly groupProjectId: ProjectId;
  readonly memberThreadIds: ReadonlySet<ThreadId>;
  readonly coordinatorThreadId: ThreadId | null;
}): SidebarThreadSummary[] {
  return input.threads.filter(
    (thread) =>
      thread.id !== input.coordinatorThreadId &&
      (thread.projectId === input.groupProjectId || input.memberThreadIds.has(thread.id)),
  );
}

export interface GroupThreadRow {
  readonly thread: SidebarThreadSummary;
  /** The group task this thread executes, when the task index points at it. */
  readonly task: ProjectTask | null;
  readonly state: GroupThreadSectionId;
  /** The thread's PR when `useThreadPullRequests` resolved one — drives the row pill. */
  readonly pullRequest: ThreadPullRequest;
  /** Repo/project label — only set when the thread lives outside the group folder. */
  readonly projectName: string | null;
  /** First non-empty line of the task description, when the row has one. */
  readonly taskLine: string | null;
}

export function firstLineOf(text: string | null | undefined): string | null {
  const line = text?.split("\n").find((entry) => entry.trim().length > 0) ?? null;
  return line === null ? null : line.trim();
}

export function buildGroupThreadRows(input: {
  readonly threads: readonly SidebarThreadSummary[];
  readonly taskByThreadId: ReadonlyMap<ThreadId, ProjectTask>;
  readonly indexArchivedThreadIds: ReadonlySet<ThreadId>;
  readonly pullRequests: ReadonlyMap<ThreadId, ThreadPullRequest>;
  readonly projectNameById: ReadonlyMap<ProjectId, string>;
  readonly groupProjectId: ProjectId;
  readonly groupProjectName: string;
}): GroupThreadRow[] {
  const rows: GroupThreadRow[] = [];
  for (const thread of input.threads) {
    const task = input.taskByThreadId.get(thread.id) ?? null;
    const pullRequest = input.pullRequests.get(thread.id) ?? null;
    const state = resolveGroupThreadState({
      thread,
      task,
      indexArchived: input.indexArchivedThreadIds.has(thread.id),
      pullRequest,
    });
    const projectName =
      thread.projectId !== input.groupProjectId
        ? (input.projectNameById.get(thread.projectId) ?? null)
        : null;
    rows.push({
      thread,
      task,
      state,
      pullRequest,
      projectName:
        projectName === input.groupProjectName || thread.projectId === input.groupProjectId
          ? null
          : projectName,
      taskLine: task === null ? null : firstLineOf(task.description),
    });
  }
  return rows;
}

/**
 * Newest-first within each section (updatedAt desc) so the freshest thread surfaces
 * on top, matching the sidebar's recency ordering.
 */
export function partitionGroupThreadRows(
  rows: readonly GroupThreadRow[],
): ReadonlyMap<GroupThreadSectionId, GroupThreadRow[]> {
  const sections = new Map<GroupThreadSectionId, GroupThreadRow[]>();
  for (const spec of GROUP_THREAD_SECTIONS) {
    sections.set(spec.id, []);
  }
  for (const row of rows) {
    sections.get(row.state)?.push(row);
  }
  for (const sectionRows of sections.values()) {
    sectionRows.sort((left, right) =>
      (right.thread.updatedAt ?? "").localeCompare(left.thread.updatedAt ?? ""),
    );
  }
  return sections;
}

export interface GroupPullRequestRow {
  readonly thread: SidebarThreadSummary;
  readonly pullRequest: NonNullable<ThreadPullRequest>;
  readonly projectName: string | null;
}

/** Open PRs first, then newest activity, so actionable reviews lead the list. */
export function collectGroupPullRequestRows(input: {
  readonly threads: readonly SidebarThreadSummary[];
  readonly pullRequests: ReadonlyMap<ThreadId, ThreadPullRequest>;
  readonly projectNameById: ReadonlyMap<ProjectId, string>;
  readonly groupProjectId: ProjectId;
  readonly groupProjectName: string;
}): GroupPullRequestRow[] {
  const rows: GroupPullRequestRow[] = [];
  for (const thread of input.threads) {
    const pullRequest = input.pullRequests.get(thread.id) ?? null;
    if (pullRequest === null) continue;
    const projectName =
      thread.projectId !== input.groupProjectId
        ? (input.projectNameById.get(thread.projectId) ?? null)
        : null;
    rows.push({
      thread,
      pullRequest,
      projectName:
        projectName === input.groupProjectName || thread.projectId === input.groupProjectId
          ? null
          : projectName,
    });
  }
  rows.sort((left, right) => {
    const leftOpen = left.pullRequest.state === "open" ? 0 : 1;
    const rightOpen = right.pullRequest.state === "open" ? 0 : 1;
    if (leftOpen !== rightOpen) return leftOpen - rightOpen;
    return (right.thread.updatedAt ?? "").localeCompare(left.thread.updatedAt ?? "");
  });
  return rows;
}

/**
 * The group's automations: anything targeting the group project, plus runs the
 * coordinator or member threads started (`sourceThreadId`) or continue into
 * (`targetThreadId`).
 */
export function collectGroupAutomations(input: {
  readonly definitions: readonly AutomationDefinition[];
  readonly groupProjectId: ProjectId;
  readonly memberThreadIds: ReadonlySet<ThreadId>;
}): AutomationDefinition[] {
  return input.definitions.filter(
    (definition) =>
      definition.archivedAt === null &&
      (definition.projectId === input.groupProjectId ||
        (definition.targetThreadId !== null &&
          input.memberThreadIds.has(definition.targetThreadId)) ||
        (definition.sourceThreadId !== null &&
          input.memberThreadIds.has(definition.sourceThreadId))),
  );
}

export interface GroupNeedsAttentionGroup {
  readonly projectId: ProjectId;
  readonly coordinatorThreadId?: ThreadId | null;
  /**
   * Extra member threads (task `assignedThreadId`s + index ids) when known. The
   * selector only consults ids present in `sidebarThreadSummaryById`, so callers
   * that don't have the group's agent data loaded simply omit it.
   */
  readonly memberThreadIds?: ReadonlySet<ThreadId>;
}

const EMPTY_ATTENTION_SET: ReadonlySet<ProjectId> = new Set();

/**
 * One store subscription that answers "which of these groups have a thread Waiting
 * on you" for every group row at once — the sidebar surface and the chat-header
 * toggle share it so the dot is computed in exactly one place. Returns a stable Set
 * reference unless the membership actually changes (the sidebar summary record is
 * the only input; callers memoize `groups` separately).
 */
export function createGroupNeedsAttentionSelector(input: {
  readonly groups: ReadonlyMap<ProjectId, GroupNeedsAttentionGroup>;
}): (state: AppState) => ReadonlySet<ProjectId> {
  let previousSummaryById: AppState["sidebarThreadSummaryById"] | undefined;
  let previousResult: ReadonlySet<ProjectId> = EMPTY_ATTENTION_SET;
  return (state) => {
    const summaryById = state.sidebarThreadSummaryById;
    if (summaryById === previousSummaryById) {
      return previousResult;
    }
    previousSummaryById = summaryById;
    if (input.groups.size === 0) {
      previousResult = EMPTY_ATTENTION_SET;
      return previousResult;
    }
    const next = new Set<ProjectId>();
    for (const summary of Object.values(summaryById)) {
      if (summary === undefined) continue;
      for (const group of input.groups.values()) {
        if (summary.id === group.coordinatorThreadId) continue;
        if (next.has(group.projectId)) continue;
        const isMember =
          summary.projectId === group.projectId || group.memberThreadIds?.has(summary.id) === true;
        if (isMember && groupThreadNeedsAttention(summary)) {
          next.add(group.projectId);
        }
      }
    }
    let changed = next.size !== previousResult.size;
    if (!changed) {
      for (const projectId of next) {
        if (!previousResult.has(projectId)) {
          changed = true;
          break;
        }
      }
    }
    previousResult = changed ? next : previousResult;
    return previousResult;
  };
}
