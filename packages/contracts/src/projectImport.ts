import { Schema } from "effect";
import { IsoDateTime, ProjectId, SpaceId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

export const ProjectImportProvider = Schema.Literals(["codex", "claudeAgent"]);
export type ProjectImportProvider = typeof ProjectImportProvider.Type;

export const ProjectImportThread = Schema.Struct({
  key: TrimmedNonEmptyString,
  provider: ProjectImportProvider,
  title: Schema.String,
  cwd: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archived: Schema.Boolean,
  alreadyImported: Schema.Boolean,
});
export type ProjectImportThread = typeof ProjectImportThread.Type;

export const ProjectImportProject = Schema.Struct({
  key: TrimmedNonEmptyString,
  title: Schema.String,
  workspaceRoot: Schema.String,
  directoryExists: Schema.Boolean,
  existingProjectId: Schema.NullOr(ProjectId),
  providers: Schema.Array(ProjectImportProvider),
  threads: Schema.Array(ProjectImportThread),
});
export type ProjectImportProject = typeof ProjectImportProject.Type;

export const ListProjectImportsInput = Schema.Struct({
  providers: Schema.Array(ProjectImportProvider),
});
export type ListProjectImportsInput = typeof ListProjectImportsInput.Type;

export const ListProjectImportsResult = Schema.Struct({
  projects: Schema.Array(ProjectImportProject),
  sources: Schema.Array(
    Schema.Struct({
      provider: ProjectImportProvider,
      error: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ListProjectImportsResult = typeof ListProjectImportsResult.Type;

// One item per request gives progress and cancellation between durable imports.
// A null thread key links an empty project without creating any conversation.
export const ImportProjectInput = Schema.Struct({
  projectKey: TrimmedNonEmptyString,
  threadKey: Schema.NullOr(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  spaceId: Schema.optional(Schema.NullOr(SpaceId)),
});
export type ImportProjectInput = typeof ImportProjectInput.Type;

export const ImportProjectResult = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  status: Schema.Literals(["imported", "already-present", "project-linked"]),
});
export type ImportProjectResult = typeof ImportProjectResult.Type;
