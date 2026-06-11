// FILE: GitCore.status.ts
// Purpose: Working-tree status and status-detail computation (porcelain parse, numstat,
//   move-aware summary, ahead/behind against base) for the GitCore service.
// Layer: dependency-parameterized factory; built once per GitCore via makeGitStatus(deps).
// Exports: GitStatus, GitStatusDeps, makeGitStatus.
import { Effect } from "effect";
import type { FileSystem } from "effect";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

import { GitCommandError } from "../Errors.ts";
import type { GitCoreShape } from "../Services/GitCore.ts";
import type { GitRunner } from "./GitCore.runner.ts";
import { hasNodeErrorCode, isMissingGitCwdError, resolveGitPath } from "./GitCore.commands.ts";
import {
  MOVE_AWARE_WORKING_TREE_STATUS_TIMEOUT_MS,
  NON_REPOSITORY_STATUS_DETAILS,
  type WorkingTreeStatSummary,
} from "./GitCore.types.ts";
import {
  countTextLines,
  normalizeConfiguredMergeBranch,
  parseBranchAb,
  parseNumstatEntries,
  parsePorcelainPath,
  summarizeNumstatEntries,
} from "./GitCore.parsing.ts";

export interface GitStatusDeps {
  readonly runner: GitRunner;
  readonly fileSystem: FileSystem.FileSystem;
}

export interface GitStatus {
  readonly statusDetails: GitCoreShape["statusDetails"];
  readonly status: GitCoreShape["status"];
  readonly computeAheadCountAgainstBase: (
    cwd: string,
    branch: string,
  ) => Effect.Effect<number, GitCommandError>;
}

export const makeGitStatus = (deps: GitStatusDeps): GitStatus => {
  const { fileSystem } = deps;
  const { executeGit, runGitStdout, refreshStatusUpstreamIfStale, resolveBaseBranchForNoUpstream } =
    deps.runner;

  const readMoveAwareWorkingTreeSummary = (
    cwd: string,
  ): Effect.Effect<WorkingTreeStatSummary | null, never> =>
    Effect.scoped(
      Effect.gen(function* () {
        const indexPathRaw = yield* runGitStdout("GitCore.statusDetails.moveAwareIndexPath", cwd, [
          "rev-parse",
          "--git-path",
          "index",
        ]).pipe(Effect.map((stdout) => stdout.trim()));
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
        yield* executeGit("GitCore.statusDetails.moveAwareAddAll", cwd, ["add", "-A", "--", ":/"], {
          env: tempIndexEnv,
          timeoutMs: MOVE_AWARE_WORKING_TREE_STATUS_TIMEOUT_MS,
          fallbackErrorMessage: "git add -A failed while summarizing working tree status",
        });

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
          const statusCode = line.startsWith("1 ") || line.startsWith("2 ") ? line.slice(2, 4) : "";
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

  return { statusDetails, status, computeAheadCountAgainstBase };
};
