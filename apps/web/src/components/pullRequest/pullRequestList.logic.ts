// FILE: pullRequestList.logic.ts
// Purpose: Pure grouping helper for the pull request list's "All" tab — buckets entries by the
//          viewer's involvement (review requested, authored, others) so the list can
//          render muted section headers the way the reference design does, without duplicating
//          this classification in the route component itself.
// Layer: Web domain helpers (no React)
// Exports: PullRequestListGroupKey, PullRequestListGroup, grouping, pinned ordering,
//          involvement/search filters, identity, and badge helpers

import type {
  OrchestrationWorktreeWorkspace,
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestSetPinnedInput,
} from "@synara/contracts";
import {
  pullRequestListProjectContexts,
  pullRequestListRepositoryIdentity,
} from "@synara/shared/githubRepository";
import { findWorkspaceForPullRequest } from "@synara/shared/pullRequest";

export type PullRequestListGroupKey = "pinned" | "reviewRequested" | "authored" | "others";

export interface PullRequestListGroup {
  key: PullRequestListGroupKey;
  label: string;
  entries: PullRequestListEntry[];
}

export type PullRequestWorkspaceAssociation = "active" | "archived" | null;

const GROUP_LABELS: Record<PullRequestListGroupKey, string> = {
  pinned: "Pinned",
  reviewRequested: "Review requested",
  authored: "My PRs",
  others: "Others",
};

export function pullRequestListEntryKey(entry: PullRequestListEntry): string {
  return pullRequestListRepositoryIdentity(entry);
}

/** In a project-scoped view a pin owns that project. In the aggregate view the one visible toggle
 * applies consistently across every associated project. */
export function pullRequestPinToggleInputs(
  entry: PullRequestListEntry,
  aggregate: boolean,
): PullRequestSetPinnedInput[] {
  if (!aggregate) {
    return [
      {
        projectId: entry.projectId,
        repository: entry.repository,
        number: entry.number,
        isPinned: !entry.isPinned,
      },
    ];
  }
  return pullRequestListProjectContexts(entry)
    .filter((context) => !entry.isPinned || context.isPinned)
    .map((context) => ({
      projectId: context.projectId,
      repository: entry.repository,
      number: entry.number,
      isPinned: !entry.isPinned,
    }));
}

// The list is fetched once per state as the "all" involvement superset; Review requested and
// My PRs are views over it, so switching tabs never waits on the network. Review requested
// relies on the server-computed viewerReviewRequested flag (which includes team-routed review
// requests); Authored prefers the server's account-scoped flag, then falls back to the aggregate
// viewer login when talking to an older server that does not emit the field.
function isEntryViewerAuthored(
  entry: PullRequestListEntry,
  normalizedViewer: string | null,
): boolean {
  if (entry.viewerAuthored !== undefined) return entry.viewerAuthored;
  return normalizedViewer !== null && entry.author?.login.trim().toLowerCase() === normalizedViewer;
}

export function filterPullRequestEntriesByInvolvement(
  entries: readonly PullRequestListEntry[],
  viewerLogin: string | null | undefined,
  involvement: PullRequestInvolvement,
): PullRequestListEntry[] {
  if (involvement === "reviewing") {
    return entries.filter((entry) => entry.viewerReviewRequested);
  }
  if (involvement === "authored") {
    const normalizedViewer = viewerLogin?.trim().toLowerCase() || null;
    return entries.filter((entry) => isEntryViewerAuthored(entry, normalizedViewer));
  }
  return [...entries];
}

/** Free-text list filter over every identity users can see or paste from GitHub. */
export function matchesPullRequestSearchQuery(
  entry: PullRequestListEntry,
  normalizedQuery: string,
): boolean {
  if (normalizedQuery.length === 0) return true;
  return `${entry.title} ${entry.repository} ${entry.headBranch} ${entry.baseBranch} ${entry.url} #${entry.number} ${entry.author?.login ?? ""}`
    .toLowerCase()
    .includes(normalizedQuery);
}

export function pullRequestWorkspaceAssociation(
  entry: Pick<PullRequestListEntry, "projectId" | "number" | "url">,
  workspaces: readonly OrchestrationWorktreeWorkspace[],
): PullRequestWorkspaceAssociation {
  const workspace = findWorkspaceForPullRequest(workspaces, entry.projectId, entry);
  if (!workspace) return null;
  return workspace.archivedAt === null ? "active" : "archived";
}

export function countUniqueViewerReviewRequests(entries: readonly PullRequestListEntry[]): number {
  return new Set(
    entries.filter((entry) => entry.viewerReviewRequested).map(pullRequestListRepositoryIdentity),
  ).size;
}

/** Stable partition used by ungrouped tabs after an optimistic pin toggle. */
export function orderPullRequestEntriesPinnedFirst(
  entries: readonly PullRequestListEntry[],
): PullRequestListEntry[] {
  return [
    ...entries.filter((entry) => entry.isPinned),
    ...entries.filter((entry) => !entry.isPinned),
  ];
}

// We only claim relationships represented by list data. In particular, no "previously reviewed"
// bucket is inferred from authorship because the API result has no review-history signal.
export function groupPullRequestEntriesByInvolvement(
  entries: readonly PullRequestListEntry[],
  viewerLogin: string | null | undefined,
): PullRequestListGroup[] {
  const normalizedViewer = viewerLogin?.trim().toLowerCase() || null;

  const buckets: Record<PullRequestListGroupKey, PullRequestListEntry[]> = {
    pinned: [],
    reviewRequested: [],
    authored: [],
    others: [],
  };

  for (const entry of entries) {
    if (entry.isPinned) {
      buckets.pinned.push(entry);
      continue;
    }
    if (isEntryViewerAuthored(entry, normalizedViewer)) {
      buckets.authored.push(entry);
    } else if (entry.viewerReviewRequested) {
      buckets.reviewRequested.push(entry);
    } else {
      buckets.others.push(entry);
    }
  }

  const order: PullRequestListGroupKey[] = ["pinned", "reviewRequested", "authored", "others"];
  return order
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: GROUP_LABELS[key], entries: buckets[key] }));
}
