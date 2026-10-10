import { Data, Effect, ServiceMap } from "effect";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectDiscoverScriptsInput,
  ProjectDiscoverScriptsResult,
  ProjectListDirectoriesInput,
  ProjectListDirectoriesResult,
  ProjectPrewarmSearchIndexInput,
  ProjectPrewarmSearchIndexResult,
  ProjectResolveWorkspaceFileReferencesInput,
  ProjectResolveWorkspaceFileReferencesResult,
  ProjectSearchContentInput,
  ProjectSearchContentResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectSearchLocalEntriesInput,
  ProjectSearchLocalEntriesResult,
} from "@synara/contracts";

export interface WorkspaceEntriesShape {
  readonly browse: (
    input: FilesystemBrowseInput,
  ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesError>;
  readonly search: (
    input: ProjectSearchEntriesInput,
  ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
  readonly searchContent: (
    input: ProjectSearchContentInput,
  ) => Effect.Effect<ProjectSearchContentResult, WorkspaceEntriesError>;
  // fire-and-forget index warm-up; resolves before the build completes
  readonly prewarmSearchIndex: (
    input: ProjectPrewarmSearchIndexInput,
  ) => Effect.Effect<ProjectPrewarmSearchIndexResult, WorkspaceEntriesError>;
  readonly discoverScripts: (
    input: ProjectDiscoverScriptsInput,
  ) => Effect.Effect<ProjectDiscoverScriptsResult, WorkspaceEntriesError>;
  readonly listDirectories: (
    input: ProjectListDirectoriesInput,
  ) => Effect.Effect<ProjectListDirectoriesResult, WorkspaceEntriesError>;
  readonly searchLocal: (
    input: ProjectSearchLocalEntriesInput,
  ) => Effect.Effect<ProjectSearchLocalEntriesResult, WorkspaceEntriesError>;
  // resolve a bare/partial ref to a unique tracked file, null on zero/multiple matches
  readonly resolveFileBySuffix: (input: {
    readonly cwd: string;
    readonly relativePath: string;
  }) => Effect.Effect<string | null, WorkspaceEntriesError>;
  readonly resolveFileReferences: (
    input: ProjectResolveWorkspaceFileReferencesInput,
  ) => Effect.Effect<ProjectResolveWorkspaceFileReferencesResult, WorkspaceEntriesError>;
  readonly invalidate: (cwd: string) => Effect.Effect<void, never>;
}

export class WorkspaceEntries extends ServiceMap.Service<WorkspaceEntries, WorkspaceEntriesShape>()(
  "synara/workspace/Services/WorkspaceEntries",
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
