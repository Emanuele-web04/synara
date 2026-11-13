// FILE: gitActionPullRequest.ts
// Purpose: The pull request a git action created (or reopened), in thread-link shape.
// Layer: Server git helpers
// Exports: pullRequestFromGitActionResult

import type { GitRunStackedActionResult, OrchestrationThreadPullRequest } from "@synara/contracts";

export function pullRequestFromGitActionResult(
  result: GitRunStackedActionResult,
): OrchestrationThreadPullRequest | null {
  const pr = result.pr;
  if (pr.status !== "created" && pr.status !== "opened_existing") return null;
  if (!pr.number || !pr.url || !pr.title || !pr.baseBranch || !pr.headBranch) return null;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseBranch,
    headBranch: pr.headBranch,
    state: "open",
  };
}
