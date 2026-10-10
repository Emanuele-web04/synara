// FILE: githubItemAgentContext.ts
// Purpose: Turn a loaded pull request or issue detail into what the agent actions hand over:
//          the card source (Send to agent and Ask cards) and the standalone sidechat context.
// Layer: Pull request presentation logic
// Exports: githubItemCardSourceFromPullRequest, githubItemCardSourceFromIssue,
//          githubItemSidechatContext, GitHubItemAgentTarget

import type {
  GitHubIssueDetail,
  ProjectId,
  PullRequestDetail,
  ThreadSidechatContext,
} from "@synara/contracts";

import type { GitHubItemCardSource } from "~/components/chat/environment/environmentPullRequest.logic";
import { pullRequestStateLabel } from "./PullRequestStateGlyph";
import { resolveIssueStatePresentation } from "./pullRequestStatePresentation";

/** One item, in the project the agent action runs in. */
export interface GitHubItemAgentTarget {
  projectId: ProjectId;
  source: GitHubItemCardSource;
}

export function githubItemCardSourceFromPullRequest(
  detail: PullRequestDetail,
): GitHubItemCardSource {
  return {
    itemKind: "pullRequest",
    number: detail.number,
    title: detail.title,
    url: detail.url,
    repository: detail.repository,
    stateLabel: pullRequestStateLabel(detail.state, detail.isDraft, detail.mergeability),
    author: detail.author?.login ?? null,
    labels: detail.labels.map((label) => label.name),
    body: detail.body,
    comments: detail.comments,
    commentsTruncated: detail.commentsTruncated || detail.commentsIncomplete,
    branches: { head: detail.headBranch, base: detail.baseBranch },
  };
}

export function githubItemCardSourceFromIssue(detail: GitHubIssueDetail): GitHubItemCardSource {
  return {
    itemKind: "issue",
    number: detail.number,
    title: detail.title,
    url: detail.url,
    repository: detail.repository,
    stateLabel: resolveIssueStatePresentation(detail).shortLabel,
    author: detail.author?.login ?? null,
    labels: detail.labels.map((label) => label.name),
    body: detail.body,
    comments: detail.comments,
    commentsTruncated: detail.commentsTruncated,
  };
}

export function githubItemSidechatContext(source: GitHubItemCardSource): ThreadSidechatContext {
  return {
    kind: "github-item",
    itemKind: source.itemKind,
    repository: source.repository,
    number: source.number,
    url: source.url,
  };
}
