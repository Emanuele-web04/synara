import { Data, Effect, ServiceMap } from "effect";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectListDirectoriesInput,
  ProjectListDirectoriesResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectSearchLocalEntriesInput,
  ProjectSearchLocalEntriesResult,
} from "@t3tools/contracts";

export interface WorkspaceEntriesShape {
  readonly browse: (
    input: FilesystemBrowseInput,
  ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesError>;
  readonly search: (
    input: ProjectSearchEntriesInput,
  ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
  readonly listDirectories: (
    input: ProjectListDirectoriesInput,
  ) => Effect.Effect<ProjectListDirectoriesResult, WorkspaceEntriesError>;
  readonly searchLocal: (
    input: ProjectSearchLocalEntriesInput,
  ) => Effect.Effect<ProjectSearchLocalEntriesResult, WorkspaceEntriesError>;
  readonly invalidate: (cwd: string) => Effect.Effect<void, never>;
}

export class WorkspaceEntries extends ServiceMap.Service<WorkspaceEntries, WorkspaceEntriesShape>()(
  "t3/workspace/Services/WorkspaceEntries",
) {}

export class WorkspaceEntriesError extends Data.TaggedError("WorkspaceEntriesError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function toWorkspaceEntriesError(operation: string, cause: unknown): WorkspaceEntriesError {
  return new WorkspaceEntriesError({
    message: cause instanceof Error ? cause.message : `Failed to ${operation}: ${String(cause)}`,
    cause,
  });
}
