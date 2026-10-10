import { createHash, randomUUID } from "node:crypto";
import { constants as NodeFsConstants, type BigIntStats } from "node:fs";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import { isLocalAbsolutePath } from "@synara/shared/path";
import { normalizeLineEndings } from "@synara/shared/text";
import { Effect, Layer, Path } from "effect";

import { resolveLocalPreviewGrantRealPath } from "../../localImageFiles";
import {
  WorkspaceFileConflictError,
  WorkspaceFileDeletedError,
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem";
import { WorkspaceEntries } from "../Services/WorkspaceEntries";
import { WorkspacePathOutsideRootError } from "../Services/WorkspacePaths";
import { WorkspacePaths } from "../Services/WorkspacePaths";
import {
  prepareRealPathForWriteWithinRoot,
  resolveRealPathForCreateWithinRoot,
  resolveRealPathWithinRoot,
} from "../realPathContainment";

const DEFAULT_READ_FILE_MAX_BYTES = 1_000_000;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function fileVersion(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function detectLineEnding(contents: string): "lf" | "crlf" | "cr" | "mixed" {
  const crlfCount = contents.match(/\r\n/g)?.length ?? 0;
  const lfCount = contents.match(/(?<!\r)\n/g)?.length ?? 0;
  const crCount = contents.match(/\r(?!\n)/g)?.length ?? 0;
  const styles = Number(crlfCount > 0) + Number(lfCount > 0) + Number(crCount > 0);
  if (styles > 1) return "mixed";
  if (crlfCount > 0) return "crlf";
  if (crCount > 0) return "cr";
  return "lf";
}

function encodeWorkspaceText(
  contents: string,
  encoding: "utf8" | "utf8-bom",
  lineEnding: "lf" | "crlf" | "cr",
): Buffer {
  const normalizedContents = normalizeLineEndings(contents);
  const encodedContents = Buffer.from(
    lineEnding === "lf"
      ? normalizedContents
      : normalizedContents.replaceAll("\n", lineEnding === "crlf" ? "\r\n" : "\r"),
    "utf8",
  );
  return encoding === "utf8-bom" ? Buffer.concat([UTF8_BOM, encodedContents]) : encodedContents;
}

function isBinaryLike(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

function isFileNotFoundError(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readCurrentFileVersion(
  workspaceRoot: string,
  filePath: string,
): Promise<{ readonly version: string; readonly stat: BigIntStats }> {
  const handle = await NodeFs.open(filePath, "r").catch((cause: unknown) => {
    if (isFileNotFoundError(cause)) {
      throw new WorkspaceFileDeletedError({ cwd: workspaceRoot, relativePath: filePath });
    }
    throw cause;
  });
  try {
    const beforeReadStat = await handle.stat({ bigint: true });
    const buffer = Buffer.alloc(DEFAULT_READ_FILE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const afterReadStat = await handle.stat({ bigint: true });
    const pathStat = await NodeFs.stat(filePath, { bigint: true }).catch((cause: unknown) => {
      if (isFileNotFoundError(cause)) {
        throw new WorkspaceFileDeletedError({ cwd: workspaceRoot, relativePath: filePath });
      }
      throw cause;
    });
    if (
      !afterReadStat.isFile() ||
      bytesRead > DEFAULT_READ_FILE_MAX_BYTES ||
      afterReadStat.size !== BigInt(bytesRead) ||
      !sameFileState(beforeReadStat, afterReadStat) ||
      !sameFileState(afterReadStat, pathStat)
    ) {
      throw new WorkspaceFileConflictError({ cwd: workspaceRoot, relativePath: filePath });
    }
    return { version: fileVersion(buffer.subarray(0, bytesRead)), stat: afterReadStat };
  } finally {
    await handle.close();
  }
}

async function writeFileAtomically(
  workspaceRoot: string,
  filePath: string,
  contents: Uint8Array,
  expectedVersion?: string,
): Promise<void> {
  const realRoot = await NodeFs.realpath(workspaceRoot);
  const targetStat = await NodeFs.stat(filePath).catch((cause: unknown) => {
    if (isFileNotFoundError(cause)) return null;
    throw cause;
  });
  if (expectedVersion !== undefined && targetStat === null) {
    throw new WorkspaceFileDeletedError({ cwd: workspaceRoot, relativePath: filePath });
  }
  if (expectedVersion !== undefined) {
    await NodeFs.access(filePath, NodeFsConstants.W_OK);
  }
  const mode = targetStat === null ? 0o666 : targetStat.mode & 0o777;
  const temporaryPath = NodePath.join(
    NodePath.dirname(filePath),
    `.${NodePath.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: NodeFs.FileHandle | undefined;
  let temporaryPathValidated = false;
  let temporaryIdentity: { readonly dev: number | bigint; readonly ino: number | bigint } | null =
    null;

  try {
    // O_EXCL prevents a pre-existing link at the temp name; O_NOFOLLOW is a POSIX extra Windows doesn't implement reliably
    const noFollow = process.platform === "win32" ? 0 : NodeFsConstants.O_NOFOLLOW;
    handle = await NodeFs.open(
      temporaryPath,
      NodeFsConstants.O_WRONLY | NodeFsConstants.O_CREAT | NodeFsConstants.O_EXCL | noFollow,
      mode,
    );
    const realTemporaryPath = await resolveRealPathWithinRoot(realRoot, temporaryPath);
    if (realTemporaryPath !== temporaryPath) {
      throw new Error("Temporary write path escaped the workspace root.");
    }
    temporaryPathValidated = true;
    const temporaryHandleStat = await handle.stat();
    const temporaryPathStat = await NodeFs.stat(realTemporaryPath);
    if (!temporaryHandleStat.isFile() || !temporaryPathStat.isFile()) {
      throw new Error("Workspace write temporary path is not a regular file.");
    }
    if (
      temporaryHandleStat.dev !== temporaryPathStat.dev ||
      temporaryHandleStat.ino !== temporaryPathStat.ino
    ) {
      throw new Error("Workspace write temporary path changed after open.");
    }
    temporaryIdentity = { dev: temporaryHandleStat.dev, ino: temporaryHandleStat.ino };
    if (targetStat !== null) {
      // open(2) filters the requested mode through umask — replacement writes must restore exact permission bits before rename
      await handle.chmod(mode);
    }
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;

    // no portable openat/renameat — re-check the parent right before rename to narrow the dir-swap race; don't weaken this as a substitute
    const realParent = await resolveRealPathWithinRoot(realRoot, NodePath.dirname(filePath));
    const realTemporaryPathBeforeRename = await resolveRealPathWithinRoot(realRoot, temporaryPath);
    const temporaryPathStatBeforeRename = await NodeFs.stat(temporaryPath);
    if (
      realParent !== NodePath.dirname(filePath) ||
      realTemporaryPathBeforeRename !== temporaryPath ||
      temporaryIdentity === null ||
      temporaryPathStatBeforeRename.dev !== temporaryIdentity.dev ||
      temporaryPathStatBeforeRename.ino !== temporaryIdentity.ino
    ) {
      throw new Error("Write target parent escaped the workspace root.");
    }
    if (expectedVersion !== undefined) {
      const current = await readCurrentFileVersion(workspaceRoot, filePath);
      if (current.version !== expectedVersion) {
        throw new WorkspaceFileConflictError({ cwd: workspaceRoot, relativePath: filePath });
      }
      const finalTargetStat = await NodeFs.stat(filePath, { bigint: true }).catch(
        (cause: unknown) => {
          if (isFileNotFoundError(cause)) {
            throw new WorkspaceFileDeletedError({ cwd: workspaceRoot, relativePath: filePath });
          }
          throw cause;
        },
      );
      if (!sameFileState(current.stat, finalTargetStat)) {
        throw new WorkspaceFileConflictError({ cwd: workspaceRoot, relativePath: filePath });
      }
    }
    await NodeFs.rename(temporaryPath, filePath);
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    if (temporaryPathValidated) {
      const realTemporaryPath = await resolveRealPathWithinRoot(realRoot, temporaryPath).catch(
        () => null,
      );
      if (realTemporaryPath === temporaryPath) {
        const temporaryPathStat = await NodeFs.stat(temporaryPath).catch(() => null);
        if (
          temporaryPathStat !== null &&
          temporaryIdentity !== null &&
          temporaryPathStat.dev === temporaryIdentity.dev &&
          temporaryPathStat.ino === temporaryIdentity.ino
        ) {
          await NodeFs.unlink(temporaryPath).catch(() => undefined);
        }
      }
    }
    throw cause;
  }
}

// resolved = inside root; outside = exists but escapes (rejected); missing = not found (index fallback)
type RealPathResolution =
  | { readonly status: "resolved"; readonly realPath: string }
  | { readonly status: "outside" }
  | { readonly status: "missing"; readonly cause: unknown };

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  // ENOENT surfaces as "missing" so callers can try the bare/partial fallback; other realpath failures still error
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

        // refs often carry only a basename/tail — fall back to a unique match in the tracked index; ambiguous names stay unresolved
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

      // the requested path (not its resolved target) decides symlink-ness so editors can refuse to write through links
      const symlink = yield* Effect.promise(() =>
        NodeFs.lstat(target.absolutePath).then(
          (stat) => stat.isSymbolicLink(),
          () => false,
        ),
      );

      // stat through the open handle so size and bytes come from the same file even if the path is swapped
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

      if (fileSize > bytes.length) {
        return {
          relativePath: target.relativePath,
          contents: bytes.toString("utf8"),
          truncated: true,
          version: null,
          encoding: null,
          lineEnding: null,
          symlink,
        };
      }

      const hasUtf8Bom = bytes.length >= UTF8_BOM.length && bytes.subarray(0, 3).equals(UTF8_BOM);
      const textBytes = hasUtf8Bom ? bytes.subarray(UTF8_BOM.length) : bytes;
      let decodedContents: string;
      try {
        decodedContents = new TextDecoder("utf-8", { fatal: true }).decode(textBytes);
      } catch (cause) {
        return yield* new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile",
          detail: "File encoding is not supported for text editing.",
          cause,
        });
      }
      const lineEnding = detectLineEnding(decodedContents);

      return {
        relativePath: target.relativePath,
        contents: normalizeLineEndings(decodedContents),
        truncated: false,
        version: fileVersion(bytes),
        encoding: hasUtf8Bom ? "utf8-bom" : "utf8",
        lineEnding,
        symlink,
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

    const guardedWrite = input.expectedVersion !== undefined;
    // saves that know the format re-encode, so unguarded overwrite keeps CRLF/BOM shape
    const textFormat =
      input.encoding !== undefined && input.lineEnding !== undefined && input.lineEnding !== "mixed"
        ? { encoding: input.encoding, lineEnding: input.lineEnding }
        : null;
    if (guardedWrite && textFormat === null) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation: "workspaceFileSystem.writeFile",
        detail: "Guarded text saves require a supported encoding and consistent line endings.",
      });
    }
    const bytes = textFormat
      ? encodeWorkspaceText(input.contents, textFormat.encoding, textFormat.lineEnding)
      : Buffer.from(input.contents, "utf8");
    if (guardedWrite && bytes.length > DEFAULT_READ_FILE_MAX_BYTES) {
      return yield* new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation: "workspaceFileSystem.writeFile",
        detail: "The edited file is too large to save from Explorer.",
      });
    }

    yield* Effect.tryPromise({
      try: async () => {
        const initialRealTarget = guardedWrite
          ? await resolveRealPathWithinRoot(input.cwd, target.absolutePath).catch(
              (cause: unknown) => {
                if (isFileNotFoundError(cause)) {
                  throw new WorkspaceFileDeletedError({
                    cwd: input.cwd,
                    relativePath: input.relativePath,
                  });
                }
                throw cause;
              },
            )
          : await prepareRealPathForWriteWithinRoot(input.cwd, target.absolutePath);
        if (initialRealTarget === null) {
          return "outside" as const;
        }

        // re-resolve after parent creation so concurrently introduced links get canonicalized
        const finalRealTarget = await resolveRealPathForCreateWithinRoot(
          input.cwd,
          target.absolutePath,
        );
        if (finalRealTarget === null) {
          return "outside" as const;
        }

        await writeFileAtomically(input.cwd, finalRealTarget, bytes, input.expectedVersion);
        return "written" as const;
      },
      catch: (cause) => {
        if (
          cause instanceof WorkspaceFileConflictError ||
          cause instanceof WorkspaceFileDeletedError
        ) {
          return cause;
        }
        return new WorkspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.writeFile",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        });
      },
    }).pipe(
      Effect.flatMap((result) =>
        result === "outside"
          ? Effect.fail(
              new WorkspacePathOutsideRootError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
              }),
            )
          : Effect.void,
      ),
    );
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath, version: fileVersion(bytes) };
  });

  return { readFile, writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
