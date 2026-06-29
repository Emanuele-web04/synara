import {
  IsoDateTime,
  OrchestrationProviderItem,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadProviderItem = Schema.Struct({
  providerItemId: RuntimeItemId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  item: OrchestrationProviderItem,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadProviderItem = typeof ProjectionThreadProviderItem.Type;

export const ListProjectionThreadProviderItemsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadProviderItemsInput =
  typeof ListProjectionThreadProviderItemsInput.Type;

export const DeleteProjectionThreadProviderItemsInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadProviderItemsInput =
  typeof DeleteProjectionThreadProviderItemsInput.Type;

export interface ProjectionThreadProviderItemRepositoryShape {
  readonly upsert: (
    row: ProjectionThreadProviderItem,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadProviderItemsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadProviderItem>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadProviderItemsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadProviderItemRepository extends ServiceMap.Service<
  ProjectionThreadProviderItemRepository,
  ProjectionThreadProviderItemRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadProviderItems/ProjectionThreadProviderItemRepository",
) {}
