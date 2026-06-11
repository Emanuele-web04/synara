import type { ReviewPullRequestSummary } from "@t3tools/contracts";

export type ReviewColumnId = "draft" | "needs-review" | "changes-requested" | "approved" | "merged";

export type ReviewBoardView = "needs-my-review" | "mine" | "all";

export const REVIEW_BOARD_COLUMNS: ReadonlyArray<{
  id: ReviewColumnId;
  label: string;
  emptyTitle: string;
  emptyHint: string;
}> = [
  {
    id: "needs-review",
    label: "Needs Review",
    emptyTitle: "All caught up",
    emptyHint: "Nothing waiting on a first review.",
  },
  {
    id: "changes-requested",
    label: "Changes Requested",
    emptyTitle: "No change requests",
    emptyHint: "Nothing sent back for changes.",
  },
  {
    id: "approved",
    label: "Approved",
    emptyTitle: "None approved yet",
    emptyHint: "Approved PRs collect here.",
  },
  {
    id: "draft",
    label: "Draft",
    emptyTitle: "No drafts",
    emptyHint: "Draft PRs show up here.",
  },
  {
    id: "merged",
    label: "Merged",
    emptyTitle: "Nothing merged",
    emptyHint: "Recently merged PRs land here.",
  },
];

export const REVIEW_BOARD_VIEWS: ReadonlyArray<{ id: ReviewBoardView; label: string }> = [
  { id: "needs-my-review", label: "Needs my review" },
  { id: "mine", label: "My open PRs" },
  { id: "all", label: "All open" },
];

export function deriveReviewColumn(summary: ReviewPullRequestSummary): ReviewColumnId {
  if (summary.isDraft) {
    return "draft";
  }
  if (summary.state === "merged") {
    return "merged";
  }
  if (summary.reviewDecision === "CHANGES_REQUESTED") {
    return "changes-requested";
  }
  if (summary.reviewDecision === "APPROVED") {
    return "approved";
  }
  return "needs-review";
}

export function filterByView(
  summaries: readonly ReviewPullRequestSummary[],
  view: ReviewBoardView,
  viewerLogin: string | null,
): readonly ReviewPullRequestSummary[] {
  if (view === "all" || !viewerLogin) {
    return summaries;
  }
  if (view === "mine") {
    return summaries.filter((summary) => summary.author === viewerLogin);
  }
  return summaries.filter((summary) => summary.reviewRequests.includes(viewerLogin));
}

export function filterBySearch(
  summaries: readonly ReviewPullRequestSummary[],
  query: string,
): readonly ReviewPullRequestSummary[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return summaries;
  }
  return summaries.filter(
    (summary) =>
      summary.title.toLowerCase().includes(normalized) ||
      String(summary.number).includes(normalized) ||
      `#${summary.number}`.includes(normalized) ||
      summary.author.toLowerCase().includes(normalized),
  );
}

export function groupByColumn(
  summaries: readonly ReviewPullRequestSummary[],
): Record<ReviewColumnId, ReviewPullRequestSummary[]> {
  const groups: Record<ReviewColumnId, ReviewPullRequestSummary[]> = {
    draft: [],
    "needs-review": [],
    "changes-requested": [],
    approved: [],
    merged: [],
  };
  for (const summary of summaries) {
    groups[deriveReviewColumn(summary)].push(summary);
  }
  return groups;
}
