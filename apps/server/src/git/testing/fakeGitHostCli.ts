// FILE: fakeGitHostCli.ts
// Purpose: Shared test fake for the GitHostCli router — pure reference/URL routing over caller
//          supplied per-host CLI fakes, with no git or process calls of its own.
// Layer: Server test utility (imported by *.test.ts only; never by production code)

import { Effect } from "effect";
import {
  parsePullRequestUrl,
  parseRepositoryReference,
  type GitHostKind,
} from "@synara/shared/gitHostRepository";

import { GitHostCliError } from "../Errors.ts";
import type {
  GitHostCliRouterShape,
  GitHostCliShape,
  GitHostSelection,
} from "../Services/GitHostCli.ts";

export interface FakeGitHostCliRouterInput {
  readonly github: GitHostCliShape;
  readonly gitlab?: GitHostCliShape;
  readonly gitlabHosts?: ReadonlyArray<string>;
  /** Workspace paths whose preferred remote should resolve to the GitLab fake. */
  readonly gitlabWorkspaces?: ReadonlyArray<string>;
}

export function createGitHostCliRouterForTests(
  input: FakeGitHostCliRouterInput,
): GitHostCliRouterShape {
  const knownGitLabHosts = new Set((input.gitlabHosts ?? []).map((host) => host.toLowerCase()));
  const gitlabWorkspaces = new Set(input.gitlabWorkspaces ?? []);

  const select = (
    kind: GitHostKind,
    host: string,
    operation: string,
  ): Effect.Effect<GitHostSelection, GitHostCliError> => {
    if (kind === "github") return Effect.succeed({ kind, host: "github.com", cli: input.github });
    return input.gitlab
      ? Effect.succeed({ kind, host, cli: input.gitlab })
      : Effect.fail(
          new GitHostCliError({
            host: "gitlab",
            operation,
            detail: "No GitLab CLI fake was provided to this test.",
            reason: "not-installed",
          }),
        );
  };

  const forWorkspace = (cwd: string) =>
    gitlabWorkspaces.has(cwd)
      ? select("gitlab", [...knownGitLabHosts][0] ?? "gitlab.com", "forWorkspace")
      : select("github", "github.com", "forWorkspace");

  return {
    forRepository: (repository) => {
      const identity = parseRepositoryReference(repository);
      return identity
        ? select(identity.kind, identity.host, "forRepository")
        : Effect.fail(
            new GitHostCliError({
              host: "github",
              operation: "forRepository",
              detail: "Invalid repository reference.",
              reason: "other",
            }),
          );
    },
    forWorkspace,
    forReference: (cwd, reference) => {
      const parsed = parsePullRequestUrl(reference);
      return parsed
        ? select(parsed.identity.kind, parsed.identity.host, "forReference")
        : forWorkspace(cwd);
    },
    knownGitLabHosts: Effect.succeed(knownGitLabHosts),
  };
}
