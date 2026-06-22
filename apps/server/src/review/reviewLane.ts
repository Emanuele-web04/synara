import { createHash } from "node:crypto";

import type { ReviewPullRequestSummary } from "@t3tools/contracts";

/** Board lane for a PR. Mirrors the client's `deriveReviewColumn`. */
export function deriveReviewLane(summary: ReviewPullRequestSummary): string {
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

/** Stable short hash of a PR summary; lets a sync skip rows that did not change. */
export function reviewPullRequestContentHash(summary: ReviewPullRequestSummary): string {
  return createHash("sha256").update(JSON.stringify(summary)).digest("hex").slice(0, 16);
}
