// Discover host-owned Git preview roots for RPC recovery and durable image ingestion.
// GitCore owns subprocess admission/cancellation; no client-supplied parent allowlist
// or per-image Git process is needed by callers that batch their references.
import fs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";

import { GitCore } from "../git/Services/GitCore";
import { isContainedPath } from "./realPathContainment";

async function realpathOrNull(candidate: string): Promise<string | null> {
  return fs.realpath(candidate).catch(() => null);
}

// Missing files still use the existing bounded reference recovery. Query Git only
// for existing targets outside cwd, or when a caller's lazy reader requests roots.
export function listLocalPreviewWorktreeRoots(input: {
  readonly cwd: string;
  readonly requestedPaths?: readonly string[];
}): Effect.Effect<readonly string[], never, GitCore> {
  return Effect.gen(function* () {
    const realCwd = yield* Effect.tryPromise(() => fs.realpath(input.cwd));
    const requestedPaths = input.requestedPaths;
    if (requestedPaths !== undefined) {
      const outside = yield* Effect.tryPromise(async () => {
        const candidates = await Promise.all(
          requestedPaths.map(async (requestedPath) => {
            const candidate = path.resolve(realCwd, requestedPath);
            const realTarget = await realpathOrNull(candidate);
            return (
              realTarget !== null &&
              (!isContainedPath(realCwd, candidate) || !isContainedPath(realCwd, realTarget))
            );
          }),
        );
        return candidates.some(Boolean);
      });
      if (!outside) return [];
    }
    const git = yield* GitCore;
    const result = yield* git.execute({
      operation: "localPreview.worktrees",
      cwd: realCwd,
      args: ["worktree", "list", "--porcelain", "-z"],
      timeoutMs: 5_000,
      maxOutputBytes: 256 * 1024,
    });
    const roots = yield* Effect.tryPromise(async () => {
      const candidates = result.stdout
        .split("\0\0")
        .map((record) => record.split("\0"))
        .filter((record) => !record.some((field) => field.startsWith("prunable")))
        .flatMap((record) => record.filter((field) => field.startsWith("worktree ")))
        .map((field) => field.slice("worktree ".length));
      const canonical = await Promise.all(
        candidates.map(async (candidate) => {
          if (!path.isAbsolute(candidate)) return null;
          const root = await realpathOrNull(candidate);
          return root && (await fs.stat(root).catch(() => null))?.isDirectory() ? root : null;
        }),
      );
      return canonical.filter((root): root is string => root !== null);
    });
    // A .git pointer on an unregistered directory cannot borrow another repo's roots.
    return roots.some((root) => isContainedPath(root, realCwd)) ? roots : [];
  }).pipe(Effect.catch(() => Effect.succeed([] as readonly string[])));
}
