// FILE: GitCore.stash.ts
// Purpose: Stash listing, drop, and info operations for the GitCore service.
// Layer: dependency-parameterized factory; built once per GitCore via makeGitStash(deps).
// Exports: GitStash, GitStashDeps, makeGitStash.
import { Effect } from "effect";

import { GitCommandError } from "../Errors.ts";
import type { GitCoreShape } from "../Services/GitCore.ts";
import type { GitRunner } from "./GitCore.runner.ts";
import { createGitCommandError } from "./GitCore.commands.ts";
import { parseNonEmptyLineList, parseStashEntries } from "./GitCore.parsing.ts";
import type { StashEntry } from "./GitCore.types.ts";

export interface GitStashDeps {
  readonly runner: GitRunner;
}

export interface GitStash {
  readonly listStashEntries: (
    operation: string,
    cwd: string,
  ) => Effect.Effect<StashEntry[], GitCommandError>;
  readonly dropStashByHash: (cwd: string, hash: string) => Effect.Effect<void, GitCommandError>;
  readonly stashDrop: GitCoreShape["stashDrop"];
  readonly stashInfo: GitCoreShape["stashInfo"];
}

export const makeGitStash = (deps: GitStashDeps): GitStash => {
  const { executeGit, runGitStdout } = deps.runner;

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

  return { listStashEntries, dropStashByHash, stashDrop, stashInfo };
};
