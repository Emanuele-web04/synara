/**
 * ProjectionThreadGoalRepository - Projection repository for the per-thread goal.
 *
 * Stores the single active/terminal goal for a thread (1:1, nullable) as JSON so the
 * reactor and web (which read the SQLite projection) see the same goal state the
 * in-memory read model derives.
 *
 * @module ProjectionThreadGoalRepository
 */
import { OrchestrationGoal, ThreadId } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadGoal = Schema.Struct({
  threadId: ThreadId,
  goal: OrchestrationGoal,
});
export type ProjectionThreadGoal = typeof ProjectionThreadGoal.Type;

export const GetProjectionThreadGoalInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadGoalInput = typeof GetProjectionThreadGoalInput.Type;

export const DeleteProjectionThreadGoalInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadGoalInput = typeof DeleteProjectionThreadGoalInput.Type;

export interface ProjectionThreadGoalRepositoryShape {
  readonly upsert: (row: ProjectionThreadGoal) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByThreadId: (
    input: GetProjectionThreadGoalInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadGoal>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadGoalInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadGoalRepository extends ServiceMap.Service<
  ProjectionThreadGoalRepository,
  ProjectionThreadGoalRepositoryShape
>()("t3/persistence/Services/ProjectionThreadGoal/ProjectionThreadGoalRepository") {}
