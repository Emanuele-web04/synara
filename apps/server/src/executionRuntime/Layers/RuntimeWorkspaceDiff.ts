/**
 * RuntimeWorkspaceDiffLive - Reads a remote instance's working-tree diff by
 * routing `git` through the provider's exec channel.
 *
 * `git add -A -N` makes untracked files (the common case — an agent creating new
 * files) appear in `git diff HEAD` without staging their content, so the Review
 * panel lists them with real add/delete counts. `--porcelain` independently
 * enumerates every changed path so a binary/empty content diff still reports the
 * file. Best-effort throughout: any failure degrades to an empty diff flagged
 * `degraded` so the caller can tell an unreadable sandbox from a clean tree.
 *
 * @module RuntimeWorkspaceDiffLive
 */
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { parsePorcelainZPaths } from "../gitPorcelain.ts";
import { RuntimeProviderRegistry } from "../Services/RuntimeProviderRegistry.ts";
import {
  RuntimeWorkspaceDiff,
  type RuntimeWorkspaceDiffResult,
  type RuntimeWorkspaceDiffShape,
} from "../Services/RuntimeWorkspaceDiff.ts";

const EMPTY: RuntimeWorkspaceDiffResult = { diff: "", changedPaths: [], degraded: true };

const makeRuntimeWorkspaceDiff = Effect.gen(function* () {
  const registry = yield* RuntimeProviderRegistry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const read: RuntimeWorkspaceDiffShape["read"] = (input) =>
    Effect.gen(function* () {
      const adapter = yield* registry
        .getAdapter(input.provider)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (adapter === undefined) {
        return EMPTY;
      }

      const runGit = (args: ReadonlyArray<string>) =>
        adapter
          .execCollect(input.instanceId, {
            command: "git",
            args,
            ...(input.workdir !== undefined ? { cwd: input.workdir } : {}),
          })
          .pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.orElseSucceed(() => ({ stdout: "", stderr: "", code: 1 as number | null })),
          );

      // Intent-to-add so new files appear in the diff. Failure is non-fatal: a
      // non-repo workdir just yields an empty diff below.
      yield* runGit(["add", "-A", "-N"]).pipe(Effect.ignore);

      const diffResult = yield* runGit(["diff", "--binary", "HEAD"]);
      const statusResult = yield* runGit(["status", "--porcelain=v1", "-z"]);

      return {
        diff: diffResult.code === 0 ? diffResult.stdout : "",
        changedPaths: statusResult.code === 0 ? parsePorcelainZPaths(statusResult.stdout) : [],
        degraded: diffResult.code !== 0 || statusResult.code !== 0,
      } satisfies RuntimeWorkspaceDiffResult;
    });

  return { read } satisfies RuntimeWorkspaceDiffShape;
});

export const RuntimeWorkspaceDiffLive = Layer.effect(
  RuntimeWorkspaceDiff,
  makeRuntimeWorkspaceDiff,
);
