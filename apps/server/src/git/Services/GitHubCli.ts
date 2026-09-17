/**
 * GitHubCli - Effect service tag for `gh` process interactions.
 *
 * The command surface itself is host-neutral and lives in {@link GitHostCliShape}; this module
 * only carries the GitHub-specific tag and the `gh --json` field list.
 *
 * @module GitHubCli
 */
import { ServiceMap } from "effect";

import type { GitHostCliShape } from "./GitHostCli.ts";

/**
 * Field list for `gh pr view/list --json` calls that decode into
 * {@link GitHostPullRequestSummary} — one source so call sites and tests cannot drift.
 *
 * Note: `mergeable` is computed lazily by GitHub (it answers UNKNOWN while recomputing),
 * so list calls may pay a small extra API cost for it. The remote-status cache bounds
 * that cost; if status polling ever feels slow, this field is the first suspect.
 */
export const PULL_REQUEST_SUMMARY_JSON_FIELDS =
  "number,title,url,baseRefName,headRefName,state,mergedAt,isDraft,mergeable,additions,deletions,changedFiles,isCrossRepository,headRepository,headRepositoryOwner,updatedAt";

/**
 * GitHubCli - Service tag for GitHub CLI process execution.
 */
export class GitHubCli extends ServiceMap.Service<GitHubCli, GitHostCliShape>()(
  "synara/git/Services/GitHubCli",
) {}
