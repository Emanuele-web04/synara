// FILE: GitCore.repo.ts
// Purpose: Repository-level config read, index-lock removal, init, and staging operations
//   for the GitCore service.
// Layer: dependency-parameterized factory; built once per GitCore via makeGitRepo(deps).
// Exports: GitRepo, GitRepoDeps, makeGitRepo.
import { Effect } from "effect";
import type { FileSystem } from "effect";
import * as nodePath from "node:path";

import type { GitCoreShape } from "../Services/GitCore.ts";
import type { GitRunner } from "./GitCore.runner.ts";
import { createGitCommandError } from "./GitCore.commands.ts";

export interface GitRepoDeps {
  readonly runner: GitRunner;
  readonly fileSystem: FileSystem.FileSystem;
}

export interface GitRepo {
  readonly readConfigValue: GitCoreShape["readConfigValue"];
  readonly removeIndexLock: GitCoreShape["removeIndexLock"];
  readonly initRepo: GitCoreShape["initRepo"];
  readonly stageFiles: GitCoreShape["stageFiles"];
  readonly unstageFiles: GitCoreShape["unstageFiles"];
}

export const makeGitRepo = (deps: GitRepoDeps): GitRepo => {
  const { fileSystem } = deps;
  const { executeGit, runGit, runGitStdout } = deps.runner;

  const readConfigValue: GitCoreShape["readConfigValue"] = (cwd, key) =>
    runGitStdout("GitCore.readConfigValue", cwd, ["config", "--get", key], true).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
    );

  const removeIndexLock: GitCoreShape["removeIndexLock"] = (input) =>
    Effect.gen(function* () {
      const lockPathOutput = yield* runGitStdout("GitCore.removeIndexLock.resolvePath", input.cwd, [
        "rev-parse",
        "--git-path",
        "index.lock",
      ]);
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

  return { readConfigValue, removeIndexLock, initRepo, stageFiles, unstageFiles };
};
