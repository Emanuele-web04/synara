// FILE: pullRequestList.logic.ts
// Purpose: Pure grouping helper for the pull request list's "All" tab — buckets entries by the
//          viewer's involvement (review requested, authored, others) so the list can
//          render muted section headers the way the reference design does, without duplicating
//          this classification in the route component itself.
// Layer: Web domain helpers (no React)
// Exports: PullRequestListGroupKey, PullRequestListGroup, grouping, identity, and badge helpers

import type { PullRequestListEntry } from "@synara/contracts";

export type PullRequestListGroupKey = "reviewRequested" | "authored" | "others";

export interface PullRequestListGroup {
  key: PullRequestListGroupKey;
  label: string;
  entries: PullRequestListEntry[];
}

const GROUP_LABELS: Record<PullRequestListGroupKey, string> = {
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

export function countUniqueViewerReviewRequests(entries: readonly PullRequestListEntry[]): number {
  return new Set(entries.filter((entry) => entry.viewerReviewRequested).map(pullRequestIdentity))
    .size;
}

// We only claim relationships represented by list data. In particular, no "previously reviewed"
// bucket is inferred from authorship because the API result has no review-history signal.
export function groupPullRequestEntriesByInvolvement(
  entries: readonly PullRequestListEntry[],
  viewerLogin: string | null | undefined,
): PullRequestListGroup[] {
  const normalizedViewer = viewerLogin?.trim().toLowerCase() || null;

  const buckets: Record<PullRequestListGroupKey, PullRequestListEntry[]> = {
    reviewRequested: [],
    authored: [],
    others: [],
  };

  for (const entry of entries) {
    const authorLogin = entry.author?.login.trim().toLowerCase() || null;
    if (authorLogin && normalizedViewer && authorLogin === normalizedViewer) {
      buckets.authored.push(entry);
    } else if (entry.viewerReviewRequested) {
      buckets.reviewRequested.push(entry);
    } else {
      buckets.others.push(entry);
    }
  }

  const order: PullRequestListGroupKey[] = ["reviewRequested", "authored", "others"];
  return order
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: GROUP_LABELS[key], entries: buckets[key] }));
}
