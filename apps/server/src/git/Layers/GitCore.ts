// FILE: GitCore.ts
// Purpose: Assembles the GitCore service — builds the raw `execute` runner, the shared
//   git-runner, then wires the extracted operation clusters (status/diff/stash/worktrees/
//   commit/branches/repo) into the public GitCoreShape.
// Layer: Server Git service
// Exports: GitCoreLive plus makeGitCore test factory.
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { GitCommandError } from "../Errors.ts";
import { GitCore, type GitCoreShape, type ExecuteGitResult } from "../Services/GitCore.ts";
import { ServerConfig } from "../../config.ts";
import { collectOutput, createTrace2Monitor } from "./GitCore.process.ts";
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from "./GitCore.types.ts";
import { quoteGitCommand, toGitCommandError } from "./GitCore.commands.ts";
import { makeGitRunner } from "./GitCore.runner.ts";
import { makeGitStatus } from "./GitCore.status.ts";
import { makeGitDiff } from "./GitCore.diff.ts";
import { makeGitStash } from "./GitCore.stash.ts";
import { makeGitWorktrees } from "./GitCore.worktrees.ts";
import { makeGitCommit } from "./GitCore.commit.ts";
import { makeGitBranches } from "./GitCore.branches.ts";
import { makeGitRepo } from "./GitCore.repo.ts";

export const makeGitCore = (options?: { executeOverride?: GitCoreShape["execute"] }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { worktreesDir } = yield* ServerConfig;

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

    const runner = yield* makeGitRunner({ execute });
    const { ensureRemote } = runner;

    const { statusDetails, status } = makeGitStatus({
      runner,
      fileSystem,
    });

    const {
      readUnstagedPatch,
      readStagedPatch,
      readWorkingTreePatch,
      readBranchPatch,
      readRangeContext,
      readRangeDiff,
    } = makeGitDiff({ runner, statusDetails });

    const { listStashEntries, dropStashByHash, stashDrop, stashInfo } = makeGitStash({ runner });

    const {
      createWorktree,
      createDetachedWorktree,
      fetchPullRequestBranch,
      fetchRemoteBranch,
      setBranchUpstream,
      removeWorktree,
    } = makeGitWorktrees({ runner, fileSystem, path, worktreesDir });

    const { prepareCommitContext, commit, pushCurrentBranch, pullCurrentBranch } = makeGitCommit({
      runner,
      statusDetails,
    });

    const {
      listBranches,
      renameBranch,
      publishBranch,
      createBranch,
      checkoutBranch,
      stashAndCheckout,
      listLocalBranchNames,
    } = makeGitBranches({
      runner,
      fileSystem,
      stash: { listStashEntries, dropStashByHash },
    });

    const { readConfigValue, removeIndexLock, initRepo, stageFiles, unstageFiles } = makeGitRepo({
      runner,
      fileSystem,
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
