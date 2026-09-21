import {
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Option, ServiceMap, Schema } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionCheckpoint = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpoint = typeof ProjectionCheckpoint.Type;

export const ListByThreadIdInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListByThreadIdInput = typeof ListByThreadIdInput.Type;

export const GetByThreadAndTurnCountInput = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
});
export type GetByThreadAndTurnCountInput = typeof GetByThreadAndTurnCountInput.Type;

export interface ProjectionCheckpointRepositoryShape {
  /** ascending checkpoint turn-count order */
  readonly listByThreadId: (
    input: ListByThreadIdInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionCheckpoint>, ProjectionRepositoryError>;

  readonly getByThreadAndTurnCount: (
    input: GetByThreadAndTurnCountInput,
  ) => Effect.Effect<Option.Option<ProjectionCheckpoint>, ProjectionRepositoryError>;
}

export class ProjectionCheckpointRepository extends ServiceMap.Service<
  ProjectionCheckpointRepository,
  ProjectionCheckpointRepositoryShape
>()("synara/persistence/Services/ProjectionCheckpoints/ProjectionCheckpointRepository") {}
