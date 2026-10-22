// Native Git and authenticated, read-only GitHub acceptance. No transport substitutes.
import * as fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "./config";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitHubCliLive } from "./git/Layers/GitHubCli";
import { GitCore } from "./git/Services/GitCore";
import { GitHubCli } from "./git/Services/GitHubCli";
import { pruneArchivedManagedWorktrees } from "./managedWorktrees";

describe.runIf(process.env.SYNARA_LIVE_GITHUB === "1")("native merged cleanup", () => {
  it("uses fresh GitHub proof, snapshots a locked checkout, and retains its branch after retry", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "synara-native-cleanup-"));
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-b", "main");
    git("remote", "add", "origin", "https://github.com/Emanuele-web04/synara.git");
    // A real merged PR, fetched independently through gh below; no recorded response fixture.
    git("fetch", "--depth=1", "origin", "refs/pull/1829/head");
    git("checkout", "--detach", "FETCH_HEAD");
    const config = ServerConfig.layerTest(repo, path.join(root, "home"));
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(GitCoreLive, GitHubCliLive).pipe(
        Layer.provide(config),
        Layer.provide(NodeServices.layer),
      ),
    );
    try {
      const core = await runtime.runPromise(Effect.service(GitCore));
      const github = await runtime.runPromise(Effect.service(GitHubCli));
      const proof = await runtime.runPromise(
        github.getPullRequestWithChecks({
          cwd: repo,
          reference: "https://github.com/Emanuele-web04/synara/pull/1829",
        }),
      );
      expect(proof.summary.state).toBe("merged");
      expect(proof.headSha).toBe(git("rev-parse", "HEAD"));
      const branch = proof.summary.headRefName;
      const created = await runtime.runPromise(
        core.createWorktree({ cwd: repo, branch: proof.headSha!, newBranch: branch, path: null }),
      );
      const threads = [
        {
          id: "archived-native-owner-".repeat(8),
          archivedAt: new Date().toISOString(),
          worktreePath: created.worktree.path,
          busy: false,
          lastKnownPr: {
            number: proof.summary.number,
            title: proof.summary.title,
            url: proof.summary.url,
            baseBranch: proof.summary.baseRefName,
            headBranch: branch,
            state: "merged" as const,
          },
        },
      ];
      const worktreesDir = path.join(root, "home", "worktrees");
      const snapshotsDir = path.join(root, "snapshots");
      const sweep = () =>
        runtime.runPromise(
          pruneArchivedManagedWorktrees({
            worktreesDir,
            snapshotsDir,
            threads,
            readThreads: () => Effect.succeed(threads),
            git: core,
            mergeCleanup: {
              withOwnership: (effect) => effect,
              enabled: Effect.succeed(true),
              github,
              isProtected: () => Effect.succeed(false),
            },
          }),
        );
      git("worktree", "lock", "--reason", "native removal failure", created.worktree.path);
      expect(await sweep()).toHaveLength(1);
      expect((await fs.stat(created.worktree.path)).isDirectory()).toBe(true);
      const snapshots = (await fs.readdir(snapshotsDir)).filter((name) => !name.includes(".tmp-"));
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toContain(
        createHash("sha256").update(proof.headSha!).digest("hex").slice(0, 16),
      );
      const manifest = JSON.parse(
        await fs.readFile(path.join(snapshotsDir, snapshots[0]!, "snapshot.json"), "utf8"),
      );
      expect(manifest.head).toBe(proof.headSha);
      git("worktree", "unlock", created.worktree.path);
      expect(await sweep()).toEqual([]);
      await expect(fs.stat(created.worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(git("rev-parse", `refs/heads/${branch}`)).toBe(proof.headSha);
      // Exercise native temporary-ref reclamation with the flag used by merged cleanup.
      const temporary = await runtime.runPromise(
        core.createWorktree({
          cwd: repo,
          branch: proof.headSha!,
          newBranch: "synara/1234abcd",
          path: null,
        }),
      );
      await runtime.runPromise(
        core.removeWorktree({
          cwd: repo,
          path: temporary.worktree.path,
          force: false,
          reclaimTemporaryBranch: false,
        }),
      );
      expect(git("rev-parse", "refs/heads/synara/1234abcd")).toBe(proof.headSha);
    } finally {
      await runtime.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
