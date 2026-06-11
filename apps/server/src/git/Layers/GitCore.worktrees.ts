// FILE: GitCore.worktrees.ts
// Purpose: Worktree creation/removal and remote/PR branch fetch+materialize operations
//   for the GitCore service.
// Layer: dependency-parameterized factory; built once per GitCore via makeGitWorktrees(deps).
// Exports: GitWorktrees, GitWorktreesDeps, makeGitWorktrees.
import { Effect } from "effect";
import type { FileSystem, Path } from "effect";
import { randomUUID } from "node:crypto";

import type { GitCoreShape } from "../Services/GitCore.ts";
import type { GitRunner } from "./GitCore.runner.ts";
import { commandLabel, createGitCommandError } from "./GitCore.commands.ts";
import { AUTO_DETACHED_WORKTREE_DIRNAME } from "./GitCore.types.ts";

export interface GitWorktreesDeps {
  readonly runner: GitRunner;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly worktreesDir: string;
}

export interface GitWorktrees {
  readonly createWorktree: GitCoreShape["createWorktree"];
  readonly createDetachedWorktree: GitCoreShape["createDetachedWorktree"];
  readonly fetchPullRequestBranch: GitCoreShape["fetchPullRequestBranch"];
  readonly fetchRemoteBranch: GitCoreShape["fetchRemoteBranch"];
  readonly setBranchUpstream: GitCoreShape["setBranchUpstream"];
  readonly removeWorktree: GitCoreShape["removeWorktree"];
}

export const makeGitWorktrees = (deps: GitWorktreesDeps): GitWorktrees => {
  const { fileSystem, path, worktreesDir } = deps;
  const { executeGit, runGit, branchExists, resolvePrimaryRemoteName } = deps.runner;

  const buildGeneratedDetachedWorktreePath = () =>
    Effect.gen(function* () {
      // Keep auto-generated detached worktrees short and opaque so the
      // filesystem path stays stable-looking regardless of the source ref.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const shortId = randomUUID().replace(/-/g, "").slice(0, 4);
        const candidateParent = path.join(worktreesDir, shortId);
        const candidatePath = path.join(candidateParent, AUTO_DETACHED_WORKTREE_DIRNAME);
        if (yield* fileSystem.exists(candidatePath)) {
          continue;
        }
        yield* fileSystem.makeDirectory(candidateParent, { recursive: true });
        return candidatePath;
      }

      const fallbackId = randomUUID().replace(/-/g, "");
      const fallbackParent = path.join(worktreesDir, fallbackId);
      yield* fileSystem.makeDirectory(fallbackParent, { recursive: true });
      return path.join(fallbackParent, AUTO_DETACHED_WORKTREE_DIRNAME);
    });

  const createWorktree: GitCoreShape["createWorktree"] = (input) =>
    Effect.gen(function* () {
      const targetBranch = input.newBranch ?? input.branch;
      const sanitizedBranch = targetBranch.replace(/\//g, "-");
      const repoName = path.basename(input.cwd);
      const worktreePath = input.path ?? path.join(worktreesDir, repoName, sanitizedBranch);
      const args = input.newBranch
        ? ["worktree", "add", "-b", input.newBranch, worktreePath, input.branch]
        : ["worktree", "add", worktreePath, input.branch];

      yield* executeGit("GitCore.createWorktree", input.cwd, args, {
        fallbackErrorMessage: "git worktree add failed",
      });

      return {
        worktree: {
          path: worktreePath,
          branch: targetBranch,
        },
      };
    });

  const createDetachedWorktree: GitCoreShape["createDetachedWorktree"] = (input) =>
    Effect.gen(function* () {
      const worktreePath =
        input.path ??
        (yield* buildGeneratedDetachedWorktreePath().pipe(
          Effect.mapError((cause: unknown) =>
            createGitCommandError(
              "GitCore.createDetachedWorktree",
              input.cwd,
              ["worktree", "add", "--detach", "<generated>", input.ref],
              "failed to prepare detached worktree path.",
              cause,
            ),
          ),
        ));

      yield* executeGit("GitCore.createDetachedWorktree", input.cwd, [
        "worktree",
        "add",
        "--detach",
        worktreePath,
        input.ref,
      ]);

      return {
        worktree: {
          path: worktreePath,
          ref: input.ref,
          branch: null,
        },
      };
    });

  const fetchPullRequestBranch: GitCoreShape["fetchPullRequestBranch"] = (input) =>
    Effect.gen(function* () {
      const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
      yield* executeGit(
        "GitCore.fetchPullRequestBranch",
        input.cwd,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          remoteName,
          `+refs/pull/${input.prNumber}/head:refs/heads/${input.branch}`,
        ],
        {
          fallbackErrorMessage: "git fetch pull request branch failed",
        },
      );
    }).pipe(Effect.asVoid);

  const fetchRemoteBranch: GitCoreShape["fetchRemoteBranch"] = (input) =>
    Effect.gen(function* () {
      yield* runGit("GitCore.fetchRemoteBranch.fetch", input.cwd, [
        "fetch",
        "--quiet",
        "--no-tags",
        input.remoteName,
        `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
      ]);

      const localBranchAlreadyExists = yield* branchExists(input.cwd, input.localBranch);
      const targetRef = `${input.remoteName}/${input.remoteBranch}`;
      yield* runGit(
        "GitCore.fetchRemoteBranch.materialize",
        input.cwd,
        localBranchAlreadyExists
          ? ["branch", "--force", input.localBranch, targetRef]
          : ["branch", input.localBranch, targetRef],
      );
    }).pipe(Effect.asVoid);

  const setBranchUpstream: GitCoreShape["setBranchUpstream"] = (input) =>
    runGit("GitCore.setBranchUpstream", input.cwd, [
      "branch",
      "--set-upstream-to",
      `${input.remoteName}/${input.remoteBranch}`,
      input.branch,
    ]);

  const removeWorktree: GitCoreShape["removeWorktree"] = (input) =>
    Effect.gen(function* () {
      const args = ["worktree", "remove"];
      if (input.force) {
        args.push("--force");
      }
      args.push(input.path);
      yield* executeGit("GitCore.removeWorktree", input.cwd, args, {
        timeoutMs: 15_000,
        fallbackErrorMessage: "git worktree remove failed",
      }).pipe(
        Effect.mapError((error) =>
          createGitCommandError(
            "GitCore.removeWorktree",
            input.cwd,
            args,
            `${commandLabel(args)} failed (cwd: ${input.cwd}): ${error instanceof Error ? error.message : String(error)}`,
            error,
          ),
        ),
      );
    });

  return {
    createWorktree,
    createDetachedWorktree,
    fetchPullRequestBranch,
    fetchRemoteBranch,
    setBranchUpstream,
    removeWorktree,
  };
};
