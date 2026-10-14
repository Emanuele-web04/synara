// Pure helpers for the GitHub inbox: row building from repository snapshots, viewer involvement,
// failure backoff, and error summaries. No Effect services here so each rule is unit-testable.

import type {
  GitHubInboxItem,
  GitHubInboxState,
  GitHubIssueListEntry,
  GitHubViewerInvolvement,
  OrchestrationProject,
  PullRequestActor,
} from "@synara/contracts";
import { coalescePullRequestListEntries } from "@synara/shared/githubRepository";

import type { GitHubCliError } from "../git/Errors";
import type {
  GitHubInboxIssue,
  GitHubInboxPullRequest,
  GitHubInboxRemoteItem,
} from "../git/Services/GitHubCli";
import {
  buildPullRequestListEntry,
  isViewerReviewRequested,
  projectPullRequestIdentityKey,
} from "../pullRequests.logic";

/** A repository snapshot is served without asking GitHub for this long. Just under the 5 minute
 * client poll, so each poll refreshes while focus refetches and the sidebar badge share it. */
export const GITHUB_INBOX_SNAPSHOT_TTL_MS = 4 * 60_000;
/** A snapshot kept alive by 304 probes is still refetched in full after this long, because some
 * list fields (mergeability after a direct push to the base branch) change without GitHub
 * touching any item's `updated_at`. */
export const GITHUB_INBOX_MAX_PROBE_EXTENSION_MS = 30 * 60_000;
/** Stop refetching while fewer GraphQL points than this remain, until the budget resets. */
export const GITHUB_INBOX_RATE_LIMIT_FLOOR = 200;
/** Pause after a rate-limit error when GitHub gave no usable reset time (secondary limits). */
export const GITHUB_INBOX_RATE_LIMIT_FALLBACK_PAUSE_MS = 60_000;
/** A manual refresh this soon after a full read reuses that read instead of repeating it. */
export const GITHUB_INBOX_FORCE_REFRESH_COOLDOWN_MS = 10_000;
/** Pull request and issue detail are cached this long on the server; mutations drop them. */
export const GITHUB_ITEM_DETAIL_CACHE_TTL_MS = 60_000;
export const GITHUB_INBOX_FAILURE_BACKOFF_BASE_MS = 30_000;
export const GITHUB_INBOX_FAILURE_BACKOFF_MAX_MS = 10 * 60_000;

/** 30s after the first failure, doubling per consecutive failure, capped at 10 minutes. */
export function githubInboxFailureBackoffMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.floor(consecutiveFailures) - 1);
  return Math.min(
    GITHUB_INBOX_FAILURE_BACKOFF_MAX_MS,
    GITHUB_INBOX_FAILURE_BACKOFF_BASE_MS * 2 ** Math.min(exponent, 16),
  );
}

/** The inbox has two lists: open, and closed (which holds merged pull requests too). */
export function githubInboxRemoteItemState(item: GitHubInboxRemoteItem): GitHubInboxState {
  return item.item.state === "open" ? "open" : "closed";
}

function sameLogin(actor: PullRequestActor | null, viewer: string): boolean {
  const normalizedViewer = viewer.trim().toLowerCase();
  return normalizedViewer.length > 0 && actor?.login.trim().toLowerCase() === normalizedViewer;
}

export function githubViewerInvolvement(input: {
  author: PullRequestActor | null;
  assignees: ReadonlyArray<PullRequestActor>;
  viewer: string;
  /** Matched GitHub's `involves:@me` search. */
  matchedInvolvesSearch: boolean;
}): GitHubViewerInvolvement {
  const authored = sameLogin(input.author, input.viewer);
  const assigned = input.assignees.some((assignee) => sameLogin(assignee, input.viewer));
  return { authored, assigned, involved: authored || assigned || input.matchedInvolvesSearch };
}

export function buildIssueListEntry(input: {
  project: { id: GitHubIssueListEntry["projectId"]; title: string };
  repository: string;
  issue: GitHubInboxIssue;
  viewerInvolvement: GitHubViewerInvolvement;
  isPinned: boolean;
}): GitHubIssueListEntry {
  const { issue } = input;
  return {
    projectId: input.project.id,
    projectTitle: input.project.title,
    projectContexts: [
      { projectId: input.project.id, projectTitle: input.project.title, isPinned: input.isPinned },
    ],
    repository: input.repository,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    author: issue.author,
    state: issue.state,
    stateReason: issue.stateReason,
    labels: issue.labels,
    assignees: issue.assignees,
    commentCount: issue.commentCount,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    isPinned: input.isPinned,
    viewerInvolvement: input.viewerInvolvement,
  };
}

export interface GitHubInboxRowContext {
  readonly repository: string;
  readonly projects: ReadonlyArray<OrchestrationProject>;
  readonly viewer: string;
  readonly involvedNumbers: ReadonlySet<number>;
  readonly reviewRequestedNumbers: ReadonlySet<number>;
  readonly pinnedKeys: ReadonlySet<string>;
}

function isPinnedFor(context: GitHubInboxRowContext, projectId: string, number: number): boolean {
  return context.pinnedKeys.has(
    projectPullRequestIdentityKey({ projectId, repository: context.repository, number }),
  );
}

/** One row per remote item, carrying every local project that owns the repository. */
export function buildGitHubInboxItem(
  context: GitHubInboxRowContext,
  remote: GitHubInboxRemoteItem,
): GitHubInboxItem {
  const matchedInvolvesSearch = context.involvedNumbers.has(remote.item.number);
  if (remote.kind === "pullRequest") {
    const pullRequest: GitHubInboxPullRequest = remote.item;
    const viewerInvolvement = githubViewerInvolvement({
      author: pullRequest.author,
      assignees: pullRequest.assignees,
      viewer: context.viewer,
      matchedInvolvesSearch,
    });
    const viewerReviewRequested = isViewerReviewRequested(
      pullRequest.author,
      pullRequest.reviewRequestLogins,
      context.viewer,
      context.reviewRequestedNumbers.has(pullRequest.number),
    );
    const [entry] = coalescePullRequestListEntries(
      context.projects.map((project) =>
        buildPullRequestListEntry({
          project,
          repository: context.repository,
          pullRequest,
          viewerReviewRequested,
          viewerInvolvement,
          isPinned: isPinnedFor(context, project.id, pullRequest.number),
        }),
      ),
    );
    return { kind: "pullRequest", ...entry! };
  }
  const issue = remote.item;
  const viewerInvolvement = githubViewerInvolvement({
    author: issue.author,
    assignees: issue.assignees,
    viewer: context.viewer,
    matchedInvolvesSearch,
  });
  const [entry] = coalescePullRequestListEntries(
    context.projects.map((project) =>
      buildIssueListEntry({
        project,
        repository: context.repository,
        issue,
        viewerInvolvement,
        isPinned: isPinnedFor(context, project.id, issue.number),
      }),
    ),
  );
  return { kind: "issue", ...entry! };
}

/** Server cache key for one pull request or issue; a `${repository}\u0000` prefix matches the
 * whole repository. */
export function githubItemCacheKey(repository: string, number: number): string {
  return `${repository.trim().toLowerCase()}\u0000${number}`;
}

/** Remote identity across both kinds; GitHub numbers PRs and issues from one sequence. */
export function githubInboxItemIdentityKey(item: {
  readonly repository: string;
  readonly number: number;
}): string {
  return `${item.repository.trim().toLowerCase()}#${item.number}`;
}

/**
 * Short, user-facing reason for a failed repository read. The raw error text starts with the full
 * `gh` command line (including the GraphQL document), which is noise in the UI.
 */
export function summarizeGitHubInboxError(error: GitHubCliError): string {
  if (error.reason === "rate-limited") return "GitHub rate limit reached.";
  if (error.reason === "not-authenticated" || error.reason === "not-installed") {
    return error.detail;
  }
  const stderrTail = /(?:failed \(code=[^)]*\)|timed out)\.\s*([\s\S]+)$/.exec(error.detail)?.[1];
  const text = (stderrTail ?? error.detail).replace(/^gh:\s*/i, "").trim();
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return "GitHub request failed.";
  return firstLine.length > 300 ? `${firstLine.slice(0, 297)}...` : firstLine;
}
