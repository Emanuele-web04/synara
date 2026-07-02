import { Effect, Schema, ServiceMap } from "effect";

import type {
  ProjectApplyStyleEditInput,
  ProjectApplyStyleEditResult,
  ProjectApplyTextEditInput,
  ProjectApplyTextEditResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import { WorkspacePathOutsideRootError } from "./WorkspacePaths";

export class WorkspaceFileSystemError extends Schema.TaggedErrorClass<WorkspaceFileSystemError>()(
  "WorkspaceFileSystemError",
  {
    cwd: Schema.String,
    relativePath: Schema.optional(Schema.String),
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `${this.operation} failed for ${this.cwd}: ${this.detail}`;
  }
}

export interface WorkspaceFileSystemShape {
  readonly readFile: (
    input: ProjectReadFileInput,
  ) => Effect.Effect<
    ProjectReadFileResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
  readonly writeFile: (
    input: ProjectWriteFileInput,
  ) => Effect.Effect<
    ProjectWriteFileResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
  readonly applyTextEdit: (
    input: ProjectApplyTextEditInput,
  ) => Effect.Effect<ProjectApplyTextEditResult, WorkspaceFileSystemError>;
  readonly applyStyleEdit: (
    input: ProjectApplyStyleEditInput,
  ) => Effect.Effect<ProjectApplyStyleEditResult, WorkspaceFileSystemError>;
}

export class WorkspaceFileSystem extends ServiceMap.Service<
  WorkspaceFileSystem,
  WorkspaceFileSystemShape
>()("t3/workspace/Services/WorkspaceFileSystem") {}
