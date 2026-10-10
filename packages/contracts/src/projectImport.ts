import { Schema } from "effect";
import {
  IsoDateTime,
  MessageId,
  ProjectId,
  SpaceId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { ProviderInstanceId } from "./providerInstance";

export const ProjectImportProvider = Schema.Literals(["codex", "claudeAgent"]);
export type ProjectImportProvider = typeof ProjectImportProvider.Type;

export const ProjectImportThread = Schema.Struct({
  key: TrimmedNonEmptyString,
  provider: ProjectImportProvider,
  /** Account the conversation was found in and will be copied into. */
  providerInstanceId: Schema.optional(ProviderInstanceId),
  /** Display name of a non-default account; absent for the default account. */
  accountLabel: Schema.optional(Schema.String),
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
      providerInstanceId: Schema.optional(ProviderInstanceId),
      accountLabel: Schema.optional(Schema.String),
      error: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ListProjectImportsResult = typeof ListProjectImportsResult.Type;

// one item per request gives progress and cancellation between durable imports
// a null thread key links an empty project without creating a conversation
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

export const LoadProjectImportHistoryInput = Schema.Struct({
  threadId: ThreadId,
  /** Omit to inspect availability; echo the returned cursor to load one older page. */
  cursor: Schema.optional(TrimmedNonEmptyString),
});
export type LoadProjectImportHistoryInput = typeof LoadProjectImportHistoryInput.Type;

export const LoadProjectImportHistoryResult = Schema.Struct({
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
  messages: Schema.Array(
    Schema.Struct({
      messageId: MessageId,
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      createdAt: IsoDateTime,
      updatedAt: IsoDateTime,
    }),
  ),
});
export type LoadProjectImportHistoryResult = typeof LoadProjectImportHistoryResult.Type;
