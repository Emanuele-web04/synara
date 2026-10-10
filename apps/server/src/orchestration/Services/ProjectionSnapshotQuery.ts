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

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
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
  /** completed file-change payloads, newest first, when explicitly requested */
  readonly fileChangeActivityPayloads?: ReadonlyArray<unknown>;
}

export interface ProjectionThreadCheckpointContextOptions {
  /** the narrow activity payload set for non-Git file attribution */
  readonly includeFileChangeActivityPayloads?: boolean;
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

/** soft-deleted threads intentionally included — purge can defer while delivery is unresolved and their worktrees must stay reclaimable */
export interface ProjectionManagedWorktreeThread {
  readonly id: ThreadId;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly worktreePath: string | null;
  readonly associatedWorktreePath: string | null;
}

export interface ProjectionSnapshotQueryShape {
  /** lightweight snapshot bootstrapping the engine without hydrating message/activity/checkpoint bodies */
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /** rehydrates from projection tables; sequence derived from projector cursors */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /** aggregate counts without hydrating the read model */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /** latest snapshot sequence without hydrating entities */
  readonly getSnapshotSequence: () => Effect.Effect<
    ProjectionSnapshotSequence,
    ProjectionRepositoryError
  >;

  /** stale threads whose projection still appears in flight — lets the reconciler avoid hydrating the shell snapshot every poll */
  readonly listStaleInFlightThreadIds: (input: {
    readonly updatedBefore: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionRepositoryError>;

  /** only the columns worktree retention needs — avoids hydrating the read model on a background prune while still exposing soft-deleted threads */
  readonly listManagedWorktreeThreads: () => Effect.Effect<
    ReadonlyArray<ProjectionManagedWorktreeThread>,
    ProjectionRepositoryError
  >;

  /** project rows + thread shell summaries so clients bootstrap navigation without hydrating every thread body */
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

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

  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
    options?: ProjectionThreadCheckpointContextOptions,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /** intentionally independent of the bounded activity window so long turns and restarts can still materialize references */
  readonly listGeneratedImageActivitiesByTurn: (
    threadId: ThreadId,
    turnId: TurnId,
  ) => Effect.Effect<
    ReadonlyArray<ProjectionGeneratedImageActivityRecord>,
    ProjectionRepositoryError
  >;

  readonly getFullThreadDiffContext: (
    threadId: ThreadId,
    toTurnCount: number,
  ) => Effect.Effect<Option.Option<ProjectionFullThreadDiffContext>, ProjectionRepositoryError>;

  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Read several active thread shells in one round of queries. Ids without an
   * active thread are simply absent from the result.
   */
  readonly getThreadShellsByIds: (
    threadIds: ReadonlyArray<ThreadId>,
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

  readonly getThreadDetailById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

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

  /** detail snapshot plus its projection cursor in one transaction */
  readonly getThreadDetailSnapshotById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, ProjectionRepositoryError>;
}

export class ProjectionSnapshotQuery extends ServiceMap.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("synara/orchestration/Services/ProjectionSnapshotQuery") {}
