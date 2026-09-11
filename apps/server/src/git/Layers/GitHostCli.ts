/**
 * GitHostCliLive - Routes host-neutral CLI calls to the `gh` or `glab` implementation.
 *
 * Selection is derived from the repository reference, the workspace's preferred remote, or a
 * pull-request URL. A remote whose host is neither github.com nor a recognised GitLab instance
 * falls back to GitHub, which keeps every other forge exactly as unsupported as it is today.
 *
 * @module GitHostCliLive
 */
import { homedir } from "node:os";

import { Effect, Layer } from "effect";
import { parsePullRequestUrl, parseRepositoryReference } from "@synara/shared/gitHostRepository";

import { GitHostCliError } from "../Errors.ts";
import { makeKeyedSingleFlightCache } from "../../pullRequests/KeyedSingleFlightCache";
import { GitCore } from "../Services/GitCore.ts";
import {
  GitHostCli,
  type GitHostCliRouterShape,
  type GitHostSelection,
} from "../Services/GitHostCli.ts";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { GitLabCli } from "../Services/GitLabCli.ts";
import { resolveRepositories } from "../repositoryResolution.ts";

const GITLAB_HOSTS_CACHE_TTL_MS = 5 * 60_000;
const GITHUB_HOST = "github.com";

export const makeGitHostCli = Effect.gen(function* () {
  const github = yield* GitHubCli;
  const gitlab = yield* GitLabCli;
  const git = yield* GitCore;
  const hostsCache = yield* makeKeyedSingleFlightCache<ReadonlySet<string>, never>({
    maxEntries: 1,
    ttlMs: GITLAB_HOSTS_CACHE_TTL_MS,
  });

  const githubSelection: GitHostSelection = {
    kind: "github",
    host: GITHUB_HOST,
    cli: github,
  };

  const knownGitLabHosts = hostsCache.get(
    "hosts",
    // The home directory is deliberately outside any repository: `glab auth status` must report
    // the user's configured hosts, never a project-scoped remote.
    gitlab.listConfiguredHosts({ cwd: homedir() }).pipe(
      Effect.map((hosts): ReadonlySet<string> => new Set(hosts)),
      // glab missing or broken means "no GitLab hosts", which leaves GitHub-only behaviour.
      Effect.catch(() => Effect.succeed<ReadonlySet<string>>(new Set())),
    ),
  );

  const forWorkspace = (cwd: string) =>
    Effect.gen(function* () {
      const gitlabHosts = yield* knownGitLabHosts;
      const { repositories } = yield* resolveRepositories(git, cwd, { gitlabHosts }).pipe(
        Effect.catch(() => Effect.succeed({ repositories: [], authoritative: false })),
      );
      const preferred = repositories[0];
      return preferred?.kind === "gitlab"
        ? ({
            kind: "gitlab",
            host: preferred.reference.split("/")[0] ?? "",
            cli: gitlab,
          } satisfies GitHostSelection)
        : githubSelection;
    });

  const forRepository = (repository: string) => {
    const identity = parseRepositoryReference(repository);
    if (!identity) {
      return Effect.fail(
        new GitHostCliError({
          host: "github",
          operation: "forRepository",
          detail: "Invalid repository reference.",
          reason: "other",
        }),
      );
    }
    return Effect.succeed(
      identity.kind === "gitlab"
        ? ({ kind: "gitlab", host: identity.host, cli: gitlab } satisfies GitHostSelection)
        : githubSelection,
    );
  };

  return {
    forRepository,
    forWorkspace,
    forReference: (cwd, reference) => {
      const parsed = parsePullRequestUrl(reference);
      if (!parsed) return forWorkspace(cwd);
      return Effect.succeed(
        parsed.identity.kind === "gitlab"
          ? ({
              kind: "gitlab",
              host: parsed.identity.host,
              cli: gitlab,
            } satisfies GitHostSelection)
          : githubSelection,
      );
    },
    knownGitLabHosts,
  } satisfies GitHostCliRouterShape;
});

export const GitHostCliLive = Layer.effect(GitHostCli, makeGitHostCli);
