import * as NodeFs from "node:fs/promises";

import { Effect, FileSystem, Layer, Path } from "effect";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem";
import { WorkspaceEntries } from "../Services/WorkspaceEntries";
import { WorkspacePathOutsideRootError } from "../Services/WorkspacePaths";
import { WorkspacePaths } from "../Services/WorkspacePaths";
import { resolveRealPathWithinRoot } from "../realPathContainment";

const DEFAULT_READ_FILE_MAX_BYTES = 1_000_000;

function isBinaryLike(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
      const maxBytes = input.maxBytes ?? DEFAULT_READ_FILE_MAX_BYTES;

      const realPath = yield* Effect.tryPromise({
        try: () => resolveRealPathWithinRoot(input.cwd, target.absolutePath),
        catch: (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.realpath",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      if (realPath === null) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
        });
      }

      // Stat through the open handle so the size and the bytes come from the
      // same file even if the path is swapped between the two calls.
      const { bytes, fileSize } = yield* Effect.tryPromise({
        try: async () => {
          const handle = await NodeFs.open(realPath, "r");
          try {
            const fileInfo = await handle.stat();
            if (!fileInfo.isFile()) {
              throw new Error("Path is not a file.");
            }
            const readLength = Math.min(fileInfo.size, maxBytes);
            if (readLength === 0) {
              return { bytes: Buffer.alloc(0), fileSize: fileInfo.size };
            }
            const buffer = Buffer.alloc(readLength);
            const { bytesRead } = await handle.read(buffer, 0, readLength, 0);
            return { bytes: buffer.subarray(0, bytesRead), fileSize: fileInfo.size };
          } finally {
            await handle.close();
          }
        },
        catch: (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.readFile",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });

      if (isBinaryLike(bytes)) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile",
          detail: "File appears to be binary.",
        });
      }

      return {
        relativePath: target.relativePath,
        contents: bytes.toString("utf8"),
        truncated: fileSize > bytes.length,
      };
    },
  );

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });

  return { readFile, writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
