import * as NodeFs from "node:fs/promises";

import { isLocalAbsolutePath } from "@synara/shared/path";
import { Effect, FileSystem, Layer, Path } from "effect";

import { resolveLocalPreviewGrantRealPath } from "../../localImageFiles";
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

function isFileNotFoundError(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

// Outcome of canonicalizing a requested path against the workspace root:
// "resolved" means the file exists inside the root, "outside" means it exists
// but escapes the root (rejected), and "missing" means it does not exist (so a
// bare/partial reference can fall back to the workspace index).
type RealPathResolution =
  | { readonly status: "resolved"; readonly realPath: string }
  | { readonly status: "outside" }
  | { readonly status: "missing"; readonly cause: unknown };

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  // Canonicalize a workspace-relative path and classify the outcome. ENOENT is
  // surfaced as "missing" (not a hard failure) so callers can attempt the
  // bare/partial-reference fallback; other realpath failures still error.
  const resolveInRootRealPath = (relativePath: string, absolutePath: string, cwd: string) =>
    Effect.tryPromise({
      try: async (): Promise<RealPathResolution> => {
        try {
          const realPath = await resolveRealPathWithinRoot(cwd, absolutePath);
          return realPath === null ? { status: "outside" } : { status: "resolved", realPath };
        } catch (cause) {
          if (isFileNotFoundError(cause)) {
            return { status: "missing", cause };
          }
          throw cause;
        }
      },
      catch: (cause) =>
        new WorkspaceFileSystemError({
          cwd,
          relativePath,
          operation: "workspaceFileSystem.realpath",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

  const resolveAbsoluteRealPath = (filePath: string, cwd: string) =>
    Effect.tryPromise({
      try: () => NodeFs.realpath(filePath),
      catch: (cause) =>
        new WorkspaceFileSystemError({
          cwd,
          relativePath: filePath,
          operation: "workspaceFileSystem.realpath",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const maxBytes = input.maxBytes ?? DEFAULT_READ_FILE_MAX_BYTES;
      const requestedPath = input.relativePath.trim();

      let target: { absolutePath: string; relativePath: string };
      let realPath: string;

      if (
        isLocalAbsolutePath(requestedPath, {
          allowWindowsPaths: process.platform === "win32",
        })
      ) {
        const grantedRealPath = resolveLocalPreviewGrantRealPath({ token: input.previewGrant });
        if (!grantedRealPath) {
          return yield* new WorkspacePathOutsideRootError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
          });
        }
        target = {
          absolutePath: path.resolve(requestedPath),
          relativePath: requestedPath,
        };
        realPath = yield* resolveAbsoluteRealPath(target.absolutePath, input.cwd);
        if (realPath !== grantedRealPath) {
          return yield* new WorkspacePathOutsideRootError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
          });
        }
      } else {
        target = yield* workspacePaths.resolveRelativePathWithinRoot({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
        });
        let resolution = yield* resolveInRootRealPath(
          input.relativePath,
          target.absolutePath,
          input.cwd,
        );

        // References often carry only a file's basename or a partial tail (e.g.
        // `chatReferences.test.ts` for `apps/web/src/lib/chatReferences.test.ts`),
        // which resolves to a non-existent path under the root. Fall back to a
        // unique match in the tracked workspace index so the in-app viewer can
        // still open it; ambiguous names stay unresolved and surface the error.
        if (resolution.status === "missing") {
          const fallbackRelativePath = yield* workspaceEntries
            .resolveFileBySuffix({ cwd: input.cwd, relativePath: input.relativePath })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new WorkspaceFileSystemError({
                    cwd: input.cwd,
                    relativePath: input.relativePath,
                    operation: "workspaceFileSystem.realpath",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          if (fallbackRelativePath !== null) {
            target = yield* workspacePaths.resolveRelativePathWithinRoot({
              workspaceRoot: input.cwd,
              relativePath: fallbackRelativePath,
            });
            resolution = yield* resolveInRootRealPath(
              fallbackRelativePath,
              target.absolutePath,
              input.cwd,
            );
          }
        }

        if (resolution.status === "missing") {
          return yield* new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.realpath",
            detail:
              resolution.cause instanceof Error
                ? resolution.cause.message
                : String(resolution.cause),
            cause: resolution.cause,
          });
        }
        if (resolution.status === "outside") {
          return yield* new WorkspacePathOutsideRootError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
          });
        }
        realPath = resolution.realPath;
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
