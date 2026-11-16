// FILE: projectWorkspaceRoot.ts
// Purpose: Canonicalize a user-supplied project folder the same way for every
//          entry point (WS dispatch, external MCP) so stored roots always agree.
// Layer: Server utility
// Exports: canonicalizeProjectWorkspaceRoot, ProjectWorkspaceRootError

import { Data, Effect, FileSystem, Path } from "effect";

import { realpathNearestExisting } from "./realpathNearestExisting";

export class ProjectWorkspaceRootError extends Data.TaggedError("ProjectWorkspaceRootError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Expands `~`, resolves, optionally creates, requires a directory, and returns its realpath. */
export const canonicalizeProjectWorkspaceRoot = Effect.fnUntraced(function* (input: {
  readonly homeDir: string;
  readonly workspaceRoot: string;
  readonly createIfMissing?: boolean;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rawWorkspaceRoot = input.workspaceRoot.trim();
  const expandedWorkspaceRoot =
    rawWorkspaceRoot === "~"
      ? input.homeDir
      : rawWorkspaceRoot.startsWith("~/") || rawWorkspaceRoot.startsWith("~\\")
        ? path.join(input.homeDir, rawWorkspaceRoot.slice(2))
        : rawWorkspaceRoot;
  const normalizedWorkspaceRoot = path.resolve(expandedWorkspaceRoot);
  let workspaceStat = yield* fileSystem
    .stat(normalizedWorkspaceRoot)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!workspaceStat) {
    if (!input.createIfMissing) {
      return yield* new ProjectWorkspaceRootError({
        message: `Project directory does not exist: ${normalizedWorkspaceRoot}`,
      });
    }
    yield* fileSystem.makeDirectory(normalizedWorkspaceRoot, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectWorkspaceRootError({
            message: `Failed to create project directory: ${normalizedWorkspaceRoot}`,
            cause,
          }),
      ),
    );
    workspaceStat = yield* fileSystem
      .stat(normalizedWorkspaceRoot)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!workspaceStat) {
      return yield* new ProjectWorkspaceRootError({
        message: `Failed to create project directory: ${normalizedWorkspaceRoot}`,
      });
    }
  }
  if (workspaceStat.type !== "Directory") {
    return yield* new ProjectWorkspaceRootError({
      message: `Project path is not a directory: ${normalizedWorkspaceRoot}`,
    });
  }
  return yield* realpathNearestExisting(normalizedWorkspaceRoot);
});
