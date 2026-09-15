import { Schema } from "effect";

import { CommandId, IsoDateTime, ProjectId, SpaceId, TrimmedNonEmptyString } from "./baseSchemas";
import { ModelSelection } from "./orchestration";

const BoundedRepositoryInput = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const BoundedPath = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));
const BoundedDirectoryName = TrimmedNonEmptyString.check(Schema.isMaxLength(255));

/**
 * One server-owned repository checkout + project-registration operation.
 *
 * `destinationParent` is deliberately a parent directory. The server derives and
 * validates the final workspace root from it and `directoryName`, so the UI never
 * presents a parent path while the server interprets it as the clone target.
 */
export const ProjectProvisionInput = Schema.Struct({
  operationId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  host: Schema.Literals(["github", "gitlab"]),
  repository: BoundedRepositoryInput,
  destinationParent: BoundedPath,
  directoryName: BoundedDirectoryName,
  commandId: CommandId,
  projectId: ProjectId,
  /** Destination for a newly registered project; reusing an existing project preserves its Space. */
  newProjectSpaceId: Schema.NullOr(SpaceId),
  defaultModelSelection: ModelSelection,
  createdAt: IsoDateTime,
});
export type ProjectProvisionInput = typeof ProjectProvisionInput.Type;

export const ProjectProvisionResult = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  projectId: ProjectId,
  checkout: Schema.Literals(["created", "reused"]),
});
export type ProjectProvisionResult = typeof ProjectProvisionResult.Type;

export const ProjectProvisionPhase = Schema.Literals([
  "validating",
  "resolving-access",
  "cloning",
  "verifying",
  "registering",
]);
export type ProjectProvisionPhase = typeof ProjectProvisionPhase.Type;

const GitHubProjectProvisionProgressBase = Schema.Struct({
  operationId: TrimmedNonEmptyString,
});

export const ProjectProvisionProgressEvent = Schema.Union([
  Schema.Struct({
    ...GitHubProjectProvisionProgressBase.fields,
    kind: Schema.Literal("phase"),
    phase: ProjectProvisionPhase,
    message: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...GitHubProjectProvisionProgressBase.fields,
    kind: Schema.Literal("clone-progress"),
    phase: Schema.Literal("cloning"),
    message: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...GitHubProjectProvisionProgressBase.fields,
    kind: Schema.Literal("completed"),
    result: ProjectProvisionResult,
  }),
]);
export type ProjectProvisionProgressEvent = typeof ProjectProvisionProgressEvent.Type;
