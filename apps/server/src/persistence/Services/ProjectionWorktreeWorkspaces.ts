import {
  IsoDateTime,
  NonNegativeInt,
  OrchestrationThreadPullRequest,
  ProjectId,
  WorktreeWorkspaceActiveOperation,
  WorktreeWorkspaceFailure,
  WorktreeWorkspaceId,
  WorktreeWorkspaceKind,
  WorktreeWorkspaceSetupStatus,
  WorktreeWorkspaceSourceKind,
  WorktreeWorkspaceState,
} from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionWorktreeWorkspace = Schema.Struct({
  workspaceId: WorktreeWorkspaceId,
  projectId: ProjectId,
  repositoryIdentity: Schema.NullOr(Schema.String),
  kind: WorktreeWorkspaceKind,
  state: WorktreeWorkspaceState,
  title: Schema.String,
  path: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  headRef: Schema.NullOr(Schema.String),
  targetRef: Schema.String,
  targetResolvedCommit: Schema.NullOr(Schema.String),
  createdFromCommit: Schema.NullOr(Schema.String),
  sourceKind: WorktreeWorkspaceSourceKind,
  sourceRef: Schema.NullOr(Schema.String),
  setupStatus: WorktreeWorkspaceSetupStatus,
  setupError: Schema.NullOr(Schema.String),
  setupLogId: Schema.NullOr(Schema.String),
  lastKnownPr: Schema.NullOr(OrchestrationThreadPullRequest),
  isPinned: Schema.Boolean,
  lifecycleGeneration: NonNegativeInt,
  activeOperation: Schema.NullOr(WorktreeWorkspaceActiveOperation),
  lastFailure: Schema.NullOr(WorktreeWorkspaceFailure),
  mutationRevision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionWorktreeWorkspace = typeof ProjectionWorktreeWorkspace.Type;

export const GetProjectionWorktreeWorkspaceInput = Schema.Struct({
  workspaceId: WorktreeWorkspaceId,
});
export type GetProjectionWorktreeWorkspaceInput = typeof GetProjectionWorktreeWorkspaceInput.Type;

export interface ProjectionWorktreeWorkspaceRepositoryShape {
  readonly upsert: (
    workspace: ProjectionWorktreeWorkspace,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionWorktreeWorkspaceInput,
  ) => Effect.Effect<Option.Option<ProjectionWorktreeWorkspace>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionWorktreeWorkspace>,
    ProjectionRepositoryError
  >;
}

export class ProjectionWorktreeWorkspaceRepository extends ServiceMap.Service<
  ProjectionWorktreeWorkspaceRepository,
  ProjectionWorktreeWorkspaceRepositoryShape
>()(
  "synara/persistence/Services/ProjectionWorktreeWorkspaces/ProjectionWorktreeWorkspaceRepository",
) {}
