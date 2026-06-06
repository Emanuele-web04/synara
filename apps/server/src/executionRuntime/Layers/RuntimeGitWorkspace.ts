/**
 * RuntimeGitWorkspaceLive - Runtime-neutral git v1 over a runtime's exec channel.
 *
 * Expresses `clone` / `checkout -B` / `status --porcelain` / `diff --binary` as
 * fire-and-collect git commands routed through the fake adapter's `execCollect`,
 * so the same calls work against any remote provider that supplies a command
 * exec capability. Local git RPCs are unchanged by this; this is the remote
 * path only.
 *
 * Credential safety: a clone URL may carry an embedded token
 * (`https://x-access-token:TOKEN@host/...`). The tokenized URL is passed to git
 * but never logged or surfaced in an error — every failure detail is run through
 * {@link redactSecrets} first.
 *
 * @module RuntimeGitWorkspaceLive
 */
import { Effect, Layer } from "effect";

import { RuntimeGitFailedError } from "../Errors.ts";
import { parsePorcelainZEntries } from "../gitPorcelain.ts";
import { FakeRuntimeProviderAdapter } from "../Services/FakeRuntimeProviderAdapter.ts";
import {
  RuntimeGitWorkspace,
  type RuntimeGitCloneInput,
  type RuntimeGitWorkspaceShape,
} from "../Services/RuntimeGitWorkspace.ts";
import { redactSecrets } from "./redactCredentials.ts";

const makeRuntimeGitWorkspace = Effect.gen(function* () {
  const adapter = yield* FakeRuntimeProviderAdapter;

  const runGit = (
    operation: string,
    instanceId: RuntimeGitCloneInput["instanceId"],
    args: ReadonlyArray<string>,
    cwd: string | undefined,
    secrets: ReadonlyArray<string>,
  ) =>
    adapter
      .execCollect(instanceId, { command: "git", args, ...(cwd === undefined ? {} : { cwd }) })
      .pipe(
        Effect.mapError(
          (error) =>
            new RuntimeGitFailedError({
              operation,
              detail: redactSecrets(error.message, secrets),
            }),
        ),
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result)
            : Effect.fail(
                new RuntimeGitFailedError({
                  operation,
                  detail: redactSecrets(
                    `exit ${result.code ?? "null"}: ${result.stderr.trim() || result.stdout.trim()}`,
                    secrets,
                  ),
                }),
              ),
        ),
      );

  const clone: RuntimeGitWorkspaceShape["clone"] = (input) =>
    Effect.gen(function* () {
      // The repo URL may carry an embedded token; it is passed to git verbatim
      // but registered as a secret so it never appears in a redacted error.
      const secrets = [input.repoUrl];
      yield* runGit(
        "clone",
        input.instanceId,
        ["clone", input.repoUrl, input.targetPath],
        undefined,
        secrets,
      );
      // `checkout -B` creates or resets the branch to the requested ref, matching
      // the local worktree's branch setup.
      yield* runGit(
        "checkout",
        input.instanceId,
        ["checkout", "-B", input.ref],
        input.targetPath,
        secrets,
      );
    });

  const status: RuntimeGitWorkspaceShape["status"] = (input) =>
    runGit("status", input.instanceId, ["status", "--porcelain=v1", "-z"], input.workdir, []).pipe(
      Effect.map((result) => parsePorcelainZEntries(result.stdout)),
    );

  const diff: RuntimeGitWorkspaceShape["diff"] = (input) =>
    runGit("diff", input.instanceId, ["diff", "--binary", "HEAD"], input.workdir, []).pipe(
      Effect.map((result) => result.stdout),
    );

  return { clone, status, diff } satisfies RuntimeGitWorkspaceShape;
});

export const RuntimeGitWorkspaceLive = Layer.effect(RuntimeGitWorkspace, makeRuntimeGitWorkspace);
