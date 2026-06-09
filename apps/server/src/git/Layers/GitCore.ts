// FILE: GitCore.ts
// Purpose: Implements low-level Git operations used by server orchestration and UI status.
// Layer: Server Git service
// Exports: GitCoreLive plus makeGitCore test factory.
import { Cache, Data, Duration, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

import { GitCheckoutDirtyWorktreeError, GitCommandError } from "../Errors.ts";
import {
  GitCore,
  type GitCommitOptions,
  type GitCoreShape,
  type ExecuteGitResult,
} from "../Services/GitCore.ts";
import { ServerConfig } from "../../config.ts";
import { collectOutput, createTrace2Monitor } from "./GitCore.process.ts";
import {
  AUTO_DETACHED_WORKTREE_DIRNAME,
  DEFAULT_BASE_BRANCH_CANDIDATES,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  EMPTY_TREE_OBJECT_ID,
  MAX_UNTRACKED_DIFF_CONCURRENCY,
  MOVE_AWARE_WORKING_TREE_STATUS_TIMEOUT_MS,
  NON_REPOSITORY_STATUS_DETAILS,
  STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
  STATUS_UPSTREAM_REFRESH_INTERVAL,
  STATUS_UPSTREAM_REFRESH_TIMEOUT,
  WORKING_TREE_DIFF_TIMEOUT_MS,
  type ExecuteGitOptions,
  type StashEntry,
  type TraceTailState,
  type WorkingTreeStatSummary,
} from "./GitCore.types.ts";
import {
  countTextLines,
  deriveLocalBranchNameFromRemoteRef,
  joinPatchSegments,
  normalizeConfiguredMergeBranch,
  normalizeRemoteUrl,
  parseBranchAb,
  parseBranchLine,
  parseDefaultBranchFromRemoteHeadRef,
  parseDirtyWorktreeFiles,
  parseNonEmptyLineList,
  parseNumstatEntries,
  parsePorcelainPath,
  parseRemoteFetchUrls,
  parseRemoteNames,
  parseRemoteRefWithRemoteNames,
  parseStashEntries,
  parseTrackingBranchByUpstreamRef,
  sanitizeRemoteName,
  summarizeNumstatEntries,
} from "./GitCore.parsing.ts";
import {
  commandLabel,
  createGitCommandError,
  explainPullBlockedByLocalChanges,
  hasNodeErrorCode,
  isMissingGitCwdError,
  quoteGitCommand,
  resolveGitPath,
  toGitCommandError,
} from "./GitCore.commands.ts";

class StatusUpstreamRefreshCacheKey extends Data.Class<{
  cwd: string;
  upstreamRef: string;
  remoteName: string;
  upstreamBranch: string;
}> {}

export const makeGitCore = (options?: { executeOverride?: GitCoreShape["execute"] }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { worktreesDir } = yield* ServerConfig;

    const buildGeneratedDetachedWorktreePath = (cwd: string) =>
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

    let execute: GitCoreShape["execute"];

    if (options?.executeOverride) {
      execute = options.executeOverride;
    } else {
      const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      execute = Effect.fnUntraced(function* (input) {
        const commandInput = {
          ...input,
          args: [...input.args],
        } as const;
        const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

        const commandEffect = Effect.gen(function* () {
          const trace2Monitor = yield* createTrace2Monitor(commandInput, input.progress).pipe(
            Effect.provideService(Path.Path, path),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.mapError(toGitCommandError(commandInput, "failed to create trace2 monitor.")),
          );
          const child = yield* commandSpawner
            .spawn(
              ChildProcess.make("git", commandInput.args, {
                cwd: commandInput.cwd,
                env: {
                  ...process.env,
                  ...input.env,
                  ...trace2Monitor.env,
                },
              }),
            )
            .pipe(Effect.mapError(toGitCommandError(commandInput, "failed to spawn.")));

          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              collectOutput(
                commandInput,
                child.stdout,
                maxOutputBytes,
                input.progress?.onStdoutLine,
              ),
              collectOutput(
                commandInput,
                child.stderr,
                maxOutputBytes,
                input.progress?.onStderrLine,
              ),
              child.exitCode.pipe(
                Effect.map((value) => Number(value)),
                Effect.mapError(toGitCommandError(commandInput, "failed to report exit code.")),
              ),
            ],
            { concurrency: "unbounded" },
          );
          yield* trace2Monitor.flush;

          if (!input.allowNonZeroExit && exitCode !== 0) {
            const trimmedStderr = stderr.trim();
            return yield* new GitCommandError({
              operation: commandInput.operation,
              command: quoteGitCommand(commandInput.args),
              cwd: commandInput.cwd,
              detail:
                trimmedStderr.length > 0
                  ? `${quoteGitCommand(commandInput.args)} failed: ${trimmedStderr}`
                  : `${quoteGitCommand(commandInput.args)} failed with code ${exitCode}.`,
            });
          }

          return { code: exitCode, stdout, stderr } satisfies ExecuteGitResult;
        });

        return yield* commandEffect.pipe(
          Effect.scoped,
          Effect.timeoutOption(timeoutMs),
          Effect.flatMap((result) =>
            Option.match(result, {
              onNone: () =>
                Effect.fail(
                  new GitCommandError({
                    operation: commandInput.operation,
                    command: quoteGitCommand(commandInput.args),
                    cwd: commandInput.cwd,
                    detail: `${quoteGitCommand(commandInput.args)} timed out.`,
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
      });
    }

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

    const readMoveAwareWorkingTreeSummary = (
      cwd: string,
    ): Effect.Effect<WorkingTreeStatSummary | null, never> =>
      Effect.scoped(
        Effect.gen(function* () {
          const indexPathRaw = yield* runGitStdout(
            "GitCore.statusDetails.moveAwareIndexPath",
            cwd,
            ["rev-parse", "--git-path", "index"],
          ).pipe(Effect.map((stdout) => stdout.trim()));
          if (indexPathRaw.length === 0) {
            return null;
          }

          const tempIndexDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: `t3code-git-status-index-${process.pid}-`,
          });
          const tempIndexPath = nodePath.join(tempIndexDir, "index");
          yield* Effect.tryPromise(() =>
            nodeFs.copyFile(resolveGitPath(cwd, indexPathRaw), tempIndexPath),
          ).pipe(
            Effect.catch((cause) =>
              hasNodeErrorCode(cause, "ENOENT") ? Effect.void : Effect.fail(cause),
            ),
          );

          const tempIndexEnv = { GIT_INDEX_FILE: tempIndexPath };
          // Stage into a copied index only; this lets Git detect directory refactors
          // without touching the user's real staging area.
          yield* executeGit(
            "GitCore.statusDetails.moveAwareAddAll",
            cwd,
            ["add", "-A", "--", ":/"],
            {
              env: tempIndexEnv,
              timeoutMs: MOVE_AWARE_WORKING_TREE_STATUS_TIMEOUT_MS,
              fallbackErrorMessage: "git add -A failed while summarizing working tree status",
            },
          );

          const numstatStdout = yield* executeGit(
            "GitCore.statusDetails.moveAwareNumstat",
            cwd,
            ["diff", "--cached", "--numstat", "--find-renames"],
            {
              env: tempIndexEnv,
              allowNonZeroExit: true,
              timeoutMs: MOVE_AWARE_WORKING_TREE_STATUS_TIMEOUT_MS,
            },
          ).pipe(Effect.map((result) => result.stdout));

          return summarizeNumstatEntries(parseNumstatEntries(numstatStdout));
        }),
      ).pipe(
        Effect.catch((cause) =>
          Effect.logDebug(
            "GitCore.statusDetails: move-aware working tree summary failed",
            cause,
          ).pipe(Effect.as(null)),
        ),
      );

    const listStashEntries = (
      operation: string,
      cwd: string,
    ): Effect.Effect<StashEntry[], GitCommandError> =>
      executeGit(operation, cwd, ["stash", "list", "--format=%gd %H"], {
        timeoutMs: 10_000,
      }).pipe(Effect.map((result) => parseStashEntries(result.stdout)));

    const dropStashByHash = (cwd: string, hash: string): Effect.Effect<void, GitCommandError> =>
      Effect.gen(function* () {
        const entries = yield* listStashEntries("GitCore.dropStashByHash.list", cwd);
        const entry = entries.find((candidate) => candidate.hash === hash);
        if (!entry) return;
        yield* executeGit("GitCore.dropStashByHash.drop", cwd, ["stash", "drop", entry.ref], {
          timeoutMs: 10_000,
          fallbackErrorMessage: "git stash drop failed",
        });
      });

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

    const resolveCurrentUpstream = (
      cwd: string,
    ): Effect.Effect<
      { upstreamRef: string; remoteName: string; upstreamBranch: string } | null,
      GitCommandError
    > =>
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
      upstream: { upstreamRef: string; remoteName: string; upstreamBranch: string },
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
      upstream: { upstreamRef: string; remoteName: string; upstreamBranch: string },
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

    const computeAheadCountAgainstBase = (
      cwd: string,
      branch: string,
    ): Effect.Effect<number, GitCommandError> =>
      Effect.gen(function* () {
        const baseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch);
        if (!baseBranch) {
          return 0;
        }

        const result = yield* executeGit(
          "GitCore.computeAheadCountAgainstBase",
          cwd,
          ["rev-list", "--count", `${baseBranch}..HEAD`],
          { allowNonZeroExit: true },
        );
        if (result.code !== 0) {
          return 0;
        }

        const parsed = Number.parseInt(result.stdout.trim(), 10);
        return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
      });

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

    const statusDetails: GitCoreShape["statusDetails"] = (cwd) =>
      Effect.gen(function* () {
        yield* refreshStatusUpstreamIfStale(cwd).pipe(
          Effect.catchIf(isMissingGitCwdError, () => Effect.void),
          Effect.ignoreCause({ log: true }),
        );

        const statusStdout = yield* runGitStdout("GitCore.statusDetails.status", cwd, [
          "status",
          "--porcelain=2",
          "--branch",
        ]).pipe(Effect.catchIf(isMissingGitCwdError, () => Effect.succeed(null)));
        if (statusStdout === null) {
          return NON_REPOSITORY_STATUS_DETAILS;
        }

        let branch: string | null = null;
        let upstreamRef: string | null = null;
        let upstreamBranch: string | null = null;
        let aheadCount = 0;
        let behindCount = 0;
        let hasWorkingTreeChanges = false;
        let hasTrackedDeletion = false;
        let hasUntrackedDirectory = false;
        const changedFilesWithoutNumstat = new Set<string>();
        const untrackedFilesWithoutNumstat = new Set<string>();

        for (const line of statusStdout.split(/\r?\n/g)) {
          if (line.startsWith("# branch.head ")) {
            const value = line.slice("# branch.head ".length).trim();
            branch = value.startsWith("(") ? null : value;
            continue;
          }
          if (line.startsWith("# branch.upstream ")) {
            const value = line.slice("# branch.upstream ".length).trim();
            upstreamRef = value.length > 0 ? value : null;
            continue;
          }
          if (line.startsWith("# branch.ab ")) {
            const value = line.slice("# branch.ab ".length).trim();
            const parsed = parseBranchAb(value);
            aheadCount = parsed.ahead;
            behindCount = parsed.behind;
            continue;
          }
          if (line.trim().length > 0 && !line.startsWith("#")) {
            hasWorkingTreeChanges = true;
            const statusCode =
              line.startsWith("1 ") || line.startsWith("2 ") ? line.slice(2, 4) : "";
            if (statusCode.includes("D")) {
              hasTrackedDeletion = true;
            }
            const pathValue = parsePorcelainPath(line);
            if (pathValue) {
              changedFilesWithoutNumstat.add(pathValue);
              if (line.startsWith("? ")) {
                untrackedFilesWithoutNumstat.add(pathValue);
                if (pathValue.endsWith("/")) {
                  hasUntrackedDirectory = true;
                }
              }
            }
          }
        }

        if (branch && upstreamRef) {
          upstreamBranch = yield* runGitStdout(
            "GitCore.statusDetails.upstreamMergeBranch",
            cwd,
            ["config", "--get", `branch.${branch}.merge`],
            true,
          ).pipe(
            Effect.map(normalizeConfiguredMergeBranch),
            Effect.catch(() => Effect.succeed(null)),
          );
        }

        if (!upstreamRef && branch) {
          aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
            Effect.catch(() => Effect.succeed(0)),
          );
          behindCount = 0;
        }

        const moveAwareWorkingTree =
          hasWorkingTreeChanges &&
          untrackedFilesWithoutNumstat.size > 0 &&
          (hasTrackedDeletion || hasUntrackedDirectory)
            ? yield* readMoveAwareWorkingTreeSummary(cwd)
            : null;
        if (moveAwareWorkingTree) {
          return {
            branch,
            upstreamRef,
            upstreamBranch,
            hasWorkingTreeChanges,
            workingTree: moveAwareWorkingTree,
            hasUpstream: upstreamRef !== null,
            aheadCount,
            behindCount,
          };
        }

        const numstatOutputs = yield* Effect.all(
          [
            runGitStdout("GitCore.statusDetails.unstagedNumstat", cwd, ["diff", "--numstat"]),
            runGitStdout("GitCore.statusDetails.stagedNumstat", cwd, [
              "diff",
              "--cached",
              "--numstat",
            ]),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.catchIf(isMissingGitCwdError, () => Effect.succeed(null)));
        if (numstatOutputs === null) {
          return NON_REPOSITORY_STATUS_DETAILS;
        }

        const [unstagedNumstatStdout, stagedNumstatStdout] = numstatOutputs;
        const stagedEntries = parseNumstatEntries(stagedNumstatStdout);
        const unstagedEntries = parseNumstatEntries(unstagedNumstatStdout);
        const workingTree = summarizeNumstatEntries([...stagedEntries, ...unstagedEntries]);
        const files = [...workingTree.files];
        const numstatFilePaths = new Set(files.map((file) => file.path));
        const filePathsWithStats = new Set(numstatFilePaths);
        let insertions = workingTree.insertions;
        let deletions = workingTree.deletions;

        for (const filePath of changedFilesWithoutNumstat) {
          if (filePathsWithStats.has(filePath)) continue;

          const insertions = untrackedFilesWithoutNumstat.has(filePath)
            ? yield* Effect.tryPromise(() => nodeFs.readFile(nodePath.join(cwd, filePath))).pipe(
                Effect.map((contents) => countTextLines(new Uint8Array(contents))),
                Effect.catch(() => Effect.succeed(0)),
              )
            : 0;

          files.push({ path: filePath, insertions, deletions: 0 });
          filePathsWithStats.add(filePath);
        }
        files.sort((a, b) => a.path.localeCompare(b.path));

        for (const file of files) {
          if (numstatFilePaths.has(file.path)) continue;
          insertions += file.insertions;
          deletions += file.deletions;
        }

        return {
          branch,
          upstreamRef,
          upstreamBranch,
          hasWorkingTreeChanges,
          workingTree: {
            files,
            insertions,
            deletions,
          },
          hasUpstream: upstreamRef !== null,
          aheadCount,
          behindCount,
        };
      });

    const status: GitCoreShape["status"] = (input) =>
      statusDetails(input.cwd).pipe(
        Effect.map((details) => ({
          branch: details.branch,
          hasWorkingTreeChanges: details.hasWorkingTreeChanges,
          workingTree: details.workingTree,
          hasUpstream: details.hasUpstream,
          upstreamBranch: details.upstreamBranch,
          aheadCount: details.aheadCount,
          behindCount: details.behindCount,
          pr: null,
        })),
      );

    const readUntrackedPatches = (cwd: string, operationPrefix: string) =>
      runGitStdout(
        `${operationPrefix}.untrackedFiles`,
        cwd,
        ["ls-files", "--others", "--exclude-standard", "-z"],
        true,
      ).pipe(
        Effect.map((stdout) => stdout.split("\0").filter((entry) => entry.length > 0)),
        Effect.flatMap((untrackedFiles) =>
          Effect.forEach(
            untrackedFiles,
            (filePath) =>
              // Git diff omits untracked files, so synthesize a normal patch for each one.
              executeGit(
                `${operationPrefix}.untrackedPatch`,
                cwd,
                [
                  "diff",
                  "--no-index",
                  "--patch",
                  "--no-color",
                  "--src-prefix=a/",
                  "--dst-prefix=b/",
                  "--",
                  "/dev/null",
                  filePath,
                ],
                {
                  allowNonZeroExit: true,
                  timeoutMs: WORKING_TREE_DIFF_TIMEOUT_MS,
                },
              ).pipe(Effect.map((result) => result.stdout)),
            { concurrency: MAX_UNTRACKED_DIFF_CONCURRENCY },
          ),
        ),
      );

    const readUnstagedPatch: GitCoreShape["readUnstagedPatch"] = (cwd) =>
      Effect.gen(function* () {
        const trackedPatch = yield* executeGit(
          "GitCore.readUnstagedPatch.trackedPatch",
          cwd,
          ["diff", "--patch", "--no-color", "--no-ext-diff"],
          {
            allowNonZeroExit: true,
            timeoutMs: WORKING_TREE_DIFF_TIMEOUT_MS,
          },
        ).pipe(Effect.map((result) => result.stdout));
        const untrackedPatches = yield* readUntrackedPatches(cwd, "GitCore.readUnstagedPatch");

        return {
          patch: joinPatchSegments([trackedPatch, ...untrackedPatches]),
        };
      });

    const readStagedPatch: GitCoreShape["readStagedPatch"] = (cwd) =>
      executeGit(
        "GitCore.readStagedPatch",
        cwd,
        ["diff", "--cached", "--patch", "--no-color", "--no-ext-diff"],
        {
          allowNonZeroExit: true,
          timeoutMs: WORKING_TREE_DIFF_TIMEOUT_MS,
        },
      ).pipe(Effect.map((result) => ({ patch: result.stdout })));

    const readWorkingTreePatch: GitCoreShape["readWorkingTreePatch"] = (cwd) =>
      Effect.gen(function* () {
        const headExists = yield* executeGit(
          "GitCore.readWorkingTreePatch.headExists",
          cwd,
          ["rev-parse", "--verify", "HEAD"],
          { allowNonZeroExit: true },
        ).pipe(Effect.map((result) => result.code === 0));

        const trackedPatch = yield* executeGit(
          "GitCore.readWorkingTreePatch.trackedPatch",
          cwd,
          headExists
            ? ["diff", "--patch", "--no-color", "--no-ext-diff", "HEAD"]
            : ["diff", "--patch", "--no-color", "--no-ext-diff", EMPTY_TREE_OBJECT_ID],
          {
            allowNonZeroExit: true,
            timeoutMs: WORKING_TREE_DIFF_TIMEOUT_MS,
          },
        ).pipe(Effect.map((result) => result.stdout));

        const untrackedPatches = yield* readUntrackedPatches(cwd, "GitCore.readWorkingTreePatch");

        return {
          patch: joinPatchSegments([trackedPatch, ...untrackedPatches]),
        };
      });

    const readBranchPatch: GitCoreShape["readBranchPatch"] = (cwd) =>
      Effect.gen(function* () {
        const details = yield* statusDetails(cwd);
        const baseBranch =
          details.upstreamRef ??
          (details.branch
            ? yield* resolveBaseBranchForNoUpstream(cwd, details.branch).pipe(
                Effect.catch(() => Effect.succeed(null)),
              )
            : null);
        if (!baseBranch) {
          return yield* createGitCommandError(
            "GitCore.readBranchPatch.base",
            cwd,
            ["diff", "--patch", "--minimal", "<base>...HEAD"],
            "Cannot resolve a base branch for the current branch diff.",
          );
        }

        const result = yield* execute({
          operation: "GitCore.readBranchPatch.diffPatch",
          cwd,
          args: [
            "diff",
            "--patch",
            "--minimal",
            "--no-color",
            "--no-ext-diff",
            `${baseBranch}...HEAD`,
          ],
          maxOutputBytes: 10_000_000,
        });

        return { patch: result.stdout };
      });

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

        const stagedSummary = yield* runGitStdout(
          "GitCore.prepareCommitContext.stagedSummary",
          cwd,
          ["diff", "--cached", "--name-status"],
        ).pipe(Effect.map((stdout) => stdout.trim()));
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

    const readRangeContext: GitCoreShape["readRangeContext"] = (cwd, baseBranch) =>
      Effect.gen(function* () {
        const range = `${baseBranch}..HEAD`;
        const [commitSummary, diffSummary, diffPatchResult] = yield* Effect.all(
          [
            runGitStdout("GitCore.readRangeContext.log", cwd, ["log", "--oneline", range]),
            runGitStdout("GitCore.readRangeContext.diffStat", cwd, ["diff", "--stat", range]),
            execute({
              operation: "GitCore.readRangeContext.diffPatch",
              cwd,
              args: ["diff", "--patch", "--minimal", range],
              maxOutputBytes: 10_000_000,
            }),
          ],
          { concurrency: "unbounded" },
        );
        const diffPatch = diffPatchResult.stdout;

        return {
          commitSummary,
          diffSummary,
          diffPatch,
        };
      });

    const readRangeDiff: GitCoreShape["readRangeDiff"] = (input) =>
      execute({
        operation: "GitCore.readRangeDiff",
        cwd: input.cwd,
        args: ["diff", "--patch", "--no-color", "--no-ext-diff", `${input.base}...${input.head}`],
        maxOutputBytes: 10_000_000,
      }).pipe(Effect.map((result) => ({ patch: result.stdout })));

    const readConfigValue: GitCoreShape["readConfigValue"] = (cwd, key) =>
      runGitStdout("GitCore.readConfigValue", cwd, ["config", "--get", key], true).pipe(
        Effect.map((stdout) => stdout.trim()),
        Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
      );

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
          (yield* buildGeneratedDetachedWorktreePath(input.cwd).pipe(
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
        const result = yield* executeGit(
          "GitCore.checkoutBranch.checkout",
          input.cwd,
          checkoutArgs,
          {
            timeoutMs: 10_000,
            allowNonZeroExit: true,
            fallbackErrorMessage: "git checkout failed",
          },
        );
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

    const stashDrop: GitCoreShape["stashDrop"] = (input) =>
      executeGit("GitCore.stashDrop", input.cwd, ["stash", "drop"], {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git stash drop failed",
      }).pipe(Effect.asVoid);

    const stashInfo: GitCoreShape["stashInfo"] = (input) =>
      Effect.gen(function* () {
        const stashLine = (yield* runGitStdout("GitCore.stashInfo.list", input.cwd, [
          "stash",
          "list",
          "-n",
          "1",
          "--format=%gd%x09%gs",
        ])).trim();
        const separatorIndex = stashLine.indexOf("\t");
        const stashRef =
          separatorIndex >= 0 ? stashLine.slice(0, separatorIndex).trim() : stashLine.trim();
        const message =
          separatorIndex >= 0 ? stashLine.slice(separatorIndex + 1).trim() : stashLine.trim();
        if (stashRef.length === 0 || message.length === 0) {
          return yield* createGitCommandError(
            "GitCore.stashInfo",
            input.cwd,
            ["stash", "list", "-n", "1", "--format=%gd%x09%gs"],
            "No stash entry is available.",
          );
        }

        const branchOutput = yield* runGitStdout("GitCore.stashInfo.branch", input.cwd, [
          "branch",
          "--show-current",
        ]).pipe(Effect.catch(() => Effect.succeed("")));
        const filesOutput = yield* runGitStdout("GitCore.stashInfo.files", input.cwd, [
          "stash",
          "show",
          "--include-untracked",
          "--name-only",
          stashRef,
        ]).pipe(Effect.catch(() => Effect.succeed("")));

        return {
          cwd: input.cwd,
          branch: branchOutput.trim() || null,
          stashRef,
          message,
          files: parseNonEmptyLineList(filesOutput),
        };
      });

    const removeIndexLock: GitCoreShape["removeIndexLock"] = (input) =>
      Effect.gen(function* () {
        const lockPathOutput = yield* runGitStdout(
          "GitCore.removeIndexLock.resolvePath",
          input.cwd,
          ["rev-parse", "--git-path", "index.lock"],
        );
        const rawLockPath = lockPathOutput.trim();
        if (rawLockPath.length === 0 || nodePath.basename(rawLockPath) !== "index.lock") {
          return yield* createGitCommandError(
            "GitCore.removeIndexLock",
            input.cwd,
            ["rev-parse", "--git-path", "index.lock"],
            "Git did not return a valid index lock path.",
          );
        }

        const lockPath = nodePath.isAbsolute(rawLockPath)
          ? rawLockPath
          : nodePath.resolve(input.cwd, rawLockPath);
        yield* fileSystem
          .remove(lockPath)
          .pipe(
            Effect.mapError((cause) =>
              createGitCommandError(
                "GitCore.removeIndexLock",
                input.cwd,
                ["rm", lockPath],
                cause.message,
                cause,
              ),
            ),
          );
      });

    const initRepo: GitCoreShape["initRepo"] = (input) =>
      executeGit("GitCore.initRepo", input.cwd, ["init"], {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git init failed",
      }).pipe(Effect.asVoid);

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

    const stageFiles: GitCoreShape["stageFiles"] = (cwd, paths) =>
      runGit("GitCore.stageFiles", cwd, ["add", "--", ...paths]);

    const unstageFiles: GitCoreShape["unstageFiles"] = (cwd, paths) =>
      Effect.gen(function* () {
        // `git reset` resolves against HEAD, which does not exist before the first
        // commit. Fall back to `git rm --cached` so newly staged files can still be
        // unstaged in a freshly initialized repository.
        const headExists = yield* executeGit(
          "GitCore.unstageFiles.headExists",
          cwd,
          ["rev-parse", "--verify", "HEAD"],
          { allowNonZeroExit: true },
        ).pipe(Effect.map((result) => result.code === 0));

        yield* runGit(
          "GitCore.unstageFiles",
          cwd,
          headExists
            ? ["reset", "-q", "HEAD", "--", ...paths]
            : ["rm", "--cached", "-q", "--", ...paths],
        );
      });

    return {
      execute,
      status,
      statusDetails,
      readWorkingTreePatch,
      readUnstagedPatch,
      readStagedPatch,
      readBranchPatch,
      prepareCommitContext,
      commit,
      pushCurrentBranch,
      pullCurrentBranch,
      readRangeContext,
      readRangeDiff,
      readConfigValue,
      listBranches,
      createWorktree,
      createDetachedWorktree,
      fetchPullRequestBranch,
      ensureRemote,
      fetchRemoteBranch,
      setBranchUpstream,
      removeWorktree,
      renameBranch,
      createBranch,
      publishBranch,
      checkoutBranch,
      stashAndCheckout,
      stashDrop,
      stashInfo,
      removeIndexLock,
      initRepo,
      listLocalBranchNames,
      stageFiles,
      unstageFiles,
    } satisfies GitCoreShape;
  });

export const GitCoreLive = Layer.effect(GitCore, makeGitCore());
