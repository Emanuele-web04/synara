// FILE: pullRequestList.logic.ts
// Purpose: Pure grouping helper for the pull request list's "All" tab — buckets entries by the
//          viewer's involvement (review requested, authored, others) so the list can
//          render muted section headers the way the reference design does, without duplicating
//          this classification in the route component itself.
// Layer: Web domain helpers (no React)
// Exports: PullRequestListGroupKey, PullRequestListGroup, grouping, pinned ordering,
//          involvement/search filters, identity, and badge helpers

import type { PullRequestInvolvement, PullRequestListEntry } from "@synara/contracts";

export type PullRequestListGroupKey = "pinned" | "reviewRequested" | "authored" | "others";

export interface PullRequestListGroup {
  key: PullRequestListGroupKey;
  label: string;
  entries: PullRequestListEntry[];
}

const GROUP_LABELS: Record<PullRequestListGroupKey, string> = {
  pinned: "Pinned",
  reviewRequested: "Review requested",
  authored: "Authored",
  others: "Others",
};

function pullRequestIdentity(entry: PullRequestListEntry): string {
  return `${entry.repository.trim().toLowerCase()}#${entry.number}`;
}

export function pullRequestListEntryKey(entry: PullRequestListEntry): string {
  return `${entry.projectId}:${pullRequestIdentity(entry)}`;
}

// The list is fetched once per state as the "all" involvement superset; the Reviewing and
// Authored tabs are views over it, so switching tabs never waits on the network. Reviewing
// relies on the server-computed viewerReviewRequested flag (which includes team-routed review
// requests); Authored matches the author login case-insensitively, like the grouping above.
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
    return entries.filter(
      (entry) =>
        normalizedViewer !== null && entry.author?.login.trim().toLowerCase() === normalizedViewer,
    );
  }
  return [...entries];
}

/** Free-text list filter: matches title, repository, head branch, "#123"/"123", and author. */
export function matchesPullRequestSearchQuery(
  entry: PullRequestListEntry,
  normalizedQuery: string,
): boolean {
  if (normalizedQuery.length === 0) return true;
  return `${entry.title} ${entry.repository} ${entry.headBranch} #${entry.number} ${entry.author?.login ?? ""}`
    .toLowerCase()
    .includes(normalizedQuery);
}

export function countUniqueViewerReviewRequests(entries: readonly PullRequestListEntry[]): number {
  return new Set(entries.filter((entry) => entry.viewerReviewRequested).map(pullRequestIdentity))
    .size;
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
    const authorLogin = entry.author?.login.trim().toLowerCase() || null;
    if (authorLogin && normalizedViewer && authorLogin === normalizedViewer) {
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
