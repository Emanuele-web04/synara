import type { ReviewPullRequestSummary } from "@t3tools/contracts";

export type ReviewColumnId = "draft" | "needs-review" | "changes-requested" | "approved" | "merged";

export type ReviewBoardView = "needs-my-review" | "mine" | "merged" | "all";

// Per-column accent reinforces review state at a glance; the text label still
// carries the meaning, so color is never the sole signal (a11y color-not-only).
export type ReviewColumnAccent = "attention" | "warning" | "success" | "muted" | "merged";

export const REVIEW_BOARD_COLUMNS: ReadonlyArray<{
  id: ReviewColumnId;
  label: string;
  accent: ReviewColumnAccent;
  emptyTitle: string;
  emptyHint: string;
}> = [
  {
    id: "needs-review",
    label: "Needs Review",
    accent: "attention",
    emptyTitle: "All caught up",
    emptyHint: "Nothing waiting on a first review.",
  },
  {
    id: "changes-requested",
    label: "Changes Requested",
    accent: "warning",
    emptyTitle: "No change requests",
    emptyHint: "Nothing sent back for changes.",
  },
  {
    id: "approved",
    label: "Approved",
    accent: "success",
    emptyTitle: "None approved yet",
    emptyHint: "Approved PRs collect here.",
  },
  {
    id: "draft",
    label: "Draft",
    accent: "muted",
    emptyTitle: "No drafts",
    emptyHint: "Draft PRs show up here.",
  },
  {
    id: "merged",
    label: "Merged",
    accent: "merged",
    emptyTitle: "Nothing merged",
    emptyHint: "Recently merged PRs land here.",
  },
];

export const REVIEW_BOARD_VIEWS: ReadonlyArray<{ id: ReviewBoardView; label: string }> = [
  { id: "needs-my-review", label: "Needs my review" },
  { id: "mine", label: "My open PRs" },
  { id: "merged", label: "Merged" },
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
  if (view === "all" || view === "merged" || !viewerLogin) {
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
      summary.author.toLowerCase().includes(normalized) ||
      summary.baseBranch.toLowerCase().includes(normalized) ||
      summary.headBranch.toLowerCase().includes(normalized) ||
      (summary.headSelector?.toLowerCase().includes(normalized) ?? false) ||
      summary.url.toLowerCase().includes(normalized) ||
      summary.labels.some((label) => label.toLowerCase().includes(normalized)) ||
      summary.assignees.some((assignee) => assignee.toLowerCase().includes(normalized)) ||
      summary.reviewRequests.some((reviewer) => reviewer.toLowerCase().includes(normalized)),
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
