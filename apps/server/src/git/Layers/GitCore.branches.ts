// FILE: GitCore.branches.ts
// Purpose: Branch listing/recency, create/rename/publish, checkout (with dirty-worktree
//   handling), and stash-and-checkout operations for the GitCore service.
// Layer: dependency-parameterized factory; built once per GitCore via makeGitBranches(deps).
// Exports: GitBranches, GitBranchesDeps, makeGitBranches.
import { Effect, Exit } from "effect";
import type { FileSystem } from "effect";

import { GitCheckoutDirtyWorktreeError, GitCommandError } from "../Errors.ts";
import type { GitCoreShape } from "../Services/GitCore.ts";
import type { GitRunner } from "./GitCore.runner.ts";
import type { GitStash } from "./GitCore.stash.ts";
import { createGitCommandError, isMissingGitCwdError } from "./GitCore.commands.ts";
import {
  deriveLocalBranchNameFromRemoteRef,
  parseBranchLine,
  parseDirtyWorktreeFiles,
  parseRemoteNames,
  parseRemoteRefWithRemoteNames,
  parseTrackingBranchByUpstreamRef,
} from "./GitCore.parsing.ts";

export interface GitBranchesDeps {
  readonly runner: GitRunner;
  readonly fileSystem: FileSystem.FileSystem;
  readonly stash: Pick<GitStash, "listStashEntries" | "dropStashByHash">;
}

export interface GitBranches {
  readonly listBranches: GitCoreShape["listBranches"];
  readonly renameBranch: GitCoreShape["renameBranch"];
  readonly publishBranch: GitCoreShape["publishBranch"];
  readonly createBranch: GitCoreShape["createBranch"];
  readonly deleteBranch: GitCoreShape["deleteBranch"];
  readonly checkoutBranch: GitCoreShape["checkoutBranch"];
  readonly stashAndCheckout: GitCoreShape["stashAndCheckout"];
  readonly listLocalBranchNames: GitCoreShape["listLocalBranchNames"];
}

export const makeGitBranches = (deps: GitBranchesDeps): GitBranches => {
  const { fileSystem } = deps;
  const { listStashEntries, dropStashByHash } = deps.stash;
  const {
    executeGit,
    runGitStdout,
    resolveAvailableBranchName,
    refreshCheckedOutBranchUpstream,
    resolvePushRemoteName,
  } = deps.runner;

  const readBranchRecency = (cwd: string): Effect.Effect<Map<string, number>, GitCommandError> =>
    Effect.gen(function* () {
      const branchRecency = yield* executeGit(
        "GitCore.readBranchRecency",
        cwd,
        [
          "for-each-ref",
          "--format=%(refname:short)%09%(committerdate:unix)",
          "refs/heads",
          "refs/remotes",
        ],
        {
          timeoutMs: 15_000,
          allowNonZeroExit: true,
        },
      );

      const branchLastCommit = new Map<string, number>();
      if (branchRecency.code !== 0) {
        return branchLastCommit;
      }

      for (const line of branchRecency.stdout.split("\n")) {
        if (line.length === 0) {
          continue;
        }
        const [name, lastCommitRaw] = line.split("\t");
        if (!name) {
          continue;
        }
        const lastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
        branchLastCommit.set(name, Number.isFinite(lastCommit) ? lastCommit : 0);
      }

      return branchLastCommit;
    });

  const listBranches: GitCoreShape["listBranches"] = (input) =>
    Effect.gen(function* () {
      const branchRecencyPromise = readBranchRecency(input.cwd).pipe(
        Effect.catch(() => Effect.succeed(new Map<string, number>())),
      );
      const localBranchResult = yield* executeGit(
        "GitCore.listBranches.branchNoColor",
        input.cwd,
        ["branch", "--no-color"],
        {
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        },
      ).pipe(
        Effect.catchIf(isMissingGitCwdError, () =>
          Effect.succeed({
            code: 128,
            stdout: "",
            stderr: "fatal: not a git repository",
          }),
        ),
      );

      if (localBranchResult.code !== 0) {
        const stderr = localBranchResult.stderr.trim();
        if (stderr.toLowerCase().includes("not a git repository")) {
          return { branches: [], isRepo: false, hasOriginRemote: false };
        }
        return yield* createGitCommandError(
          "GitCore.listBranches",
          input.cwd,
          ["branch", "--no-color"],
          stderr || "git branch failed",
        );
      }

      const remoteBranchResultEffect = executeGit(
        "GitCore.listBranches.remoteBranches",
        input.cwd,
        ["branch", "--no-color", "--remotes"],
        {
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        },
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `GitCore.listBranches: remote branch lookup failed for ${input.cwd}: ${error.message}. Falling back to an empty remote branch list.`,
          ).pipe(Effect.as({ code: 1, stdout: "", stderr: "" })),
        ),
      );

      const remoteNamesResultEffect = executeGit(
        "GitCore.listBranches.remoteNames",
        input.cwd,
        ["remote"],
        {
          timeoutMs: 5_000,
          allowNonZeroExit: true,
        },
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `GitCore.listBranches: remote name lookup failed for ${input.cwd}: ${error.message}. Falling back to an empty remote name list.`,
          ).pipe(Effect.as({ code: 1, stdout: "", stderr: "" })),
        ),
      );

      const branchMetadata = yield* Effect.all(
        [
          executeGit(
            "GitCore.listBranches.defaultRef",
            input.cwd,
            ["symbolic-ref", "refs/remotes/origin/HEAD"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ),
          executeGit(
            "GitCore.listBranches.worktreeList",
            input.cwd,
            ["worktree", "list", "--porcelain"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ),
          remoteBranchResultEffect,
          remoteNamesResultEffect,
          branchRecencyPromise,
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.catchIf(isMissingGitCwdError, () => Effect.succeed(null)));
      if (branchMetadata === null) {
        return { branches: [], isRepo: false, hasOriginRemote: false };
      }

      const [defaultRef, worktreeList, remoteBranchResult, remoteNamesResult, branchLastCommit] =
        branchMetadata;

      const remoteNames =
        remoteNamesResult.code === 0 ? parseRemoteNames(remoteNamesResult.stdout) : [];
      if (remoteBranchResult.code !== 0 && remoteBranchResult.stderr.trim().length > 0) {
        yield* Effect.logWarning(
          `GitCore.listBranches: remote branch lookup returned code ${remoteBranchResult.code} for ${input.cwd}: ${remoteBranchResult.stderr.trim()}. Falling back to an empty remote branch list.`,
        );
      }
      if (remoteNamesResult.code !== 0 && remoteNamesResult.stderr.trim().length > 0) {
        yield* Effect.logWarning(
          `GitCore.listBranches: remote name lookup returned code ${remoteNamesResult.code} for ${input.cwd}: ${remoteNamesResult.stderr.trim()}. Falling back to an empty remote name list.`,
        );
      }

      const defaultBranch =
        defaultRef.code === 0
          ? defaultRef.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
          : null;

      const worktreeMap = new Map<string, string>();
      if (worktreeList.code === 0) {
        let currentPath: string | null = null;
        for (const line of worktreeList.stdout.split("\n")) {
          if (line.startsWith("worktree ")) {
            const candidatePath = line.slice("worktree ".length);
            const exists = yield* fileSystem.stat(candidatePath).pipe(
              Effect.map(() => true),
              Effect.catch(() => Effect.succeed(false)),
            );
            currentPath = exists ? candidatePath : null;
          } else if (line.startsWith("branch refs/heads/") && currentPath) {
            worktreeMap.set(line.slice("branch refs/heads/".length), currentPath);
          } else if (line === "") {
            currentPath = null;
          }
        }
      }

      const localBranches = localBranchResult.stdout
        .split("\n")
        .map(parseBranchLine)
        .filter((branch): branch is { name: string; current: boolean } => branch !== null)
        .map((branch) => ({
          name: branch.name,
          current: branch.current,
          isRemote: false,
          isDefault: branch.name === defaultBranch,
          worktreePath: worktreeMap.get(branch.name) ?? null,
        }))
        .toSorted((a, b) => {
          const aPriority = a.current ? 0 : a.isDefault ? 1 : 2;
          const bPriority = b.current ? 0 : b.isDefault ? 1 : 2;
          if (aPriority !== bPriority) return aPriority - bPriority;

          const aLastCommit = branchLastCommit.get(a.name) ?? 0;
          const bLastCommit = branchLastCommit.get(b.name) ?? 0;
          if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
          return a.name.localeCompare(b.name);
        });

      const remoteBranches =
        remoteBranchResult.code === 0
          ? remoteBranchResult.stdout
              .split("\n")
              .map(parseBranchLine)
              .filter((branch): branch is { name: string; current: boolean } => branch !== null)
              .map((branch) => {
                const parsedRemoteRef = parseRemoteRefWithRemoteNames(branch.name, remoteNames);
                const remoteBranch: {
                  name: string;
                  current: boolean;
                  isRemote: boolean;
                  remoteName?: string;
                  isDefault: boolean;
                  worktreePath: string | null;
                } = {
                  name: branch.name,
                  current: false,
                  isRemote: true,
                  isDefault: false,
                  worktreePath: null,
                };
                if (parsedRemoteRef) {
                  remoteBranch.remoteName = parsedRemoteRef.remoteName;
                }
                return remoteBranch;
              })
              .toSorted((a, b) => {
                const aLastCommit = branchLastCommit.get(a.name) ?? 0;
                const bLastCommit = branchLastCommit.get(b.name) ?? 0;
                if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
                return a.name.localeCompare(b.name);
              })
          : [];

      const branches = [...localBranches, ...remoteBranches];

      return { branches, isRepo: true, hasOriginRemote: remoteNames.includes("origin") };
    });

  const renameBranch: GitCoreShape["renameBranch"] = (input) =>
    Effect.gen(function* () {
      if (input.oldBranch === input.newBranch) {
        return { branch: input.newBranch };
      }
      const targetBranch = yield* resolveAvailableBranchName(input.cwd, input.newBranch);

      yield* executeGit(
        "GitCore.renameBranch",
        input.cwd,
        ["branch", "-m", "--", input.oldBranch, targetBranch],
        {
          timeoutMs: 10_000,
          fallbackErrorMessage: "git branch rename failed",
        },
      );

      return { branch: targetBranch };
    });

  // Publish branch refs immediately so GitHub-backed workflows can see new worktree branches.
  const publishBranch: GitCoreShape["publishBranch"] = (input) =>
    Effect.gen(function* () {
      const remoteName = yield* resolvePushRemoteName(input.cwd, input.branch);
      if (!remoteName) {
        return yield* createGitCommandError(
          "GitCore.publishBranch",
          input.cwd,
          ["push", "-u", "<remote>", input.branch],
          "Cannot publish branch because no git remote is configured for this repository.",
        );
      }
      yield* executeGit(
        "GitCore.publishBranch",
        input.cwd,
        ["push", "-u", remoteName, input.branch],
        {
          timeoutMs: 30_000,
          fallbackErrorMessage: "git branch publish failed",
        },
      );
    }).pipe(Effect.asVoid);

  const createBranch: GitCoreShape["createBranch"] = (input) =>
    Effect.gen(function* () {
      yield* executeGit("GitCore.createBranch", input.cwd, ["branch", input.branch], {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git branch create failed",
      });
      if (input.publish === true) {
        yield* publishBranch({ cwd: input.cwd, branch: input.branch });
      }
    }).pipe(Effect.asVoid);

  const deleteBranch: GitCoreShape["deleteBranch"] = (input) =>
    Effect.gen(function* () {
      yield* executeGit(
        "GitCore.deleteBranch",
        input.cwd,
        ["branch", input.force ? "-D" : "-d", "--", input.branch],
        {
          timeoutMs: 10_000,
          fallbackErrorMessage: "git branch delete failed",
        },
      );
    }).pipe(Effect.asVoid);

  const resolveCheckoutBranchArgs = (input: {
    cwd: string;
    branch: string;
  }): Effect.Effect<readonly string[], GitCommandError> =>
    Effect.gen(function* () {
      const [localInputExists, remoteExists] = yield* Effect.all(
        [
          executeGit(
            "GitCore.checkoutBranch.localInputExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.code === 0)),
          executeGit(
            "GitCore.checkoutBranch.remoteExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/remotes/${input.branch}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.code === 0)),
        ],
        { concurrency: "unbounded" },
      );

      const localTrackingBranch = remoteExists
        ? yield* executeGit(
            "GitCore.checkoutBranch.localTrackingBranch",
            input.cwd,
            ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(
            Effect.map((result) =>
              result.code === 0
                ? parseTrackingBranchByUpstreamRef(result.stdout, input.branch)
                : null,
            ),
          )
        : null;

      const localTrackedBranchCandidate = deriveLocalBranchNameFromRemoteRef(input.branch);
      const localTrackedBranchTargetExists =
        remoteExists && localTrackedBranchCandidate
          ? yield* executeGit(
              "GitCore.checkoutBranch.localTrackedBranchTargetExists",
              input.cwd,
              ["show-ref", "--verify", "--quiet", `refs/heads/${localTrackedBranchCandidate}`],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(Effect.map((result) => result.code === 0))
          : false;

      const checkoutArgs = localInputExists
        ? ["checkout", input.branch]
        : remoteExists && !localTrackingBranch && localTrackedBranchTargetExists
          ? ["checkout", input.branch]
          : remoteExists && !localTrackingBranch
            ? ["checkout", "--track", input.branch]
            : remoteExists && localTrackingBranch
              ? ["checkout", localTrackingBranch]
              : ["checkout", input.branch];

      return checkoutArgs;
    });

  const checkoutBranch: GitCoreShape["checkoutBranch"] = (input) =>
    Effect.gen(function* () {
      const checkoutArgs = yield* resolveCheckoutBranchArgs(input);
      const result = yield* executeGit("GitCore.checkoutBranch.checkout", input.cwd, checkoutArgs, {
        timeoutMs: 10_000,
        allowNonZeroExit: true,
        fallbackErrorMessage: "git checkout failed",
      });
      if (result.code !== 0) {
        const conflictingFiles = parseDirtyWorktreeFiles(result.stderr);
        if (conflictingFiles) {
          return yield* new GitCheckoutDirtyWorktreeError({
            branch: input.branch,
            cwd: input.cwd,
            conflictingFiles,
          });
        }
        const stderr = result.stderr.trim();
        return yield* createGitCommandError(
          "GitCore.checkoutBranch.checkout",
          input.cwd,
          checkoutArgs,
          stderr.length > 0 ? stderr : "git checkout failed",
        );
      }

      // Refresh upstream refs in the background so checkout remains responsive.
      yield* Effect.forkScoped(
        refreshCheckedOutBranchUpstream(input.cwd).pipe(Effect.ignoreCause({ log: true })),
      );
    });

  const stashAndCheckout: GitCoreShape["stashAndCheckout"] = (input) =>
    Effect.gen(function* () {
      const stashBefore = yield* listStashEntries(
        "GitCore.stashAndCheckout.stashListBefore",
        input.cwd,
      );

      yield* executeGit(
        "GitCore.stashAndCheckout.stashPush",
        input.cwd,
        ["stash", "push", "-u", "-m", `synara: stash before switching to ${input.branch}`],
        {
          timeoutMs: 30_000,
          fallbackErrorMessage: "git stash failed",
        },
      );

      const stashAfter = yield* listStashEntries(
        "GitCore.stashAndCheckout.stashListAfter",
        input.cwd,
      );
      const stashBeforeHashes = new Set(stashBefore.map((entry) => entry.hash));
      const createdStash =
        stashAfter.find((entry) => !stashBeforeHashes.has(entry.hash)) ??
        (stashAfter.length > stashBefore.length ? stashAfter[0] : undefined);

      const checkoutResult = yield* Effect.exit(checkoutBranch(input));
      if (Exit.isFailure(checkoutResult)) {
        if (createdStash) {
          const restoreResult = yield* executeGit(
            "GitCore.stashAndCheckout.restoreAfterCheckoutFailure.apply",
            input.cwd,
            ["stash", "apply", createdStash.hash],
            { timeoutMs: 30_000, allowNonZeroExit: true },
          );
          if (restoreResult.code === 0) {
            yield* dropStashByHash(input.cwd, createdStash.hash).pipe(
              Effect.catchTag("GitCommandError", (error) =>
                Effect.logWarning(
                  `Could not drop restored stash ${createdStash.hash}: ${error.message}`,
                ),
              ),
            );
          }
        }
        return yield* Effect.failCause(checkoutResult.cause);
      }

      if (!createdStash) return;

      // Apply first, then drop only after success so failed/conflicted reapplies keep the stash intact.
      const applyResult = yield* executeGit(
        "GitCore.stashAndCheckout.stashApply",
        input.cwd,
        ["stash", "apply", createdStash.hash],
        { timeoutMs: 30_000, allowNonZeroExit: true },
      );
      if (applyResult.code === 0) {
        yield* dropStashByHash(input.cwd, createdStash.hash).pipe(
          Effect.catchTag("GitCommandError", (error) =>
            Effect.logWarning(
              `Could not drop reapplied stash ${createdStash.hash}: ${error.message}`,
            ),
          ),
        );
        return;
      }

      yield* executeGit(
        "GitCore.stashAndCheckout.abortConflictedApply",
        input.cwd,
        ["reset", "--hard"],
        { timeoutMs: 30_000, allowNonZeroExit: true },
      ).pipe(Effect.ignore);
      yield* executeGit(
        "GitCore.stashAndCheckout.cleanConflictedApply",
        input.cwd,
        ["clean", "-fd"],
        { timeoutMs: 30_000, allowNonZeroExit: true },
      ).pipe(Effect.ignore);

      return yield* createGitCommandError(
        "GitCore.stashAndCheckout.stashApply",
        input.cwd,
        ["stash", "apply", createdStash.hash],
        "Stash could not be applied. Your changes are still saved in the stash.",
      );
    });

  const listLocalBranchNames: GitCoreShape["listLocalBranchNames"] = (cwd) =>
    runGitStdout("GitCore.listLocalBranchNames", cwd, [
      "branch",
      "--list",
      "--format=%(refname:short)",
    ]).pipe(
      Effect.map((stdout) =>
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
    );

  return {
    listBranches,
    renameBranch,
    publishBranch,
    createBranch,
    deleteBranch,
    checkoutBranch,
    stashAndCheckout,
    listLocalBranchNames,
  };
};
