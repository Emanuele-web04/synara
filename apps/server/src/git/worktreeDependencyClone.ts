import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

import { runProcess } from "../processRunner.ts";

/**
 * Copy-on-write dependency seeding for new worktrees.
 *
 * A fresh worktree has no `node_modules`, so every agent workspace starts by
 * reinstalling dependencies. On APFS a whole directory tree can be cloned in a
 * single `clonefile(2)` call: the clone shares disk blocks with the source and
 * only diverges where a file is later written, so seeding a multi-gigabyte
 * `node_modules` takes about as long as one syscall and almost no disk.
 *
 * Seeding is best effort and conservative:
 * - macOS only. Node cannot clone directories (`copyFile` returns ENOSYS) and
 *   per-file clones (`cp -c`, `ditto --clone`) are slower than a warm install,
 *   so the one-call directory clone runs through JXA, which ships with macOS.
 * - Only when every tracked lockfile in the new worktree is byte-identical to
 *   the source checkout's, so the cloned tree matches what the branch expects.
 * - Never replaces an existing directory, and never fails worktree creation:
 *   callers treat the result as a hint and fall back to today's behaviour.
 */

export const DEPENDENCY_LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

/** Git pathspecs that list the manifests and lockfiles this module reads. */
export const DEPENDENCY_CLONE_PATHSPECS: ReadonlyArray<string> = [
  ":(glob)**/package.json",
  ...[...DEPENDENCY_LOCKFILE_NAMES].map((name) => `:(glob)**/${name}`),
];

const DEPENDENCY_DIRECTORY_NAME = "node_modules";
// Tool caches inside node_modules may key entries by absolute path. They are
// rebuilt on demand, so the clone drops them rather than reuse stale entries.
const CLONED_CACHE_DIRECTORIES = [".cache", ".vite"];
const MAX_CLONED_DIRECTORIES = 256;
// A directory clone of a multi-gigabyte node_modules takes about two seconds.
// Some callers create worktrees in uninterruptible regions or under the
// repository's mutation lock, so a stuck helper must give up quickly.
const CLONE_TIMEOUT_MS = 30_000;

export interface DependencyClonePair {
  readonly source: string;
  readonly target: string;
}

export type DependencyClonePlan =
  | { readonly kind: "clone"; readonly pairs: ReadonlyArray<DependencyClonePair> }
  | {
      readonly kind: "skip";
      readonly reason: "no-lockfile" | "lockfile-mismatch" | "nothing-to-clone";
    };

export type DependencyCloneResult =
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "cloned"; readonly cloned: number; readonly failed: number };

export type CloneDirectories = (
  pairs: ReadonlyArray<DependencyClonePair>,
  signal?: AbortSignal,
) => Promise<ReadonlyArray<boolean>>;

const isInsideDependencyDirectory = (relativePath: string): boolean =>
  relativePath.split("/").includes(DEPENDENCY_DIRECTORY_NAME);

const readFileOrNull = (filePath: string): Promise<Buffer | null> =>
  nodeFs.readFile(filePath).catch(() => null);

const lstatOrNull = (filePath: string) => nodeFs.lstat(filePath).catch(() => null);

/**
 * Decide which dependency directories to clone. `trackedPaths` are the
 * worktree's tracked manifests and lockfiles, relative and `/`-separated, as
 * listed by `git ls-files` with {@link DEPENDENCY_CLONE_PATHSPECS}.
 */
export async function planDependencyClones(input: {
  readonly sourceRoot: string;
  readonly worktreeRoot: string;
  readonly trackedPaths: ReadonlyArray<string>;
}): Promise<DependencyClonePlan> {
  const tracked = input.trackedPaths.filter((entry) => !isInsideDependencyDirectory(entry));
  const lockfiles = tracked.filter((entry) =>
    DEPENDENCY_LOCKFILE_NAMES.has(nodePath.posix.basename(entry)),
  );
  if (lockfiles.length === 0) return { kind: "skip", reason: "no-lockfile" };

  for (const lockfile of lockfiles) {
    const [source, target] = await Promise.all([
      readFileOrNull(nodePath.join(input.sourceRoot, lockfile)),
      readFileOrNull(nodePath.join(input.worktreeRoot, lockfile)),
    ]);
    if (source === null || target === null || !source.equals(target)) {
      return { kind: "skip", reason: "lockfile-mismatch" };
    }
  }

  const packageDirectories = [
    ...new Set(
      tracked
        .filter((entry) => nodePath.posix.basename(entry) === "package.json")
        .map((entry) => nodePath.posix.dirname(entry)),
    ),
  ].toSorted();

  const pairs: DependencyClonePair[] = [];
  for (const directory of packageDirectories) {
    if (pairs.length >= MAX_CLONED_DIRECTORIES) break;
    const source = nodePath.join(input.sourceRoot, directory, DEPENDENCY_DIRECTORY_NAME);
    const target = nodePath.join(input.worktreeRoot, directory, DEPENDENCY_DIRECTORY_NAME);
    const [sourceEntry, targetEntry] = await Promise.all([
      lstatOrNull(source),
      lstatOrNull(target),
    ]);
    // A symlinked node_modules would clone the link, not the tree, and an
    // existing target belongs to someone else.
    if (sourceEntry?.isDirectory() && targetEntry === null) {
      pairs.push({ source, target });
    }
  }

  return pairs.length > 0 ? { kind: "clone", pairs } : { kind: "skip", reason: "nothing-to-clone" };
}

// One osascript launch clones every pair. `clonefile` with flags 0 refuses an
// existing destination and clones the whole tree atomically per directory.
const JXA_CLONE_DIRECTORIES = `
function run(argv) {
  ObjC.bindFunction("clonefile", ["int", ["char *", "char *", "unsigned int"]]);
  var results = [];
  for (var index = 0; index + 1 < argv.length; index += 2) {
    results.push($.clonefile(argv[index], argv[index + 1], 0) === 0);
  }
  return JSON.stringify(results);
}
`;

/** Clone directories with APFS `clonefile(2)`; one boolean per pair. */
export const cloneDirectoriesWithClonefile: CloneDirectories = async (pairs, signal) => {
  const result = await runProcess(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      JXA_CLONE_DIRECTORIES,
      ...pairs.flatMap((pair) => [pair.source, pair.target]),
    ],
    { timeoutMs: CLONE_TIMEOUT_MS, ...(signal ? { signal } : {}) },
  );
  const parsed: unknown = JSON.parse(result.stdout.trim());
  if (
    !Array.isArray(parsed) ||
    parsed.length !== pairs.length ||
    !parsed.every((entry) => typeof entry === "boolean")
  ) {
    throw new Error("clonefile helper returned an unexpected result.");
  }
  return parsed;
};

/**
 * Seed a new worktree's dependency directories from the checkout it was
 * created from. Resolves with what happened; rejects only on unexpected
 * failures, which callers log and ignore.
 */
export async function cloneWorktreeDependencies(input: {
  readonly sourceRoot: string;
  readonly worktreeRoot: string;
  readonly trackedPaths: ReadonlyArray<string>;
  readonly cloneDirectories?: CloneDirectories;
  readonly signal?: AbortSignal;
}): Promise<DependencyCloneResult> {
  const plan = await planDependencyClones(input);
  if (plan.kind === "skip") return { kind: "skipped", reason: plan.reason };

  const cloneDirectories = input.cloneDirectories ?? cloneDirectoriesWithClonefile;
  let outcomes: ReadonlyArray<boolean>;
  try {
    outcomes = await cloneDirectories(plan.pairs, input.signal);
  } catch (cause) {
    // Some clones may have landed before the helper failed or was cancelled.
    // Every target was absent beforehand, so removing them restores the
    // worktree to its pre-seeding state.
    await Promise.all(
      plan.pairs.map((pair) => nodeFs.rm(pair.target, { recursive: true, force: true })),
    );
    throw cause;
  }

  let cloned = 0;
  await Promise.all(
    plan.pairs.map(async (pair, index) => {
      if (outcomes[index]) {
        cloned += 1;
        await Promise.all(
          CLONED_CACHE_DIRECTORIES.map((cache) =>
            nodeFs.rm(nodePath.join(pair.target, cache), { recursive: true, force: true }),
          ),
        );
      } else {
        await nodeFs.rm(pair.target, { recursive: true, force: true });
      }
    }),
  );
  return { kind: "cloned", cloned, failed: plan.pairs.length - cloned };
}
