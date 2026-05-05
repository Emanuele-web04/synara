import { Effect, Schema, ServiceMap } from "effect";

export class WorkspaceRootNotExistsError extends Schema.TaggedErrorClass<WorkspaceRootNotExistsError>()(
  "WorkspaceRootNotExistsError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace root does not exist: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspaceRootCreateFailedError extends Schema.TaggedErrorClass<WorkspaceRootCreateFailedError>()(
  "WorkspaceRootCreateFailedError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to create workspace root: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspaceRootNotDirectoryError extends Schema.TaggedErrorClass<WorkspaceRootNotDirectoryError>()(
  "WorkspaceRootNotDirectoryError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace root is not a directory: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspacePathOutsideRootError extends Schema.TaggedErrorClass<WorkspacePathOutsideRootError>()(
  "WorkspacePathOutsideRootError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file path must be relative to the project root: ${this.relativePath}`;
  }
}

export interface WorkspacePathsShape {
  readonly normalizeWorkspaceRoot: (
    workspaceRoot: string,
    options?: { readonly createIfMissing?: boolean },
  ) => Effect.Effect<
    string,
    WorkspaceRootNotExistsError | WorkspaceRootCreateFailedError | WorkspaceRootNotDirectoryError
  >;
  readonly resolveRelativePathWithinRoot: (input: {
    readonly workspaceRoot: string;
    readonly relativePath: string;
  }) => Effect.Effect<
    { readonly absolutePath: string; readonly relativePath: string },
    WorkspacePathOutsideRootError
  >;
}

export class WorkspacePaths extends ServiceMap.Service<WorkspacePaths, WorkspacePathsShape>()(
  "t3/workspace/Services/WorkspacePaths",
) {}
