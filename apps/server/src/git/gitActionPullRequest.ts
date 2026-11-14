// FILE: gitActionPullRequest.ts
// Purpose: Convert successful GitHub actions to durable thread-link observations.
// Layer: Server git helpers
// Exports: pullRequestFromGitActionResult, refreshReopenedThreadPullRequest

import {
  CommandId,
  type GitRunStackedActionResult,
  type OrchestrationCommand,
  type OrchestrationThreadPullRequest,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import {
  findPullRequestLink,
  isPullRequestLinkVisible,
} from "@synara/shared/threadPullRequestLinks";
import { Effect } from "effect";

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

/** A successful reopen refreshes an existing link. The serialized sync also honors later unlinks. */
export function refreshReopenedThreadPullRequest<A, E, R>(input: {
  thread: Pick<OrchestrationThreadShell, "id" | "pullRequests">;
  repository: string;
  number: number;
  dispatch: (command: OrchestrationCommand) => Effect.Effect<A, E, R>;
}): Effect.Effect<void, E, R> {
  const url = `https://github.com/${input.repository}/pull/${input.number}`;
  const link = findPullRequestLink(input.thread.pullRequests, url);
  if (link === null || !isPullRequestLinkVisible(link) || link.pullRequest.state !== "closed") {
    return Effect.void;
  }
  return input
    .dispatch({
      type: "thread.pull-request.sync",
      commandId: CommandId.makeUnsafe(`server:pr-reopen:${crypto.randomUUID()}`),
      threadId: input.thread.id,
      snapshots: [{ ...link.pullRequest, state: "open" }],
    })
    .pipe(Effect.asVoid);
}
