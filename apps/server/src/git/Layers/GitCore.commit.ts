// FILE: GitCore.commit.ts
// Purpose: Commit-context staging, commit, and push/pull-current-branch operations for the
//   GitCore service.
// Layer: dependency-parameterized factory; built once per GitCore via makeGitCommit(deps).
// Exports: GitCommit, GitCommitDeps, makeGitCommit.
import { Effect } from "effect";

import type { GitCommitOptions, GitCoreShape } from "../Services/GitCore.ts";
import type { GitRunner } from "./GitCore.runner.ts";
import { createGitCommandError, explainPullBlockedByLocalChanges } from "./GitCore.commands.ts";

export interface GitCommitDeps {
  readonly runner: GitRunner;
  readonly statusDetails: GitCoreShape["statusDetails"];
}

export interface GitCommit {
  readonly prepareCommitContext: GitCoreShape["prepareCommitContext"];
  readonly commit: GitCoreShape["commit"];
  readonly pushCurrentBranch: GitCoreShape["pushCurrentBranch"];
  readonly pullCurrentBranch: GitCoreShape["pullCurrentBranch"];
}

export const makeGitCommit = (deps: GitCommitDeps): GitCommit => {
  const { statusDetails } = deps;
  const {
    executeGit,
    runGit,
    runGitStdout,
    resolveCurrentUpstream,
    remoteBranchExists,
    resolvePushRemoteName,
    resolveBaseBranchForNoUpstream,
  } = deps.runner;

  const prepareCommitContext: GitCoreShape["prepareCommitContext"] = (cwd, filePaths) =>
    Effect.gen(function* () {
      if (filePaths && filePaths.length > 0) {
        yield* runGit("GitCore.prepareCommitContext.reset", cwd, ["reset"]).pipe(
          Effect.catch(() => Effect.void),
        );
        yield* runGit("GitCore.prepareCommitContext.addSelected", cwd, [
          "add",
          "-A",
          "--",
          ...filePaths,
        ]);
      } else {
        yield* runGit("GitCore.prepareCommitContext.addAll", cwd, ["add", "-A"]);
      }

      const stagedSummary = yield* runGitStdout("GitCore.prepareCommitContext.stagedSummary", cwd, [
        "diff",
        "--cached",
        "--name-status",
      ]).pipe(Effect.map((stdout) => stdout.trim()));
      if (stagedSummary.length === 0) {
        return null;
      }

      const stagedPatch = yield* runGitStdout("GitCore.prepareCommitContext.stagedPatch", cwd, [
        "diff",
        "--cached",
        "--patch",
        "--minimal",
      ]);

      return {
        stagedSummary,
        stagedPatch,
      };
    });

  const commit: GitCoreShape["commit"] = (cwd, subject, body, options?: GitCommitOptions) =>
    Effect.gen(function* () {
      const args = ["commit", "-m", subject];
      const trimmedBody = body.trim();
      if (trimmedBody.length > 0) {
        args.push("-m", trimmedBody);
      }
      const progress = options?.progress
        ? {
            ...(options.progress.onOutputLine
              ? {
                  onStdoutLine: (line: string) =>
                    options.progress?.onOutputLine?.({ stream: "stdout", text: line }) ??
                    Effect.void,
                  onStderrLine: (line: string) =>
                    options.progress?.onOutputLine?.({ stream: "stderr", text: line }) ??
                    Effect.void,
                }
              : {}),
            ...(options.progress.onHookStarted
              ? { onHookStarted: options.progress.onHookStarted }
              : {}),
            ...(options.progress.onHookFinished
              ? { onHookFinished: options.progress.onHookFinished }
              : {}),
          }
        : null;
      yield* executeGit("GitCore.commit.commit", cwd, args, {
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(progress ? { progress } : {}),
      }).pipe(Effect.asVoid);
      const commitSha = yield* runGitStdout("GitCore.commit.revParseHead", cwd, [
        "rev-parse",
        "HEAD",
      ]).pipe(Effect.map((stdout) => stdout.trim()));

      return { commitSha };
    });

  const pushCurrentBranch: GitCoreShape["pushCurrentBranch"] = (cwd, fallbackBranch) =>
    Effect.gen(function* () {
      const details = yield* statusDetails(cwd);
      const branch = details.branch ?? fallbackBranch;
      if (!branch) {
        return yield* createGitCommandError(
          "GitCore.pushCurrentBranch",
          cwd,
          ["push"],
          "Cannot push from detached HEAD.",
        );
      }

      const hasNoLocalDelta = details.aheadCount === 0 && details.behindCount === 0;
      if (hasNoLocalDelta) {
        if (details.hasUpstream) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
            ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
          };
        }

        const comparableBaseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (comparableBaseBranch) {
          const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          if (!publishRemoteName) {
            return {
              status: "skipped_up_to_date" as const,
              branch,
            };
          }

          const hasRemoteBranch = yield* remoteBranchExists(cwd, publishRemoteName, branch).pipe(
            Effect.catch(() => Effect.succeed(false)),
          );
          if (hasRemoteBranch) {
            return {
              status: "skipped_up_to_date" as const,
              branch,
            };
          }
        }
      }

      if (!details.hasUpstream) {
        const publishRemoteName = yield* resolvePushRemoteName(cwd, branch);
        if (!publishRemoteName) {
          return yield* createGitCommandError(
            "GitCore.pushCurrentBranch",
            cwd,
            ["push"],
            "Cannot push because no git remote is configured for this repository.",
          );
        }
        yield* runGit("GitCore.pushCurrentBranch.pushWithUpstream", cwd, [
          "push",
          "-u",
          publishRemoteName,
          branch,
        ]);
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: `${publishRemoteName}/${branch}`,
          setUpstream: true,
        };
      }

      const currentUpstream = yield* resolveCurrentUpstream(cwd).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (currentUpstream) {
        yield* runGit("GitCore.pushCurrentBranch.pushUpstream", cwd, [
          "push",
          currentUpstream.remoteName,
          `HEAD:${currentUpstream.upstreamBranch}`,
        ]);
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: currentUpstream.upstreamRef,
          setUpstream: false,
        };
      }

      yield* runGit("GitCore.pushCurrentBranch.push", cwd, ["push"]);
      return {
        status: "pushed" as const,
        branch,
        ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
        setUpstream: false,
      };
    });

  const pullCurrentBranch: GitCoreShape["pullCurrentBranch"] = (cwd) =>
    Effect.gen(function* () {
      const details = yield* statusDetails(cwd);
      const branch = details.branch;
      if (!branch) {
        return yield* createGitCommandError(
          "GitCore.pullCurrentBranch",
          cwd,
          ["pull", "--ff-only"],
          "Cannot pull from detached HEAD.",
        );
      }
      if (!details.hasUpstream) {
        return yield* createGitCommandError(
          "GitCore.pullCurrentBranch",
          cwd,
          ["pull", "--ff-only"],
          "Current branch has no upstream configured. Push with upstream first.",
        );
      }
      const beforeSha = yield* runGitStdout(
        "GitCore.pullCurrentBranch.beforeSha",
        cwd,
        ["rev-parse", "HEAD"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));
      yield* executeGit("GitCore.pullCurrentBranch.pull", cwd, ["pull", "--ff-only"], {
        timeoutMs: 30_000,
        fallbackErrorMessage: "git pull failed",
      }).pipe(
        Effect.mapError((error) => {
          const friendlyDetail = explainPullBlockedByLocalChanges(error);
          if (!friendlyDetail) return error;
          return createGitCommandError(
            "GitCore.pullCurrentBranch.pull",
            cwd,
            ["pull", "--ff-only"],
            friendlyDetail,
            error,
          );
        }),
      );
      const afterSha = yield* runGitStdout(
        "GitCore.pullCurrentBranch.afterSha",
        cwd,
        ["rev-parse", "HEAD"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      const refreshed = yield* statusDetails(cwd);
      return {
        status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
        branch,
        upstreamBranch: refreshed.upstreamRef,
      };
    });

  return { prepareCommitContext, commit, pushCurrentBranch, pullCurrentBranch };
};
