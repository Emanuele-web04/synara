/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  OrchestrationCheckpointSummary,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationSpaceShell,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThread,
  OrchestrationThreadShell,
  CheckpointRef,
  ProjectId,
  ProjectKind,
  SpaceId,
  ThreadId,
  ThreadEnvironmentMode,
  TurnId,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface OrchestrationThreadMentionContext {
  readonly id: ThreadId;
  readonly title: OrchestrationThread["title"];
  readonly modelSelection: OrchestrationThread["modelSelection"];
  /** The newest `messageLimit` messages, oldest first. */
  readonly messages: OrchestrationThread["messages"];
  /**
   * How many messages the thread holds in total (capped at the transcript
   * read limit, matching what a full detail read would have returned), so a
   * context block can still say how many older messages it omitted.
   */
  readonly totalMessageCount: number;
}

/**
 * A full thread detail without its activity timeline. The field is removed at
 * runtime and in the type, so a caller that needs activities fails to compile
 * instead of silently reading an empty list.
 */
export type OrchestrationThreadWithoutActivities = Omit<OrchestrationThread, "activities">;

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
}

/** Stable ordering key returned by the bounded runtime-reconciliation query. */
export interface ProjectionStaleInFlightThreadCursor {
  readonly observedAt: string;
  readonly threadId: ThreadId;
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly projectKind: ProjectKind;
  readonly workspaceRoot: string;
  readonly envMode: ThreadEnvironmentMode;
  readonly worktreePath: string | null;
  readonly workingDirectory: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
  /** Completed file-change payloads, newest first, when explicitly requested by the caller. */
  readonly fileChangeActivityPayloads?: ReadonlyArray<unknown>;
}

export interface ProjectionThreadCheckpointContextOptions {
  /** Include in-progress provider placeholders only for read-only live diff queries. */
  readonly includeLiveCheckpoints?: boolean;
  /** Include the narrow activity payload set used to attribute files in non-Git workspaces. */
  readonly includeFileChangeActivityPayloads?: boolean;
}

/**
 * What a live provider turn diff needs to update its placeholder: the thread's
 * highest checkpoint turn count and this turn's checkpoint row, under the same
 * completed-checkpoint filter as `ProjectionThreadCheckpointContext.checkpoints`.
 */
export interface ProjectionThreadTurnDiffContext {
  /** 0 when the thread has no completed checkpoint. */
  readonly maxCheckpointTurnCount: number;
  readonly checkpoint: OrchestrationCheckpointSummary | null;
}

export interface ProjectionGeneratedImageActivityRecord {
  readonly kind: string;
  readonly payload: unknown;
}

export interface ProjectionFullThreadDiffContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly projectKind: ProjectKind;
  readonly workspaceRoot: string;
  readonly envMode: ThreadEnvironmentMode;
  readonly worktreePath: string | null;
  readonly workingDirectory: string | null;
  readonly latestCheckpointTurnCount: number;
  readonly baselineCheckpointRef: CheckpointRef | null;
  readonly toCheckpointRef: CheckpointRef | null;
}

/**
 * Narrow projection row backing managed-worktree retention.
 *
 * Soft-deleted threads are intentionally included because purge can be deferred
 * while provider delivery is unresolved; their worktrees must remain eligible
 * for snapshot and reclaim until the rows are removed.
 */
export interface ProjectionManagedWorktreeThread {
  readonly id: ThreadId;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly worktreePath: string | null;
  readonly associatedWorktreePath: string | null;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the lightweight command snapshot used to bootstrap the in-memory
   * orchestration engine without hydrating message/activity/checkpoint bodies.
   */
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Read the latest projection snapshot sequence without hydrating read-model entities.
   */
  readonly getSnapshotSequence: () => Effect.Effect<
    ProjectionSnapshotSequence,
    ProjectionRepositoryError
  >;

  /**
   * Find only stale threads whose projected session/turn still appears in
   * flight. Used by the runtime reconciler to avoid hydrating the full shell
   * snapshot on every polling interval.
   */
  readonly listStaleInFlightThreadIds: (input: {
    readonly updatedBefore: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the next bounded candidate page in (observedAt, threadId) order.
   * Carry the returned key even when the planner finds no repair on this page.
   */
  readonly listStaleInFlightThreadPage: (input: {
    readonly updatedBefore: string;
    readonly limit: number;
    readonly after?: ProjectionStaleInFlightThreadCursor;
  }) => Effect.Effect<
    {
      readonly threadIds: ReadonlyArray<ThreadId>;
      readonly nextCursor: ProjectionStaleInFlightThreadCursor | null;
    },
    ProjectionRepositoryError
  >;

  /**
   * Read only the columns managed-worktree retention needs, for every thread that
   * records a worktree path. Avoids hydrating the full read model on a background
   * prune, while still exposing soft-deleted threads so their worktrees are reclaimed.
   */
  readonly listManagedWorktreeThreads: () => Effect.Effect<
    ReadonlyArray<ProjectionManagedWorktreeThread>,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only project rows plus thread shell summaries so clients can
   * bootstrap navigation state without hydrating every thread body.
   */
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /**
   * Read active project shells for the given ids in one query.
   * Missing or deleted ids are omitted rather than returned as none.
   */
  readonly getProjectShellsByIds: (
    projectIds: ReadonlyArray<ProjectId>,
  ) => Effect.Effect<ReadonlyArray<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /** Read a single active custom space shell row by id. */
  readonly getSpaceShellById: (
    spaceId: SpaceId,
  ) => Effect.Effect<Option.Option<OrchestrationSpaceShell>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
    options?: ProjectionThreadCheckpointContextOptions,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /**
   * Read only what a live turn diff placeholder needs (see
   * ProjectionThreadTurnDiffContext) without decoding every checkpoint's file
   * list. None when the thread is missing or deleted.
   */
  readonly getThreadTurnDiffContext: (
    threadId: ThreadId,
    turnId: TurnId,
  ) => Effect.Effect<Option.Option<ProjectionThreadTurnDiffContext>, ProjectionRepositoryError>;

  /**
   * Read the durable generated-image records for one turn. This narrow query is
   * intentionally independent of the bounded thread-detail activity window so
   * long turns and server restarts can still materialize transcript references.
   */
  readonly listGeneratedImageActivitiesByTurn: (
    threadId: ThreadId,
    turnId: TurnId,
  ) => Effect.Effect<
    ReadonlyArray<ProjectionGeneratedImageActivityRecord>,
    ProjectionRepositoryError
  >;

  /**
   * Read the narrow context needed to diff a whole thread through one checkpoint.
   */
  readonly getFullThreadDiffContext: (
    threadId: ThreadId,
    toTurnCount: number,
  ) => Effect.Effect<Option.Option<ProjectionFullThreadDiffContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread shell row by id.
   * Runtime reconciliation can opt into the latest projected message timestamp
   * as its activity clock without changing the persisted sidebar shell.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
    options?: { readonly includeLatestMessageActivity?: boolean },
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Read several active thread shells in one round of queries. Ids without an
   * active thread are simply absent from the result.
   * Reconciliation can include the in-flight message activity in the same batch.
   */
  readonly getThreadShellsByIds: (
    threadIds: ReadonlyArray<ThreadId>,
    options?: { readonly includeLatestMessageActivity?: boolean },
  ) => Effect.Effect<ReadonlyArray<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * True when the thread id is already bound to an aggregate, including
   * soft-deleted threads that the active-only reads above hide.
   *
   * Callers that decide whether to dispatch `thread.create` must use this:
   * the command decider rejects re-creating a thread id that still has a
   * tombstone, so an active-only existence check would loop on rejections.
   */
  readonly threadIdExistsIncludingDeleted: (
    threadId: ThreadId,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  /**
   * Recover the parent thread shell for legacy synthetic subagent IDs.
   *
   * Shell-only on purpose: the provider-session resolver that consumes this
   * runs on every provider intent event and reads just id/session/model.
   */
  readonly findSyntheticSubagentParentThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id.
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read the same active thread detail as `getThreadDetailById` (messages,
   * plans, pending interactions, checkpoints, session, latest turn and summary
   * flags) without loading the activity timeline, the most expensive part of a
   * detail read on long threads. Summary flags stay identical because pending
   * interactions, not activity replay, decide them.
   */
  readonly getThreadDetailWithoutActivitiesById: (
    threadId: ThreadId,
  ) => Effect.Effect<
    Option.Option<OrchestrationThreadWithoutActivities>,
    ProjectionRepositoryError
  >;

  /**
   * The bounded slice a `thread://` mention needs: the thread row plus its
   * newest `messageLimit` messages. Skips plans, activities, pending
   * interactions, checkpoints, and the full-transcript decode that
   * `getThreadDetailById` pays, none of which a mention context block reads.
   */
  readonly getThreadMentionContextById: (
    threadId: ThreadId,
    options: { readonly messageLimit: number },
  ) => Effect.Effect<Option.Option<OrchestrationThreadMentionContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id with the full message history.
   */
  readonly getThreadDetailForExportById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot and its projection cursor in one transaction.
   */
  readonly getThreadDetailSnapshotById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends ServiceMap.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("synara/orchestration/Services/ProjectionSnapshotQuery") {}
