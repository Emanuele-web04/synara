// FILE: groupThreadState.ts
// Purpose: One derivation of a group thread's live state — "waiting on you",
//          "working", "ready for review", "idle", "resolved" — used by the web
//          Overview surface and by the server's `synara_project_list_threads`
//          tool so both report the same bucket for the same thread.
// Layer: Shared domain helper (structural inputs accept both the web
//        SidebarThreadSummary and the server OrchestrationThreadShell)
// Exports: GroupThreadStateId, GroupThreadSectionId, GROUP_THREAD_STATES,
//          GROUP_THREAD_STATE_LABELS, groupThreadStateLabel,
//          canSessionAnswerPendingRequests, isLatestTurnSettled,
//          hasLiveLatestTurn, isThreadActivelyWorking,
//          groupThreadNeedsAttention, resolveGroupThreadState,
//          GroupCoordinatorStatusId, resolveGroupCoordinatorStatus

/**
 * The five buckets `resolveGroupThreadState` can return. "landing" exists only
 * as a label: no read model exposes PR review/queue state yet, so an
 * approved-but-unmerged PR cannot be distinguished from an open one here.
 */
export type GroupThreadSectionId = "waiting" | "working" | "review" | "idle" | "resolved";
export type GroupThreadStateId = GroupThreadSectionId | "landing";

export const GROUP_THREAD_STATES: readonly GroupThreadSectionId[] = [
  "waiting",
  "working",
  "review",
  "idle",
  "resolved",
];

export const GROUP_THREAD_STATE_LABELS: Record<GroupThreadStateId, string> = {
  waiting: "Waiting on you",
  working: "Working",
  review: "Ready for review",
  landing: "Landing",
  idle: "Idle",
  resolved: "Resolved",
};

export function groupThreadStateLabel(state: GroupThreadStateId): string {
  return GROUP_THREAD_STATE_LABELS[state];
}

/**
 * Minimal session view. The web's `ThreadSession.status` is a display phase
 * (disconnected/connecting/ready/running/error/closed) with the authoritative
 * provider state in `orchestrationStatus`; the orchestration read-model
 * session reports `idle|starting|running|ready|interrupted|stopped|error`
 * directly in `status`. `resolveGroupSessionStatus` picks the orchestration
 * vocabulary whenever it is present so both shapes fold into one derivation.
 */
export interface GroupThreadSessionView {
  readonly status: string;
  readonly orchestrationStatus?: string | undefined;
  readonly activeTurnId?: string | null | undefined;
}

export interface GroupThreadLatestTurnView {
  readonly state: string;
  readonly startedAt?: string | null | undefined;
  readonly completedAt?: string | null | undefined;
}

export interface GroupThreadStateThread {
  readonly archivedAt?: string | null | undefined;
  readonly hasPendingApprovals?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
  /** Live work attached behind the latest turn (web-only; absent server-side). */
  readonly hasLiveTailWork?: boolean | undefined;
  readonly session?: GroupThreadSessionView | null | undefined;
  readonly latestTurn?: GroupThreadLatestTurnView | null | undefined;
}

function resolveGroupSessionStatus(session: GroupThreadSessionView): string {
  return session.orchestrationStatus ?? session.status;
}

/**
 * Pending approval / user-input requests are only actionable while the session
 * that raised them can still receive the answer. Closed, stopped, or errored
 * sessions can't — their stale pending flags must not keep a thread "waiting".
 * A thread with no session yet keeps the request actionable: the flag can
 * arrive ahead of the session snapshot.
 */
export function canSessionAnswerPendingRequests(
  session: GroupThreadSessionView | null | undefined,
): boolean {
  if (session == null) {
    return true;
  }
  return !(
    session.status === "closed" ||
    session.status === "error" ||
    session.status === "stopped" ||
    session.orchestrationStatus === "stopped" ||
    session.orchestrationStatus === "error" ||
    session.orchestrationStatus === "closed"
  );
}

export function isLatestTurnSettled(
  latestTurn: GroupThreadLatestTurnView | null | undefined,
  session: GroupThreadSessionView | null | undefined,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (latestTurn.state === "interrupted" || latestTurn.state === "error") {
    return true;
  }
  if (session == null) return true;
  if (resolveGroupSessionStatus(session) === "running") return false;
  return true;
}

export function hasLiveLatestTurn(
  latestTurn: GroupThreadLatestTurnView | null | undefined,
  session: GroupThreadSessionView | null | undefined,
): boolean {
  if (!latestTurn?.startedAt) {
    return false;
  }
  return !isLatestTurnSettled(latestTurn, session);
}

/**
 * Single definition of "this thread is actively doing work": either the client
 * tracks live work attached behind the latest turn, or the session is running
 * and no completed latest turn proves it finished.
 */
export function isThreadActivelyWorking(thread: {
  readonly hasLiveTailWork?: boolean | undefined;
  readonly session?: GroupThreadSessionView | null | undefined;
  readonly latestTurn?: GroupThreadLatestTurnView | null | undefined;
}): boolean {
  if (thread.hasLiveTailWork === true) {
    return true;
  }
  const session = thread.session ?? null;
  return (
    session != null &&
    resolveGroupSessionStatus(session) === "running" &&
    (thread.latestTurn == null || hasLiveLatestTurn(thread.latestTurn, session))
  );
}

function isGroupThreadErrored(thread: GroupThreadStateThread): boolean {
  return (
    (thread.session != null && resolveGroupSessionStatus(thread.session) === "error") ||
    (thread.latestTurn?.state === "error" &&
      isLatestTurnSettled(thread.latestTurn, thread.session ?? null))
  );
}

/**
 * A thread needs the user: a live approval/input request, or a failed
 * session/turn. Archived threads and dead sessions can't receive an answer,
 * so their stale pending flags never surface — this is the same masking
 * `resolveThreadStatusPill` applies.
 */
export function groupThreadNeedsAttention(thread: GroupThreadStateThread): boolean {
  if (thread.archivedAt != null) {
    return false;
  }
  if (isGroupThreadErrored(thread)) {
    return true;
  }
  const session = thread.session ?? null;
  return (
    canSessionAnswerPendingRequests(session) === true &&
    (thread.hasPendingApprovals === true || thread.hasPendingUserInput === true)
  );
}

/**
 * Coordinator status vocabulary used by the Group panel row, the project
 * summaries feed, and `ProjectAgentOverview["coordinatorStatus"]`. Deriving it
 * in one place keeps every surface on the same mapping.
 */
export type GroupCoordinatorStatusId = "unconfigured" | "idle" | "running" | "paused" | "stopped";

/**
 * The coordinator row is driven by live thread state (same inputs the sidebar
 * uses) so it reads "running" while a turn is actually in flight — the goal
 * lifecycle alone cannot distinguish "watching" from "idle". Goal pause/stop
 * still wins over liveness: a paused group must not report its coordinator as
 * running. Pending approvals and user-input requests count as running because
 * the coordinator's turn is still in flight, waiting on an answer it can
 * receive. An explicitly active goal reports "running" even without a live
 * turn, matching the established goal→status contract.
 */
export function resolveGroupCoordinatorStatus(input: {
  readonly configured: boolean;
  readonly goalStatus?: string | null | undefined;
  readonly thread?: GroupThreadStateThread | null | undefined;
}): GroupCoordinatorStatusId {
  if (!input.configured) {
    return "unconfigured";
  }
  if (input.goalStatus === "paused") {
    return "paused";
  }
  if (input.goalStatus === "stopped" || input.goalStatus === "cancelled") {
    return "stopped";
  }
  if (input.goalStatus === "active") {
    return "running";
  }
  const thread = input.thread ?? null;
  if (thread === null || thread.archivedAt != null) {
    return "idle";
  }
  const session = thread.session ?? null;
  const pendingRequest =
    canSessionAnswerPendingRequests(session) === true &&
    (thread.hasPendingApprovals === true || thread.hasPendingUserInput === true);
  if (
    pendingRequest ||
    isThreadActivelyWorking(thread) ||
    (session != null &&
      (resolveGroupSessionStatus(session) === "connecting" ||
        resolveGroupSessionStatus(session) === "starting"))
  ) {
    return "running";
  }
  return "idle";
}

/**
 * Live-state bucket for one group thread, derived from the same inputs the
 * sidebar uses (pending request flags, session status, latest turn) plus the
 * group's task and PR data. Terminal markers (archive, finished task) win over
 * stale pending flags; an open non-draft PR only counts as "review" once the
 * thread is not still producing work, and a merged/closed PR resolves the
 * thread. A "starting" session counts the same as "connecting".
 */
export function resolveGroupThreadState(input: {
  readonly thread: GroupThreadStateThread;
  readonly task: {
    readonly status: string;
    readonly archivedAt?: string | null | undefined;
  } | null;
  readonly indexArchived: boolean;
  readonly pullRequest: { readonly state: string; readonly isDraft?: boolean | undefined } | null;
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
  const session = thread.session ?? null;
  const canAnswer = canSessionAnswerPendingRequests(session);
  const hasPendingRequest =
    canAnswer && (thread.hasPendingApprovals === true || thread.hasPendingUserInput === true);
  if (hasPendingRequest || isGroupThreadErrored(thread)) {
    return "waiting";
  }
  if (
    isThreadActivelyWorking(thread) ||
    (session != null &&
      (resolveGroupSessionStatus(session) === "connecting" ||
        resolveGroupSessionStatus(session) === "starting"))
  ) {
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
