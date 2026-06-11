// FILE: GitCore.diff.ts
// Purpose: Patch and diff readers (unstaged/staged/working-tree/branch patches, range
//   context and range diff) for the GitCore service.
// Layer: dependency-parameterized factory; built once per GitCore via makeGitDiff(deps).
// Exports: GitDiff, GitDiffDeps, makeGitDiff.
import { Effect } from "effect";

import type { GitCoreShape } from "../Services/GitCore.ts";
import type { GitRunner } from "./GitCore.runner.ts";
import { createGitCommandError } from "./GitCore.commands.ts";
import { joinPatchSegments } from "./GitCore.parsing.ts";
import {
  EMPTY_TREE_OBJECT_ID,
  MAX_UNTRACKED_DIFF_CONCURRENCY,
  WORKING_TREE_DIFF_TIMEOUT_MS,
} from "./GitCore.types.ts";

export interface GitDiffDeps {
  readonly runner: GitRunner;
  readonly statusDetails: GitCoreShape["statusDetails"];
}

export interface GitDiff {
  readonly readUnstagedPatch: GitCoreShape["readUnstagedPatch"];
  readonly readStagedPatch: GitCoreShape["readStagedPatch"];
  readonly readWorkingTreePatch: GitCoreShape["readWorkingTreePatch"];
  readonly readBranchPatch: GitCoreShape["readBranchPatch"];
  readonly readRangeContext: GitCoreShape["readRangeContext"];
  readonly readRangeDiff: GitCoreShape["readRangeDiff"];
}

export const makeGitDiff = (deps: GitDiffDeps): GitDiff => {
  const { statusDetails } = deps;
  const { execute, executeGit, runGitStdout, resolveBaseBranchForNoUpstream } = deps.runner;

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

  return {
    readUnstagedPatch,
    readStagedPatch,
    readWorkingTreePatch,
    readBranchPatch,
    readRangeContext,
    readRangeDiff,
  };
};
