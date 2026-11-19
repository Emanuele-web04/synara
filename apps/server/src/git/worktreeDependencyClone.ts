// FILE: worktreeDependencyClone.ts
// Purpose: Plan and safely publish APFS dependency snapshots for new Git worktrees.
import { constants as fsConstants } from "node:fs";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

import { runProcess } from "../processRunner.ts";
import { isContainedPath } from "../workspace/realPathContainment.ts";

/**
 * Copy-on-write dependency seeding for new worktrees.
 *
 * A fresh worktree has no `node_modules`, so every agent workspace starts by
 * reinstalling dependencies. On APFS a whole directory tree can be cloned in a
 * single `clonefile(2)` call: the clone shares disk blocks with the source and
 * only diverges where a file is later written, so this avoids recopying file data.
 *
 * Seeding is best effort and conservative:
 * - macOS only. Node cannot clone directories (`copyFile` returns ENOSYS) and
 *   per-file clones (`cp -c`, `ditto --clone`) are slower than a warm install,
 *   so the one-call directory clone runs through JXA, which ships with macOS.
 * - Only when every tracked lockfile in the new worktree is byte-identical to
 *   the source checkout's, so the cloned tree matches what the branch expects.
 * - Only publishes to Git-ignored paths. Links that cannot move safely skip a tree.
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
const MAX_LOCKFILES = 256;
const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_LOCKFILE_BYTES = 32 * 1024 * 1024;
// The worktree creation lock covers seeding, so its subprocesses share one deadline.
const SEED_TIMEOUT_MS = 30_000;

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

const lstatOrNull = (filePath: string) => nodeFs.lstat(filePath).catch(() => null);

async function hasPhysicalParent(filePath: string): Promise<boolean> {
  const parent = nodePath.dirname(filePath);
  return (await nodeFs.realpath(parent).catch(() => null)) === parent;
}

// Read from a checked descriptor with a fixed upper bound, including if the file grows.
async function readLockfile(filePath: string, maxBytes: number): Promise<Buffer | null> {
  if (!(await hasPhysicalParent(filePath)) || !(await lstatOrNull(filePath))?.isFile()) return null;
  try {
    const file = await nodeFs.open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) return null;

      const data = Buffer.allocUnsafe(stat.size + 1);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return offset === stat.size ? data.subarray(0, offset) : null;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

/**
 * Decide which dependency directories to clone. `trackedPaths` are the
 * worktree's tracked manifests and lockfiles, relative and `/`-separated, as
 * listed by `git ls-files` with {@link DEPENDENCY_CLONE_PATHSPECS}.
 */
export async function planDependencyClones(input: {
  readonly sourceRoot: string;
  readonly worktreeRoot: string;
  readonly trackedPaths: ReadonlyArray<string>;
  readonly signal?: AbortSignal | undefined;
}): Promise<DependencyClonePlan> {
  const tracked = input.trackedPaths.filter((entry) => !isInsideDependencyDirectory(entry));
  const lockfiles = tracked.filter((entry) =>
    DEPENDENCY_LOCKFILE_NAMES.has(nodePath.posix.basename(entry)),
  );
  if (lockfiles.length === 0) return { kind: "skip", reason: "no-lockfile" };

  if (lockfiles.length > MAX_LOCKFILES) return { kind: "skip", reason: "lockfile-mismatch" };
  const [sourceRoot, worktreeRoot] = await Promise.all([
    nodeFs.realpath(input.sourceRoot),
    nodeFs.realpath(input.worktreeRoot),
  ]);
  let lockfileBytes = MAX_TOTAL_LOCKFILE_BYTES;
  for (const lockfile of lockfiles) {
    input.signal?.throwIfAborted();
    const maxBytes = Math.min(MAX_LOCKFILE_BYTES, lockfileBytes);
    const [source, target] = await Promise.all([
      readLockfile(nodePath.join(sourceRoot, lockfile), maxBytes),
      readLockfile(nodePath.join(worktreeRoot, lockfile), maxBytes),
    ]);
    if (source === null || target === null || !source.equals(target)) {
      return { kind: "skip", reason: "lockfile-mismatch" };
    }
    lockfileBytes -= source.length;
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
    input.signal?.throwIfAborted();
    const source = nodePath.join(sourceRoot, directory, DEPENDENCY_DIRECTORY_NAME);
    const target = nodePath.join(worktreeRoot, directory, DEPENDENCY_DIRECTORY_NAME);
    const [sourceEntry, targetEntry, sourceParent, targetParent] = await Promise.all([
      lstatOrNull(source),
      lstatOrNull(target),
      hasPhysicalParent(source),
      hasPhysicalParent(target),
    ]);
    // A symlinked node_modules would clone the link, not the tree, and an
    // existing target belongs to someone else.
    if (sourceParent && targetParent && sourceEntry?.isDirectory() && targetEntry === null) {
      pairs.push({ source, target });
    }
  }

  return pairs.length > 0 ? { kind: "clone", pairs } : { kind: "skip", reason: "nothing-to-clone" };
}

// Batch each native operation. clonefile preserves links inside the tree.
const JXA_FILE_OPERATIONS = `
function run(argv) {
  var operation = argv[0];
  ObjC.bindFunction(operation, ["int", ["char *", "char *", "unsigned int"]]);
  // CLONE_NOFOLLOW, or RENAME_EXCL | RENAME_NOFOLLOW_ANY for publication.
  var flags = operation === "clonefile" ? 0x0001 : 0x00000014;
  var results = [];
  for (var index = 1; index + 1 < argv.length; index += 2) {
    results.push($[operation](argv[index], argv[index + 1], flags) === 0);
  }
  return JSON.stringify(results);
}
`;

async function runFileOperation(
  operation: "clonefile" | "renamex_np",
  pairs: ReadonlyArray<DependencyClonePair>,
  signal?: AbortSignal,
): Promise<ReadonlyArray<boolean>> {
  const result = await runProcess(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      JXA_FILE_OPERATIONS,
      operation,
      ...pairs.flatMap((pair) => [pair.source, pair.target]),
    ],
    { timeoutMs: SEED_TIMEOUT_MS, signal },
  );
  const parsed: unknown = JSON.parse(result.stdout.trim());
  if (
    !Array.isArray(parsed) ||
    parsed.length !== pairs.length ||
    !parsed.every((entry) => typeof entry === "boolean")
  ) {
    throw new Error(`${operation} helper returned an unexpected result.`);
  }
  return parsed;
}

export const cloneDirectoriesWithClonefile: CloneDirectories = (pairs, signal) =>
  runFileOperation("clonefile", pairs, signal);

async function ignoredTargets(
  worktreeRoot: string,
  pairs: ReadonlyArray<DependencyClonePair>,
  signal?: AbortSignal,
): Promise<DependencyClonePair[]> {
  const relativePaths = pairs.map((pair) => nodePath.relative(worktreeRoot, pair.target) + "/");
  // Like workspace discovery, check ignore rules without running fsmonitor hooks.
  const result = await runProcess(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "check-ignore",
      "-z",
      "--stdin",
    ],
    {
      cwd: worktreeRoot,
      stdin: relativePaths.join("\0") + "\0",
      allowNonZeroExit: true,
      timeoutMs: SEED_TIMEOUT_MS,
      signal,
    },
  );
  if (result.code !== 0 || result.timedOut) return [];
  const ignored = new Set(result.stdout.split("\0"));
  return pairs.filter((_pair, index) => ignored.has(relativePaths[index]!));
}

type StagedClone = DependencyClonePair & { readonly stagingPath: string };

// Inspect the snapshot, but compare each link at its original and final location.
async function inspectStagedLinks(
  roots: { sourceRoot: string; worktreeRoot: string; stagingRoot: string },
  trees: ReadonlyArray<StagedClone>,
  signal: AbortSignal,
) {
  const result = await runProcess(
    "/usr/bin/find",
    ["-P", ...trees.map((tree) => tree.stagingPath), "-type", "l", "-print0"],
    { timeoutMs: SEED_TIMEOUT_MS, signal },
  );
  const byStageName = new Map(trees.map((tree) => [nodePath.basename(tree.stagingPath), tree]));
  const unsafe = new Set<string>();
  const requiredTrees = new Map(trees.map((tree) => [tree.target, new Set<string>()]));
  const links = result.stdout.split("\0").filter(Boolean);
  const readConcurrency = 64;
  for (let offset = 0; offset < links.length; offset += readConcurrency) {
    signal.throwIfAborted();
    await Promise.all(
      links.slice(offset, offset + readConcurrency).map(async (link) => {
        const stageName = nodePath.relative(roots.stagingRoot, link).split(nodePath.sep, 1)[0]!;
        const tree = byStageName.get(stageName);
        if (!tree || unsafe.has(tree.stagingPath)) return;

        const contents = await nodeFs.readlink(link).catch(() => null);
        if (contents === null || nodePath.isAbsolute(contents)) {
          unsafe.add(tree.stagingPath);
          return;
        }

        const directory = nodePath.dirname(nodePath.relative(tree.stagingPath, link));
        const original = nodePath.resolve(tree.source, directory, contents);
        const relocated = nodePath.resolve(tree.target, directory, contents);
        const expected = isContainedPath(roots.sourceRoot, original)
          ? nodePath.resolve(roots.worktreeRoot, nodePath.relative(roots.sourceRoot, original))
          : original;
        if (relocated !== expected) {
          unsafe.add(tree.stagingPath);
          return;
        }

        if (!isContainedPath(roots.worktreeRoot, relocated)) return;
        const parts = nodePath.relative(roots.worktreeRoot, relocated).split(nodePath.sep);
        const dependencyDirectory = parts.indexOf(DEPENDENCY_DIRECTORY_NAME);
        if (dependencyDirectory < 0) return;
        const required = nodePath.join(
          roots.worktreeRoot,
          ...parts.slice(0, dependencyDirectory + 1),
        );
        if (required !== tree.target) requiredTrees.get(tree.target)!.add(required);
      }),
    );
  }
  return { unsafe, requiredTrees };
}

/** Stage and validate privately, then publish without replacing any existing target. */
export async function cloneWorktreeDependencies(input: {
  readonly sourceRoot: string;
  readonly worktreeRoot: string;
  readonly trackedPaths: ReadonlyArray<string>;
  readonly cloneDirectories?: CloneDirectories;
  readonly signal?: AbortSignal | undefined;
}): Promise<DependencyCloneResult> {
  const deadline = AbortSignal.timeout(SEED_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const plan = await planDependencyClones({ ...input, signal });
  if (plan.kind === "skip") return { kind: "skipped", reason: plan.reason };

  const [sourceRoot, worktreeRoot] = await Promise.all([
    nodeFs.realpath(input.sourceRoot),
    nodeFs.realpath(input.worktreeRoot),
  ]);
  const pairs = await ignoredTargets(worktreeRoot, plan.pairs, signal);
  if (pairs.length === 0) return { kind: "skipped", reason: "target-not-ignored" };

  // Stage next to the checkout so Git never sees the temporary dependency tree.
  const stagingRoot = await nodeFs.mkdtemp(
    nodePath.join(nodePath.dirname(worktreeRoot), ".synara-deps-"),
  );
  try {
    const staged = pairs.map((pair, index) => ({
      ...pair,
      stagingPath: nodePath.join(stagingRoot, String(index)),
    }));
    const cloneDirectories = input.cloneDirectories ?? cloneDirectoriesWithClonefile;
    const outcomes = await cloneDirectories(
      staged.map((tree) => ({ source: tree.source, target: tree.stagingPath })),
      signal,
    );
    const complete: StagedClone[] = [];
    for (const [index, tree] of staged.entries()) {
      if (outcomes[index] && (await lstatOrNull(tree.stagingPath))?.isDirectory()) {
        complete.push(tree);
      }
    }
    if (complete.length === 0) return { kind: "cloned", cloned: 0, failed: pairs.length };

    const { unsafe, requiredTrees } = await inspectStagedLinks(
      { sourceRoot, worktreeRoot, stagingRoot },
      complete,
      signal,
    );
    const publish = complete
      .filter((tree) => !unsafe.has(tree.stagingPath))
      .map((tree) => ({ source: tree.stagingPath, target: tree.target }));
    // Drop path-keyed caches in staging, where cleanup can only touch our own clone.
    await Promise.all(
      publish.flatMap((pair) =>
        CLONED_CACHE_DIRECTORIES.map((cache) =>
          nodeFs.rm(nodePath.join(pair.source, cache), { recursive: true, force: true }),
        ),
      ),
    );
    // The worktree's ignore rules can change while the clone is being prepared.
    const stillIgnored =
      publish.length > 0 ? await ignoredTargets(worktreeRoot, publish, signal) : [];
    const published = new Set<string>();
    let pending = stillIgnored;
    // Publish shared stores first. A failed rename, omitted store, or cycle leaves
    // its dependent trees private, so an ordinary install can populate them.
    while (pending.length > 0) {
      signal.throwIfAborted();
      const ready = pending.filter((pair) =>
        [...requiredTrees.get(pair.target)!].every((required) => published.has(required)),
      );
      if (ready.length === 0) break;
      const results = await runFileOperation("renamex_np", ready, signal);
      const attempted = new Set(ready.map((pair) => pair.target));
      for (const [index, pair] of ready.entries()) {
        if (results[index]) published.add(pair.target);
      }
      pending = pending.filter((pair) => !attempted.has(pair.target));
    }
    return { kind: "cloned", cloned: published.size, failed: pairs.length - published.size };
  } finally {
    await nodeFs.rm(stagingRoot, { recursive: true, force: true });
  }
}
