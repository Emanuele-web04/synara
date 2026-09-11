import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";

import { GitHostCliError } from "../Errors.ts";
import { GitCore } from "../Services/GitCore.ts";
import type { ExecuteGitInput, GitCoreShape } from "../Services/GitCore.ts";
import { GitHostCli } from "../Services/GitHostCli.ts";
import type { GitHostCliShape } from "../Services/GitHostCli.ts";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { GitLabCli, type GitLabCliShape } from "../Services/GitLabCli.ts";
import { GitHostCliLive } from "./GitHostCli.ts";

const githubCli = { execute: () => Effect.die("gh") } as unknown as GitHostCliShape;

function makeGitLab(hosts: ReadonlyArray<string>, calls?: string[]): GitLabCliShape {
  return {
    execute: () => Effect.die("glab"),
    listConfiguredHosts: (input: { readonly cwd: string }) =>
      Effect.sync(() => {
        calls?.push(input.cwd);
        return hosts;
      }),
  } as unknown as GitLabCliShape;
}

/** Answers only the two git reads `resolveRepositories` performs, from one remote map. */
function makeGit(remoteUrls: Readonly<Record<string, string>>): GitCoreShape {
  return {
    execute: ({ args }: ExecuteGitInput) => {
      if (args[0] === "branch") {
        return Effect.succeed({ code: 0, stdout: "main\n", stderr: "" });
      }
      if (args[0] === "config") {
        const records = Object.entries(remoteUrls).map(
          ([name, url]) => `remote.${name}.url\n${url}`,
        );
        return Effect.succeed({ code: 0, stdout: `${records.join("\0")}\0`, stderr: "" });
      }
      return Effect.succeed({ code: 1, stdout: "", stderr: "unexpected git call" });
    },
    readConfigValue: () => Effect.succeed(null),
  } as unknown as GitCoreShape;
}

function makeRouterLayer(input: {
  gitlabHosts?: ReadonlyArray<string>;
  remoteUrls?: Readonly<Record<string, string>>;
  hostCalls?: string[];
}) {
  return GitHostCliLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(GitHubCli, githubCli),
        Layer.succeed(GitLabCli, makeGitLab(input.gitlabHosts ?? [], input.hostCalls)),
        Layer.succeed(GitCore, makeGit(input.remoteUrls ?? {})),
      ),
    ),
  );
}

const run = <A, E>(
  effect: Effect.Effect<A, E, GitHostCli>,
  input: Parameters<typeof makeRouterLayer>[0] = {},
) => effect.pipe(Effect.provide(makeRouterLayer(input)));

it.effect("routes by repository reference", () =>
  Effect.gen(function* () {
    const router = yield* GitHostCli;
    const github = yield* router.forRepository("acme/app");
    const gitlab = yield* router.forRepository("gitlab.dotblocks.fr/dotblocks/platform/app");

    assert.deepStrictEqual([github.kind, github.host], ["github", "github.com"]);
    assert.deepStrictEqual([gitlab.kind, gitlab.host], ["gitlab", "gitlab.dotblocks.fr"]);
  }).pipe(run),
);

it.effect("rejects a reference that identifies no supported host", () =>
  Effect.gen(function* () {
    const error = yield* (yield* GitHostCli).forRepository("not-a-reference").pipe(Effect.flip);

    assert.equal(error.detail, "Invalid repository reference.");
  }).pipe(run),
);

it.effect("routes by pull-request URL", () =>
  Effect.gen(function* () {
    const router = yield* GitHostCli;
    const github = yield* router.forReference("/repo", "https://github.com/a/b/pull/3");
    const gitlab = yield* router.forReference(
      "/repo",
      "https://gitlab.dotblocks.fr/a/b/-/merge_requests/12",
    );

    assert.equal(github.kind, "github");
    assert.deepStrictEqual([gitlab.kind, gitlab.host], ["gitlab", "gitlab.dotblocks.fr"]);
  }).pipe(run),
);

it.effect("falls back to the workspace remote for a non-URL reference", () =>
  Effect.gen(function* () {
    const selection = yield* (yield* GitHostCli).forReference("/repo", "42");

    assert.equal(selection.kind, "gitlab");
  }).pipe((effect) => run(effect, { remoteUrls: { origin: "git@gitlab.com:acme/app.git" } })),
);

it.effect("selects GitLab for a gitlab.com remote without consulting glab", () =>
  Effect.gen(function* () {
    const selection = yield* (yield* GitHostCli).forWorkspace("/repo");

    assert.deepStrictEqual([selection.kind, selection.host], ["gitlab", "gitlab.com"]);
  }).pipe((effect) => run(effect, { remoteUrls: { origin: "https://gitlab.com/acme/app.git" } })),
);

it.effect("selects GitLab for a self-hosted remote only when glab knows the host", () =>
  Effect.gen(function* () {
    const selection = yield* (yield* GitHostCli).forWorkspace("/repo");

    assert.deepStrictEqual([selection.kind, selection.host], ["gitlab", "code.dotblocks.fr"]);
  }).pipe((effect) =>
    run(effect, {
      gitlabHosts: ["code.dotblocks.fr"],
      remoteUrls: { origin: "git@code.dotblocks.fr:dotblocks/platform/app.git" },
    }),
  ),
);

it.effect("keeps an unknown forge on the GitHub path so its behaviour is unchanged", () =>
  Effect.gen(function* () {
    const selection = yield* (yield* GitHostCli).forWorkspace("/repo");

    assert.equal(selection.kind, "github");
  }).pipe((effect) => run(effect, { remoteUrls: { origin: "git@bitbucket.org:acme/app.git" } })),
);

it.effect("selects GitHub when the workspace has no remotes", () =>
  Effect.gen(function* () {
    const selection = yield* (yield* GitHostCli).forWorkspace("/repo");

    assert.equal(selection.kind, "github");
  }).pipe(run),
);

it.effect("reads glab's configured hosts once within the cache window", () =>
  Effect.gen(function* () {
    const router = yield* GitHostCli;
    const first = yield* router.knownGitLabHosts;
    const second = yield* router.knownGitLabHosts;

    assert.deepStrictEqual([...first].toSorted(), ["code.dotblocks.fr", "gitlab.com"]);
    assert.deepStrictEqual([...second].toSorted(), ["code.dotblocks.fr", "gitlab.com"]);
  }).pipe((effect) => {
    const hostCalls: string[] = [];
    return effect.pipe(
      Effect.provide(
        makeRouterLayer({ gitlabHosts: ["gitlab.com", "code.dotblocks.fr"], hostCalls }),
      ),
      Effect.tap(() => Effect.sync(() => expect(hostCalls).toHaveLength(1))),
    );
  }),
);

it.effect("treats a failing glab as no configured GitLab hosts", () =>
  Effect.gen(function* () {
    const hosts = yield* (yield* GitHostCli).knownGitLabHosts;

    assert.deepStrictEqual([...hosts], []);
  }).pipe((effect) =>
    effect.pipe(
      Effect.provide(
        GitHostCliLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(GitHubCli, githubCli),
              Layer.succeed(GitLabCli, {
                execute: () => Effect.die("glab"),
                listConfiguredHosts: () =>
                  Effect.fail(
                    new GitHostCliError({
                      host: "gitlab",
                      operation: "listConfiguredHosts",
                      detail: "GitLab CLI (`glab`) is required but not available on PATH.",
                      reason: "not-installed",
                    }),
                  ),
              } as unknown as GitLabCliShape),
              Layer.succeed(GitCore, makeGit({})),
            ),
          ),
        ),
      ),
    ),
  ),
);

it.effect("selects GitHub when the workspace inventory cannot be resolved", () =>
  Effect.gen(function* () {
    const selection = yield* (yield* GitHostCli).forWorkspace("/not-a-repo");

    assert.equal(selection.kind, "github");
  }).pipe((effect) =>
    effect.pipe(
      Effect.provide(
        GitHostCliLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(GitHubCli, githubCli),
              Layer.succeed(GitLabCli, makeGitLab([])),
              Layer.succeed(GitCore, {
                execute: vi.fn(() =>
                  Effect.succeed({ code: 128, stdout: "", stderr: "not a git repository" }),
                ),
                readConfigValue: () => Effect.succeed(null),
              } as unknown as GitCoreShape),
            ),
          ),
        ),
      ),
    ),
  ),
);
