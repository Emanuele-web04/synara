/** callers supply canonical repository values — this service owns persistence only, never derives identity */
import { PositiveInt, ProjectId, TrimmedNonEmptyString } from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

/** a pin list is a small "what next" queue, not a second backlog — the cap in the persistence layer keeps it durable across every caller */
export const PROJECT_PULL_REQUEST_PIN_LIMIT = 20;

export class ProjectPullRequestPinLimitError extends Schema.TaggedErrorClass<ProjectPullRequestPinLimitError>()(
  "ProjectPullRequestPinLimitError",
  {
    projectId: ProjectId,
    limit: PositiveInt,
  },
) {
  override get message(): string {
    return `A project can pin at most ${this.limit} pull requests.`;
  }
}

export type ProjectPullRequestPinsError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | ProjectPullRequestPinLimitError;

export const ProjectPullRequestPin = Schema.Struct({
  projectId: ProjectId,
  repositoryKey: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type ProjectPullRequestPin = typeof ProjectPullRequestPin.Type;

export const ListProjectPullRequestPinsByProjectIdsInput = Schema.Struct({
  projectIds: Schema.Array(ProjectId),
});
export type ListProjectPullRequestPinsByProjectIdsInput =
  typeof ListProjectPullRequestPinsByProjectIdsInput.Type;

export const SetProjectPullRequestPinnedInput = Schema.Struct({
  projectId: ProjectId,
  repositoryKey: TrimmedNonEmptyString,
  number: PositiveInt,
  isPinned: Schema.Boolean,
});
export type SetProjectPullRequestPinnedInput = typeof SetProjectPullRequestPinnedInput.Type;

export interface ProjectPullRequestPinsShape {
  /** pins for exactly the requested projects in deterministic order */
  readonly listByProjectIds: (
    input: ListProjectPullRequestPinsByProjectIdsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectPullRequestPin>, ProjectPullRequestPinsError>;

  readonly setPinned: (
    input: SetProjectPullRequestPinnedInput,
  ) => Effect.Effect<void, ProjectPullRequestPinsError>;
}

export class ProjectPullRequestPins extends ServiceMap.Service<
  ProjectPullRequestPins,
  ProjectPullRequestPinsShape
>()("synara/persistence/Services/ProjectPullRequestPins/ProjectPullRequestPins") {}
