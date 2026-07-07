// FILE: realpathNearestExisting.ts
// Purpose: Shared realpath canonicalization for filesystem paths that may not
//          exist yet (e.g. a workspace root created lazily on first use).
// Layer: Server utility (Effect-based; requires FileSystem.FileSystem + Path.Path)
// Exports: realpathNearestExisting
//
// Used by:
//  - config.ts, to canonicalize homeDir/chatWorkspaceRoot/studioWorkspaceRoot so
//    the roots the server reports match what project rows store (see
//    wsRpc.ts's canonicalizeProjectWorkspaceRoot, which canonicalizes project
//    workspace roots the same way once they exist on disk).
//  - wsRpc.ts, to canonicalize project workspace roots after they are
//    confirmed to exist (or freshly created).

import { Effect, FileSystem, Path } from "effect";

/**
 * Canonicalize `inputPath` via realpath, resolving symlinks anywhere along an
 * existing prefix of the path. When the path (or its trailing segments)
 * doesn't exist yet, walk up to the nearest existing ancestor, realpath
 * *that*, then re-append the non-existing remainder untouched.
 *
 * This keeps the result stable for paths that are created lazily after the
 * fact (e.g. the Studio workspace root, or a project workspace root prior to
 * being scaffolded) while still matching what `realpath` will return once the
 * directory exists — which is exactly what stored/reported roots must agree
 * on for downstream classifiers (`isStudioContainerProject`,
 * `isHomeChatContainerProject`, etc.) to compare correctly.
 */
export const realpathNearestExisting = Effect.fn(function* (
  inputPath: string,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;

  const resolvedInput = path.resolve(inputPath);
  const missingSegments: Array<string> = [];
  let candidate = resolvedInput;

  while (true) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      const real = yield* fileSystem
        .realPath(candidate)
        .pipe(Effect.orElseSucceed(() => candidate));
      return missingSegments.length > 0 ? path.join(real, ...missingSegments) : real;
    }

    const parent = path.dirname(candidate);
    if (parent === candidate) {
      // Reached the filesystem root without finding an existing ancestor;
      // nothing left to canonicalize, so return the resolved input as-is.
      return resolvedInput;
    }
    missingSegments.unshift(path.basename(candidate));
    candidate = parent;
  }
});
