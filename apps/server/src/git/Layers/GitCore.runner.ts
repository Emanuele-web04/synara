// FILE: GitCore.runner.ts
// Purpose: Shared git-runner helpers (executeGit/runGit/runGitStdout) plus remote/upstream
//   resolution and the status-upstream refresh cache, parameterized by the raw `execute` runner.
// Layer: dependency-parameterized Effect factory; built once per GitCore via makeGitRunner(deps).
// Exports: GitRunner, GitRunnerDeps, makeGitRunner.
import { Cache, Data, Duration, Effect, Exit } from "effect";

import { GitCommandError } from "../Errors.ts";
import type { GitCoreShape } from "../Services/GitCore.ts";
import {
  parseDefaultBranchFromRemoteHeadRef,
  parseRemoteFetchUrls,
  parseRemoteNames,
  sanitizeRemoteName,
  normalizeRemoteUrl,
} from "./GitCore.parsing.ts";
import { commandLabel, createGitCommandError } from "./GitCore.commands.ts";
import {
  DEFAULT_BASE_BRANCH_CANDIDATES,
  STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
  STATUS_UPSTREAM_REFRESH_INTERVAL,
  STATUS_UPSTREAM_REFRESH_TIMEOUT,
  type ExecuteGitOptions,
} from "./GitCore.types.ts";

export type Upstream = {
  upstreamRef: string;
  remoteName: string;
  upstreamBranch: string;
};

class StatusUpstreamRefreshCacheKey extends Data.Class<{
  cwd: string;
  upstreamRef: string;
  remoteName: string;
  upstreamBranch: string;
}> {}

export interface GitRunnerDeps {
  readonly execute: GitCoreShape["execute"];
}

export interface GitRunner {
  readonly execute: GitCoreShape["execute"];
  readonly executeGit: (
    operation: string,
    cwd: string,
    args: readonly string[],
    options?: ExecuteGitOptions,
  ) => Effect.Effect<{ code: number; stdout: string; stderr: string }, GitCommandError>;
  readonly runGit: (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit?: boolean,
  ) => Effect.Effect<void, GitCommandError>;
  readonly runGitStdout: (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit?: boolean,
  ) => Effect.Effect<string, GitCommandError>;
  readonly branchExists: (cwd: string, branch: string) => Effect.Effect<boolean, GitCommandError>;
  readonly resolveAvailableBranchName: (
    cwd: string,
    desiredBranch: string,
  ) => Effect.Effect<string, GitCommandError>;
  readonly resolveCurrentUpstream: (cwd: string) => Effect.Effect<Upstream | null, GitCommandError>;
  readonly fetchUpstreamRef: (
    cwd: string,
    upstream: Upstream,
  ) => Effect.Effect<void, GitCommandError>;
  readonly refreshStatusUpstreamIfStale: (cwd: string) => Effect.Effect<void, GitCommandError>;
  readonly refreshCheckedOutBranchUpstream: (cwd: string) => Effect.Effect<void, GitCommandError>;
  readonly resolveDefaultBranchName: (
    cwd: string,
    remoteName: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  readonly remoteBranchExists: (
    cwd: string,
    remoteName: string,
    branch: string,
  ) => Effect.Effect<boolean, GitCommandError>;
  readonly originRemoteExists: (cwd: string) => Effect.Effect<boolean, GitCommandError>;
  readonly listRemoteNames: (cwd: string) => Effect.Effect<ReadonlyArray<string>, GitCommandError>;
  readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>;
  readonly resolvePushRemoteName: (
    cwd: string,
    branch: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  readonly ensureRemote: GitCoreShape["ensureRemote"];
  readonly resolveBaseBranchForNoUpstream: (
    cwd: string,
    branch: string,
  ) => Effect.Effect<string | null, GitCommandError>;
}

export const makeGitRunner = (deps: GitRunnerDeps) =>
  Effect.gen(function* () {
    const { execute } = deps;

    const executeGit = (
      operation: string,
      cwd: string,
      args: readonly string[],
      options: ExecuteGitOptions = {},
    ): Effect.Effect<{ code: number; stdout: string; stderr: string }, GitCommandError> =>
      execute({
        operation,
        cwd,
        args,
        allowNonZeroExit: true,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.progress ? { progress: options.progress } : {}),
      }).pipe(
        Effect.flatMap((result) => {
          if (options.allowNonZeroExit || result.code === 0) {
            return Effect.succeed(result);
          }
          const stderr = result.stderr.trim();
          if (stderr.length > 0) {
            return Effect.fail(createGitCommandError(operation, cwd, args, stderr));
          }
          if (options.fallbackErrorMessage) {
            return Effect.fail(
              createGitCommandError(operation, cwd, args, options.fallbackErrorMessage),
            );
          }
          return Effect.fail(
            createGitCommandError(
              operation,
              cwd,
              args,
              `${commandLabel(args)} failed: code=${result.code ?? "null"}`,
            ),
          );
        }),
      );

    const runGit = (
      operation: string,
      cwd: string,
      args: readonly string[],
      allowNonZeroExit = false,
    ): Effect.Effect<void, GitCommandError> =>
      executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(Effect.asVoid);

    const runGitStdout = (
      operation: string,
      cwd: string,
      args: readonly string[],
      allowNonZeroExit = false,
    ): Effect.Effect<string, GitCommandError> =>
      executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(
        Effect.map((result) => result.stdout),
      );

    const branchExists = (cwd: string, branch: string): Effect.Effect<boolean, GitCommandError> =>
      executeGit(
        "GitCore.branchExists",
        cwd,
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        },
      ).pipe(Effect.map((result) => result.code === 0));

    const resolveAvailableBranchName = (
      cwd: string,
      desiredBranch: string,
    ): Effect.Effect<string, GitCommandError> =>
      Effect.gen(function* () {
        const isDesiredTaken = yield* branchExists(cwd, desiredBranch);
        if (!isDesiredTaken) {
          return desiredBranch;
        }

        for (let suffix = 1; suffix <= 100; suffix += 1) {
          const candidate = `${desiredBranch}-${suffix}`;
          const isCandidateTaken = yield* branchExists(cwd, candidate);
          if (!isCandidateTaken) {
            return candidate;
          }
        }

        return yield* createGitCommandError(
          "GitCore.renameBranch",
          cwd,
          ["branch", "-m", "--", desiredBranch],
          `Could not find an available branch name for '${desiredBranch}'.`,
        );
      });

    const resolveCurrentUpstream = (cwd: string): Effect.Effect<Upstream | null, GitCommandError> =>
      Effect.gen(function* () {
        const upstreamRef = yield* runGitStdout(
          "GitCore.resolveCurrentUpstream",
          cwd,
          ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
          true,
        ).pipe(Effect.map((stdout) => stdout.trim()));

        if (upstreamRef.length === 0 || upstreamRef === "@{upstream}") {
          return null;
        }

        const separatorIndex = upstreamRef.indexOf("/");
        if (separatorIndex <= 0) {
          return null;
        }
        const remoteName = upstreamRef.slice(0, separatorIndex);
        const upstreamBranch = upstreamRef.slice(separatorIndex + 1);
        if (remoteName.length === 0 || upstreamBranch.length === 0) {
          return null;
        }

        return {
          upstreamRef,
          remoteName,
          upstreamBranch,
        };
      });

    const fetchUpstreamRef = (
      cwd: string,
      upstream: Upstream,
    ): Effect.Effect<void, GitCommandError> => {
      const refspec = `+refs/heads/${upstream.upstreamBranch}:refs/remotes/${upstream.upstreamRef}`;
      return runGit(
        "GitCore.fetchUpstreamRef",
        cwd,
        ["fetch", "--quiet", "--no-tags", upstream.remoteName, refspec],
        true,
      );
    };

    const fetchUpstreamRefForStatus = (
      cwd: string,
      upstream: Upstream,
    ): Effect.Effect<void, GitCommandError> => {
      const refspec = `+refs/heads/${upstream.upstreamBranch}:refs/remotes/${upstream.upstreamRef}`;
      return executeGit(
        "GitCore.fetchUpstreamRefForStatus",
        cwd,
        ["fetch", "--quiet", "--no-tags", upstream.remoteName, refspec],
        {
          allowNonZeroExit: true,
          timeoutMs: Duration.toMillis(STATUS_UPSTREAM_REFRESH_TIMEOUT),
        },
      ).pipe(Effect.asVoid);
    };

    const statusUpstreamRefreshCache = yield* Cache.makeWith({
      capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
      lookup: (cacheKey: StatusUpstreamRefreshCacheKey) =>
        Effect.gen(function* () {
          yield* fetchUpstreamRefForStatus(cacheKey.cwd, {
            upstreamRef: cacheKey.upstreamRef,
            remoteName: cacheKey.remoteName,
            upstreamBranch: cacheKey.upstreamBranch,
          });
          return true as const;
        }),
      // Keep successful refreshes warm; drop failures immediately so next request can retry.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? STATUS_UPSTREAM_REFRESH_INTERVAL : Duration.zero,
    });

    const refreshStatusUpstreamIfStale = (cwd: string): Effect.Effect<void, GitCommandError> =>
      Effect.gen(function* () {
        const upstream = yield* resolveCurrentUpstream(cwd);
        if (!upstream) return;
        yield* Cache.get(
          statusUpstreamRefreshCache,
          new StatusUpstreamRefreshCacheKey({
            cwd,
            upstreamRef: upstream.upstreamRef,
            remoteName: upstream.remoteName,
            upstreamBranch: upstream.upstreamBranch,
          }),
        );
      });

    const refreshCheckedOutBranchUpstream = (cwd: string): Effect.Effect<void, GitCommandError> =>
      Effect.gen(function* () {
        const upstream = yield* resolveCurrentUpstream(cwd);
        if (!upstream) return;
        yield* fetchUpstreamRef(cwd, upstream);
      });

    const resolveDefaultBranchName = (
      cwd: string,
      remoteName: string,
    ): Effect.Effect<string | null, GitCommandError> =>
      executeGit(
        "GitCore.resolveDefaultBranchName",
        cwd,
        ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`],
        { allowNonZeroExit: true },
      ).pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          return parseDefaultBranchFromRemoteHeadRef(result.stdout, remoteName);
        }),
      );

    const remoteBranchExists = (
      cwd: string,
      remoteName: string,
      branch: string,
    ): Effect.Effect<boolean, GitCommandError> =>
      executeGit(
        "GitCore.remoteBranchExists",
        cwd,
        ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteName}/${branch}`],
        {
          allowNonZeroExit: true,
        },
      ).pipe(Effect.map((result) => result.code === 0));

    const originRemoteExists = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
      executeGit("GitCore.originRemoteExists", cwd, ["remote", "get-url", "origin"], {
        allowNonZeroExit: true,
      }).pipe(Effect.map((result) => result.code === 0));

    const listRemoteNames = (cwd: string): Effect.Effect<ReadonlyArray<string>, GitCommandError> =>
      runGitStdout("GitCore.listRemoteNames", cwd, ["remote"]).pipe(
        Effect.map((stdout) => parseRemoteNames(stdout).toReversed()),
      );

    const resolvePrimaryRemoteName = (cwd: string): Effect.Effect<string, GitCommandError> =>
      Effect.gen(function* () {
        if (yield* originRemoteExists(cwd)) {
          return "origin";
        }
        const remotes = yield* listRemoteNames(cwd);
        const [firstRemote] = remotes;
        if (firstRemote) {
          return firstRemote;
        }
        return yield* createGitCommandError(
          "GitCore.resolvePrimaryRemoteName",
          cwd,
          ["remote"],
          "No git remote is configured for this repository.",
        );
      });

    const resolvePushRemoteName = (
      cwd: string,
      branch: string,
    ): Effect.Effect<string | null, GitCommandError> =>
      Effect.gen(function* () {
        const branchPushRemote = yield* runGitStdout(
          "GitCore.resolvePushRemoteName.branchPushRemote",
          cwd,
          ["config", "--get", `branch.${branch}.pushRemote`],
          true,
        ).pipe(Effect.map((stdout) => stdout.trim()));
        if (branchPushRemote.length > 0) {
          return branchPushRemote;
        }

        const pushDefaultRemote = yield* runGitStdout(
          "GitCore.resolvePushRemoteName.remotePushDefault",
          cwd,
          ["config", "--get", "remote.pushDefault"],
          true,
        ).pipe(Effect.map((stdout) => stdout.trim()));
        if (pushDefaultRemote.length > 0) {
          return pushDefaultRemote;
        }

        return yield* resolvePrimaryRemoteName(cwd).pipe(Effect.catch(() => Effect.succeed(null)));
      });

    const ensureRemote: GitCoreShape["ensureRemote"] = (input) =>
      Effect.gen(function* () {
        const preferredName = sanitizeRemoteName(input.preferredName);
        const normalizedTargetUrl = normalizeRemoteUrl(input.url);
        const remoteFetchUrls = yield* runGitStdout(
          "GitCore.ensureRemote.listRemoteUrls",
          input.cwd,
          ["remote", "-v"],
        ).pipe(Effect.map((stdout) => parseRemoteFetchUrls(stdout)));

        for (const [remoteName, remoteUrl] of remoteFetchUrls.entries()) {
          if (normalizeRemoteUrl(remoteUrl) === normalizedTargetUrl) {
            return remoteName;
          }
        }

        let remoteName = preferredName;
        let suffix = 1;
        while (remoteFetchUrls.has(remoteName)) {
          remoteName = `${preferredName}-${suffix}`;
          suffix += 1;
        }

        yield* runGit("GitCore.ensureRemote.add", input.cwd, [
          "remote",
          "add",
          remoteName,
          input.url,
        ]);
        return remoteName;
      });

    const resolveBaseBranchForNoUpstream = (
      cwd: string,
      branch: string,
    ): Effect.Effect<string | null, GitCommandError> =>
      Effect.gen(function* () {
        const configuredBaseBranch = yield* runGitStdout(
          "GitCore.resolveBaseBranchForNoUpstream.config",
          cwd,
          ["config", "--get", `branch.${branch}.gh-merge-base`],
          true,
        ).pipe(Effect.map((stdout) => stdout.trim()));

        const primaryRemoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        const defaultBranch =
          primaryRemoteName === null
            ? null
            : yield* resolveDefaultBranchName(cwd, primaryRemoteName);
        const candidates = [
          configuredBaseBranch.length > 0 ? configuredBaseBranch : null,
          defaultBranch,
          ...DEFAULT_BASE_BRANCH_CANDIDATES,
        ];

        for (const candidate of candidates) {
          if (!candidate) {
            continue;
          }

          const remotePrefix =
            primaryRemoteName && primaryRemoteName !== "origin" ? `${primaryRemoteName}/` : null;
          const normalizedCandidate = candidate.startsWith("origin/")
            ? candidate.slice("origin/".length)
            : remotePrefix && candidate.startsWith(remotePrefix)
              ? candidate.slice(remotePrefix.length)
              : candidate;
          if (normalizedCandidate.length === 0 || normalizedCandidate === branch) {
            continue;
          }

          if (yield* branchExists(cwd, normalizedCandidate)) {
            return normalizedCandidate;
          }

          if (
            primaryRemoteName &&
            (yield* remoteBranchExists(cwd, primaryRemoteName, normalizedCandidate))
          ) {
            return `${primaryRemoteName}/${normalizedCandidate}`;
          }
        }

        return null;
      });

    return {
      execute,
      executeGit,
      runGit,
      runGitStdout,
      branchExists,
      resolveAvailableBranchName,
      resolveCurrentUpstream,
      fetchUpstreamRef,
      refreshStatusUpstreamIfStale,
      refreshCheckedOutBranchUpstream,
      resolveDefaultBranchName,
      remoteBranchExists,
      originRemoteExists,
      listRemoteNames,
      resolvePrimaryRemoteName,
      resolvePushRemoteName,
      ensureRemote,
      resolveBaseBranchForNoUpstream,
    } satisfies GitRunner;
  });
