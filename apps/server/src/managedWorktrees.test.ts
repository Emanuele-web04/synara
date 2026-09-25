import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { OrchestrationThread } from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { GitCoreShape } from "./git/Services/GitCore.ts";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  archivedWorktreeHasNoOtherOwners,
  classifyManagedWorktreeRemovalCandidates,
  discardManagedWorktreeResidue,
  isManagedWorktreePath,
  isManagedWorktreePathCanonical,
  listManagedWorktrees,
  MANAGED_WORKTREE_RETENTION_COUNT,
  MANAGED_WORKTREE_SNAPSHOT_RETENTION_MS,
  pruneArchivedManagedWorktrees,
  pruneExpiredManagedWorktreeSnapshots,
  pruneProjectedArchivedManagedWorktrees,
} from "./managedWorktrees.ts";

it("keeps an archived checkout when another task reaches it through a symlink", async () => {
  const root = await makeTemporaryRoot();
  const managed = path.join(root, "managed");
  const alias = path.join(root, "alias");
  const worktree = path.join(managed, "project", "task");
  await fs.mkdir(worktree, { recursive: true });
  await fs.symlink(managed, alias);

  expect(
    await Effect.runPromise(
      isManagedWorktreePathCanonical({ worktreesDir: alias, worktreePath: worktree }),
    ),
  ).toBe(true);
  expect(
    await Effect.runPromise(
      archivedWorktreeHasNoOtherOwners({
        worktreePath: worktree,
        threadId: "archived",
        threads: [
          { id: "archived", archivedAt: "2026-09-25T00:00:00.000Z", worktreePath: worktree },
          {
            id: "other",
            archivedAt: "2026-09-25T00:00:00.000Z",
            worktreePath: path.join(alias, "project", "task"),
          },
        ],
      }),
    ),
  ).toBe(false);
});

const temporaryRoots: string[] = [];

async function makeManagedRoot(count: number) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "synara-managed-worktrees-"));
  temporaryRoots.push(root);
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const worktreePath = path.join(root, `task-${index}`, "synara");
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(path.join(worktreePath, ".git"), "gitdir: /tmp/repo/.git/worktrees/test\n");
    paths.push(await fs.realpath(worktreePath));
  }
  return { root, paths };
}

function cleanStatusDetails() {
  return Effect.succeed({
    isRepo: true,
    hasOriginRemote: false,
    isDefaultBranch: false,
    upstreamRef: null,
    branch: "synara/test",
    hasWorkingTreeChanges: false,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
  });
}

function dirtyStatusDetails() {
  return Effect.succeed({
    isRepo: true,
    hasOriginRemote: false,
    isDefaultBranch: false,
    upstreamRef: null,
    branch: "synara/test",
    hasWorkingTreeChanges: true,
    stagedCount: 0,
    unstagedCount: 1,
    untrackedCount: 0,
  });
}

function makeGit(input: {
  readonly removals: string[];
  readonly snapshots?: string[];
  readonly dirtyPaths?: ReadonlySet<string>;
}) {
  return {
    execute: ({ cwd }: { cwd: string }) =>
      Effect.succeed({
        code: 0,
        stdout: `worktree /repo/project\nHEAD abc\nbranch refs/heads/main\n\nworktree ${cwd}\nHEAD abc\ndetached\n`,
        stderr: "",
      }),
    withMutation: (_cwd: string, effect: Effect.Effect<unknown, unknown, unknown>) => effect,
    snapshotWorktree: ({ outputPath }: { outputPath: string }) =>
      Effect.sync(() => {
        input.snapshots?.push(outputPath);
      }),
    statusDetails: (cwd: string) =>
      input.dirtyPaths?.has(cwd) ? dirtyStatusDetails() : cleanStatusDetails(),
    removeWorktree: ({ path: worktreePath }: { path: string }) =>
      Effect.sync(() => input.removals.push(worktreePath)),
  } as unknown as GitCoreShape;
}

async function makeTemporaryRoot(prefix = "synara-managed-worktree-residue-") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

async function writeSnapshot(
  snapshotsDir: string,
  name: string,
  manifest: Record<string, unknown> | null,
) {
  const snapshotPath = path.join(snapshotsDir, name);
  await fs.mkdir(path.join(snapshotPath, "files"), { recursive: true });
  await fs.writeFile(path.join(snapshotPath, "changes.patch"), "");
  if (manifest !== null) {
    await fs.writeFile(path.join(snapshotPath, "snapshot.json"), JSON.stringify(manifest));
  }
  return snapshotPath;
}

function snapshotDigest(worktreePath: string) {
  return createHash("sha256").update(worktreePath).digest("hex").slice(0, 12);
}

async function pathExists(target: string) {
  return fs.stat(target).then(
    () => true,
    () => false,
  );
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("managed worktrees", () => {
  it("discovers linked worktrees and reports their primary checkout", async () => {
    const { root, paths } = await makeManagedRoot(2);
    const git = {
      execute: ({ cwd }: { cwd: string }) =>
        Effect.succeed({
          code: 0,
          stdout: `worktree /repo/project\nHEAD abc\nbranch refs/heads/main\n\nworktree ${cwd}\nHEAD abc\ndetached\n`,
          stderr: "",
        }),
    } as unknown as GitCoreShape;

    await expect(
      Effect.runPromise(listManagedWorktrees({ worktreesDir: root, git })),
    ).resolves.toEqual(
      paths.map((worktreePath) => ({ path: worktreePath, workspaceRoot: "/repo/project" })),
    );
  });

  it("snapshots and removes only archived worktrees beyond the retention limit", async () => {
    const count = MANAGED_WORKTREE_RETENTION_COUNT + 1;
    const { root, paths } = await makeManagedRoot(count);
    const snapshots: string[] = [];
    const removals: string[] = [];
    const git = makeGit({ removals, snapshots });
    const threads = paths.map(
      (worktreePath, index) =>
        ({
          id: `thread-${index}`,
          worktreePath,
          associatedWorktreePath: worktreePath,
          archivedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
          deletedAt: null,
        }) as unknown as OrchestrationThread,
    );
    const snapshotsDir = path.join(root, "snapshots");

    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir,
        threads,
        git,
      }),
    );

    expect(removals).toEqual([paths[0]]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toContain(path.join(root, "snapshots", "thread-0-"));
    expect(remaining).toHaveLength(MANAGED_WORKTREE_RETENTION_COUNT);
  });

  it("matches threads whose recorded paths reach the worktree through a symlink", async () => {
    const count = MANAGED_WORKTREE_RETENTION_COUNT + 1;
    const { root, paths } = await makeManagedRoot(count);
    const canonicalRoot = await fs.realpath(root);
    const linkRoot = await fs.mkdtemp(path.join(tmpdir(), "synara-managed-worktrees-link-"));
    temporaryRoots.push(linkRoot);
    const symlinkedRoot = path.join(linkRoot, "worktrees");
    await fs.symlink(canonicalRoot, symlinkedRoot);
    const removals: string[] = [];
    const git = makeGit({ removals });
    // Threads recorded their worktrees through the symlinked directory, while
    // the inventory scan reports realpath-canonical entries.
    const threads = paths.map(
      (worktreePath, index) =>
        ({
          id: `thread-${index}`,
          worktreePath: path.join(symlinkedRoot, path.relative(canonicalRoot, worktreePath)),
          associatedWorktreePath: path.join(
            symlinkedRoot,
            path.relative(canonicalRoot, worktreePath),
          ),
          archivedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
          deletedAt: null,
        }) as unknown as OrchestrationThread,
    );

    await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
      }),
    );

    expect(removals).toEqual([paths[0]]);
  });

  it("still prunes worktrees owned by retention-deleted threads", async () => {
    const count = MANAGED_WORKTREE_RETENTION_COUNT + 1;
    const { root, paths } = await makeManagedRoot(count);
    const removals: string[] = [];
    const git = makeGit({ removals });

    // The oldest archived thread was soft-deleted by retention. `getShellSnapshot`
    // would hide it and silently strand its worktree on disk forever, so the prune
    // path must read a projection query that keeps soft-deleted threads visible.
    const snapshotQuery = {
      listManagedWorktreeThreads: () =>
        Effect.succeed(
          paths.map((worktreePath, index) => ({
            id: `thread-${index}`,
            archivedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
            deletedAt: index === 0 ? new Date(Date.UTC(2026, 0, index + 2)).toISOString() : null,
            worktreePath,
            associatedWorktreePath: worktreePath,
          })),
        ),
      getSnapshot: () => Effect.die(new Error("getSnapshot must not be used by worktree prune")),
    } as unknown as ProjectionSnapshotQueryShape;

    await Effect.runPromise(
      pruneProjectedArchivedManagedWorktrees({
        homeDir: root,
        worktreesDir: root,
        snapshotQuery,
        git,
      }),
    );

    // Deleted owners reclaim immediately (bypass archived retention). The
    // remaining archived set fits inside the keep window, so only the deleted
    // owner is removed here.
    expect(removals).toEqual([paths[0]]);
  });

  it("removes a clean soft-deleted worktree even when it was never archived", async () => {
    const { root, paths } = await makeManagedRoot(2);
    const removals: string[] = [];
    const git = makeGit({ removals });
    const threads = [
      {
        id: "thread-active",
        worktreePath: paths[0],
        associatedWorktreePath: paths[0],
        archivedAt: null,
        deletedAt: null,
      },
      {
        id: "thread-deleted",
        worktreePath: paths[1],
        associatedWorktreePath: paths[1],
        archivedAt: null,
        deletedAt: "2026-08-01T00:00:00.000Z",
      },
    ] as unknown as OrchestrationThread[];

    await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
      }),
    );

    expect(removals).toEqual([paths[1]]);
  });

  it("removes the emptied per-worktree parent after an automatic removal", async () => {
    const { root, paths } = await makeManagedRoot(2);
    const [activePath, deletedPath] = paths as [string, string];
    const removals: string[] = [];
    // Retention removes through Git, which deletes the checkout directory itself.
    const git = {
      ...makeGit({ removals }),
      removeWorktree: ({ path: worktreePath }: { path: string }) =>
        Effect.promise(async () => {
          removals.push(worktreePath);
          await fs.rm(worktreePath, { recursive: true, force: true });
        }),
    } as unknown as GitCoreShape;
    const threads = [
      {
        id: "thread-active",
        worktreePath: paths[0],
        associatedWorktreePath: paths[0],
        archivedAt: null,
        deletedAt: null,
      },
      {
        id: "thread-deleted",
        worktreePath: paths[1],
        associatedWorktreePath: paths[1],
        archivedAt: null,
        deletedAt: "2026-08-01T00:00:00.000Z",
      },
    ] as unknown as OrchestrationThread[];

    await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
      }),
    );

    expect(removals).toEqual([deletedPath]);
    await expect(fs.access(path.dirname(deletedPath))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.dirname(activePath))).resolves.toBeUndefined();
  });

  it("refuses to force-remove a dirty deleted worktree", async () => {
    const { root, paths } = await makeManagedRoot(1);
    const removals: string[] = [];
    const snapshots: string[] = [];
    const git = makeGit({
      removals,
      snapshots,
      dirtyPaths: new Set([paths[0]!]),
    });
    const threads = [
      {
        id: "thread-dirty-deleted",
        worktreePath: paths[0],
        associatedWorktreePath: paths[0],
        archivedAt: null,
        deletedAt: "2026-08-01T00:00:00.000Z",
      },
    ] as unknown as OrchestrationThread[];

    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
      }),
    );

    expect(removals).toEqual([]);
    expect(snapshots).toHaveLength(1);
    expect(remaining).toEqual([{ path: paths[0], workspaceRoot: "/repo/project" }]);
  });

  it("preserves managed worktrees with no projected thread owner", async () => {
    const { root, paths } = await makeManagedRoot(2);
    const removals: string[] = [];
    const git = makeGit({ removals });
    const threads = [
      {
        id: "thread-active",
        worktreePath: paths[0],
        associatedWorktreePath: paths[0],
        archivedAt: null,
        deletedAt: null,
      },
    ] as unknown as OrchestrationThread[];

    await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
      }),
    );

    expect(removals).toEqual([]);
  });

  it("never removes active worktrees", async () => {
    const { root, paths } = await makeManagedRoot(2);
    const removals: string[] = [];
    const git = makeGit({ removals });
    const threads = paths.map(
      (worktreePath, index) =>
        ({
          id: `thread-${index}`,
          worktreePath,
          associatedWorktreePath: worktreePath,
          archivedAt: null,
          deletedAt: null,
        }) as unknown as OrchestrationThread,
    );

    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
      }),
    );

    expect(removals).toEqual([]);
    expect(remaining).toHaveLength(2);
  });

  it("classifies deleted candidates without touching active or unowned worktrees", () => {
    const inventory = [
      { path: "/wt/active", workspaceRoot: "/repo" },
      { path: "/wt/deleted", workspaceRoot: "/repo" },
      { path: "/wt/archived-old", workspaceRoot: "/repo" },
      { path: "/wt/archived-new", workspaceRoot: "/repo" },
      { path: "/wt/orphan", workspaceRoot: "/repo" },
    ];
    const canonicalByRecordedPath = new Map(inventory.map((entry) => [entry.path, entry.path]));
    // Force retention window to treat only the newest archived as kept by
    // providing MANAGED_WORKTREE_RETENTION_COUNT archived paths via the real
    // classifier against a synthetic set is awkward; assert the core buckets
    // with a small inventory instead.
    const candidates = classifyManagedWorktreeRemovalCandidates({
      inventory,
      canonicalByRecordedPath,
      threads: [
        {
          id: "active",
          worktreePath: "/wt/active",
          archivedAt: null,
          deletedAt: null,
        },
        {
          id: "deleted",
          worktreePath: "/wt/deleted",
          archivedAt: null,
          deletedAt: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "archived-old",
          worktreePath: "/wt/archived-old",
          archivedAt: "2026-01-01T00:00:00.000Z",
          deletedAt: null,
        },
        {
          id: "archived-new",
          worktreePath: "/wt/archived-new",
          archivedAt: "2026-02-01T00:00:00.000Z",
          deletedAt: null,
        },
      ],
    });

    expect(candidates.map((candidate) => [candidate.entry.path, candidate.reason])).toEqual([
      ["/wt/deleted", "deleted"],
    ]);
  });
});

describe("managed worktree residue", () => {
  it("recognizes only paths strictly inside the worktrees directory", () => {
    expect(isManagedWorktreePath({ worktreesDir: "/w", worktreePath: "/w/repo/branch" })).toBe(
      true,
    );
    expect(isManagedWorktreePath({ worktreesDir: "/w", worktreePath: "/w" })).toBe(false);
    expect(isManagedWorktreePath({ worktreesDir: "/w", worktreePath: "/elsewhere/repo" })).toBe(
      false,
    );
    expect(isManagedWorktreePath({ worktreesDir: "/w", worktreePath: "/w/../x/repo" })).toBe(false);
    expect(isManagedWorktreePath({ worktreesDir: "/w", worktreePath: "/w2/repo" })).toBe(false);
  });

  it("discards snapshots matched by path digest or recorded source worktree", async () => {
    const root = await makeTemporaryRoot();
    const worktreesDir = path.join(root, "worktrees");
    const snapshotsDir = path.join(root, "snapshots");
    const worktreePath = path.join(worktreesDir, "repo", "feature");
    const otherPath = path.join(worktreesDir, "repo", "other");
    await fs.mkdir(path.join(worktreesDir, "repo"), { recursive: true });

    const byDigest = await writeSnapshot(
      snapshotsDir,
      `thread-a-${snapshotDigest(worktreePath)}`,
      null,
    );
    const bySource = await writeSnapshot(snapshotsDir, "legacy-snapshot", {
      sourceWorktree: worktreePath,
      createdAt: new Date().toISOString(),
    });
    const unrelated = await writeSnapshot(snapshotsDir, `thread-b-${snapshotDigest(otherPath)}`, {
      sourceWorktree: otherPath,
      createdAt: new Date().toISOString(),
    });

    await Effect.runPromise(
      discardManagedWorktreeResidue({ worktreesDir, snapshotsDir, worktreePath }),
    );

    expect(await pathExists(byDigest)).toBe(false);
    expect(await pathExists(bySource)).toBe(false);
    expect(await pathExists(unrelated)).toBe(true);
  });

  it("matches snapshots when the removal path reaches the worktree through a symlink", async () => {
    const root = await makeTemporaryRoot();
    const worktreesDir = path.join(root, "worktrees");
    const snapshotsDir = path.join(root, "snapshots");
    const canonicalWorktreePath = path.join(worktreesDir, "repo", "feature");
    await fs.mkdir(path.join(worktreesDir, "repo"), { recursive: true });
    const linkRoot = await makeTemporaryRoot("synara-managed-worktree-residue-link-");
    const symlinkedWorktreesDir = path.join(linkRoot, "worktrees");
    await fs.symlink(worktreesDir, symlinkedWorktreesDir);
    const snapshot = await writeSnapshot(
      snapshotsDir,
      `thread-a-${snapshotDigest(canonicalWorktreePath)}`,
      null,
    );

    await Effect.runPromise(
      discardManagedWorktreeResidue({
        worktreesDir: symlinkedWorktreesDir,
        snapshotsDir,
        worktreePath: path.join(symlinkedWorktreesDir, "repo", "feature"),
      }),
    );

    expect(await pathExists(snapshot)).toBe(false);
    expect(await pathExists(path.join(worktreesDir, "repo"))).toBe(false);
  });

  it("removes an empty per-worktree parent directly under the worktrees directory", async () => {
    const root = await makeTemporaryRoot();
    const worktreesDir = path.join(root, "worktrees");
    const parent = path.join(worktreesDir, "ab12");
    await fs.mkdir(parent, { recursive: true });

    await Effect.runPromise(
      discardManagedWorktreeResidue({
        worktreesDir,
        snapshotsDir: path.join(root, "snapshots"),
        worktreePath: path.join(parent, "synara"),
      }),
    );

    expect(await pathExists(parent)).toBe(false);
    expect(await pathExists(worktreesDir)).toBe(true);
  });

  it("keeps a parent that still holds other worktrees", async () => {
    const root = await makeTemporaryRoot();
    const worktreesDir = path.join(root, "worktrees");
    const parent = path.join(worktreesDir, "repo");
    await fs.mkdir(path.join(parent, "sibling"), { recursive: true });

    await Effect.runPromise(
      discardManagedWorktreeResidue({
        worktreesDir,
        snapshotsDir: path.join(root, "snapshots"),
        worktreePath: path.join(parent, "feature"),
      }),
    );

    expect(await pathExists(path.join(parent, "sibling"))).toBe(true);
  });

  it("never removes the worktrees directory itself or folders nested deeper", async () => {
    const root = await makeTemporaryRoot();
    const worktreesDir = path.join(root, "worktrees");
    const nestedParent = path.join(worktreesDir, "repo", "group");
    await fs.mkdir(nestedParent, { recursive: true });

    await Effect.runPromise(
      discardManagedWorktreeResidue({
        worktreesDir,
        snapshotsDir: path.join(root, "snapshots"),
        worktreePath: path.join(worktreesDir, "direct-child"),
      }),
    );
    await Effect.runPromise(
      discardManagedWorktreeResidue({
        worktreesDir,
        snapshotsDir: path.join(root, "snapshots"),
        worktreePath: path.join(nestedParent, "feature"),
      }),
    );

    expect(await pathExists(worktreesDir)).toBe(true);
    expect(await pathExists(nestedParent)).toBe(true);
  });
});

describe("managed worktree snapshot expiry", () => {
  const NOW = Date.UTC(2026, 8, 1);

  it("removes expired snapshots and keeps fresh or unreadable ones", async () => {
    const snapshotsDir = await makeTemporaryRoot();
    const expired = await writeSnapshot(snapshotsDir, "thread-old-aaaaaaaaaaaa", {
      createdAt: new Date(NOW - MANAGED_WORKTREE_SNAPSHOT_RETENTION_MS - 1_000).toISOString(),
    });
    const fresh = await writeSnapshot(snapshotsDir, "thread-new-bbbbbbbbbbbb", {
      createdAt: new Date(NOW - 1_000).toISOString(),
    });
    const unreadable = await writeSnapshot(snapshotsDir, "thread-odd-cccccccccccc", null);
    const unparsableDate = await writeSnapshot(snapshotsDir, "thread-bad-dddddddddddd", {
      createdAt: "not a date",
    });

    const removed = await Effect.runPromise(
      pruneExpiredManagedWorktreeSnapshots({ snapshotsDir, now: NOW }),
    );

    expect(removed).toEqual([expired]);
    expect(await pathExists(expired)).toBe(false);
    expect(await pathExists(fresh)).toBe(true);
    expect(await pathExists(unreadable)).toBe(true);
    expect(await pathExists(unparsableDate)).toBe(true);
  });

  it("removes stale staging directories left by an interrupted snapshot", async () => {
    const snapshotsDir = await makeTemporaryRoot();
    const staleStaging = await writeSnapshot(
      snapshotsDir,
      "thread-a-aaaaaaaaaaaa.tmp-Ab12Cd",
      null,
    );
    const freshStaging = await writeSnapshot(
      snapshotsDir,
      "thread-b-bbbbbbbbbbbb.tmp-Ef34Gh",
      null,
    );
    const staleTime = new Date(NOW - MANAGED_WORKTREE_SNAPSHOT_RETENTION_MS - 1_000);
    await fs.utimes(staleStaging, staleTime, staleTime);
    const freshTime = new Date(NOW - 1_000);
    await fs.utimes(freshStaging, freshTime, freshTime);

    const removed = await Effect.runPromise(
      pruneExpiredManagedWorktreeSnapshots({ snapshotsDir, now: NOW }),
    );

    expect(removed).toEqual([staleStaging]);
    expect(await pathExists(freshStaging)).toBe(true);
  });

  it("treats a missing snapshots directory as nothing to prune", async () => {
    const root = await makeTemporaryRoot();
    await expect(
      Effect.runPromise(
        pruneExpiredManagedWorktreeSnapshots({ snapshotsDir: path.join(root, "missing") }),
      ),
    ).resolves.toEqual([]);
  });

  it("expires old snapshots during a retention pass with no removal candidates", async () => {
    const { root } = await makeManagedRoot(0);
    const snapshotsDir = path.join(root, "snapshots");
    const expired = await writeSnapshot(snapshotsDir, "thread-old-aaaaaaaaaaaa", {
      createdAt: new Date(
        Date.now() - MANAGED_WORKTREE_SNAPSHOT_RETENTION_MS - 60_000,
      ).toISOString(),
    });

    await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir,
        threads: [],
        git: makeGit({ removals: [] }),
      }),
    );

    expect(await pathExists(expired)).toBe(false);
  });
});
