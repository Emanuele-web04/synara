/**
 * GitLabCli - Effect service tag for `glab` process interactions.
 *
 * Implements the host-neutral {@link GitHostCliShape} and adds the one GitLab-only capability the
 * router needs: enumerating the hosts `glab` is authenticated against, which is what makes a
 * self-hosted remote recognisable as GitLab.
 *
 * @module GitLabCli
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { GitHostCliError } from "../Errors.ts";
import type { GitHostCliShape } from "./GitHostCli.ts";

export interface GitLabCliShape extends GitHostCliShape {
  /** Hosts configured in the local `glab` config, as reported by `glab auth status --all`. */
  readonly listConfiguredHosts: (input: {
    readonly cwd: string;
  }) => Effect.Effect<ReadonlyArray<string>, GitHostCliError>;
}

/**
 * GitLabCli - Service tag for GitLab CLI process execution.
 */
export class GitLabCli extends ServiceMap.Service<GitLabCli, GitLabCliShape>()(
  "synara/git/Services/GitLabCli",
) {}
