import type { ReviewPullRequestSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveReviewColumn,
  filterBySearch,
  filterByView,
  groupByColumn,
} from "./reviewBoardColumns";

function makeSummary(overrides: Partial<ReviewPullRequestSummary> = {}): ReviewPullRequestSummary {
  return {
    number: 1,
    title: "Add feature",
    url: "https://github.com/owner/repo/pull/1",
    baseBranch: "main",
    headBranch: "feature",
    author: "alice",
    updatedAt: "2026-01-01T00:00:00Z",
    state: "open",
    reviewDecision: null,
    isDraft: false,
    additions: 10,
    deletions: 2,
    checksStatus: "passing",
    reviewRequests: [],
    labels: [],
    ...overrides,
  };
}

describe("deriveReviewColumn", () => {
  it("returns draft when isDraft regardless of decision", () => {
    expect(deriveReviewColumn(makeSummary({ isDraft: true, reviewDecision: "APPROVED" }))).toBe(
      "draft",
    );
  });

  it("returns merged for merged state", () => {
    expect(deriveReviewColumn(makeSummary({ state: "merged" }))).toBe("merged");
  });

  it("returns changes-requested for CHANGES_REQUESTED", () => {
    expect(deriveReviewColumn(makeSummary({ reviewDecision: "CHANGES_REQUESTED" }))).toBe(
      "changes-requested",
    );
  });

  it("returns approved for APPROVED", () => {
    expect(deriveReviewColumn(makeSummary({ reviewDecision: "APPROVED" }))).toBe("approved");
  });

  it("falls back to needs-review", () => {
    expect(deriveReviewColumn(makeSummary({ reviewDecision: "REVIEW_REQUIRED" }))).toBe(
      "needs-review",
    );
    expect(deriveReviewColumn(makeSummary({ reviewDecision: null }))).toBe("needs-review");
  });

  it("prefers draft over merged", () => {
    expect(deriveReviewColumn(makeSummary({ isDraft: true, state: "merged" }))).toBe("draft");
  });
});

describe("filterByView", () => {
  const mine = makeSummary({ number: 1, author: "me" });
  const requested = makeSummary({ number: 2, author: "other", reviewRequests: ["me"] });
  const unrelated = makeSummary({ number: 3, author: "other", reviewRequests: ["someone"] });
  const all = [mine, requested, unrelated];

  it("returns everything for all view", () => {
    expect(filterByView(all, "all", "me")).toEqual(all);
  });

  it("returns everything when viewer is unknown", () => {
    expect(filterByView(all, "mine", null)).toEqual(all);
    expect(filterByView(all, "needs-my-review", null)).toEqual(all);
  });

  it("filters to authored PRs for mine", () => {
    expect(filterByView(all, "mine", "me")).toEqual([mine]);
  });

  it("filters to requested reviews for needs-my-review", () => {
    expect(filterByView(all, "needs-my-review", "me")).toEqual([requested]);
  });
});

describe("filterBySearch", () => {
  const summaries = [
    makeSummary({ number: 12, title: "Fix login", author: "alice" }),
    makeSummary({ number: 34, title: "Add dashboard", author: "bob" }),
  ];

  it("returns all for blank query", () => {
    expect(filterBySearch(summaries, "   ")).toEqual(summaries);
  });

  it("matches title case-insensitively", () => {
    expect(filterBySearch(summaries, "LOGIN")).toEqual([summaries[0]]);
  });

  it("matches number with and without hash", () => {
    expect(filterBySearch(summaries, "#34")).toEqual([summaries[1]]);
    expect(filterBySearch(summaries, "12")).toEqual([summaries[0]]);
  });

  it("matches author", () => {
    expect(filterBySearch(summaries, "bob")).toEqual([summaries[1]]);
  });
});

describe("groupByColumn", () => {
  it("buckets summaries into their derived columns", () => {
    const groups = groupByColumn([
      makeSummary({ number: 1, isDraft: true }),
      makeSummary({ number: 2, reviewDecision: "APPROVED" }),
      makeSummary({ number: 3 }),
      makeSummary({ number: 4, state: "merged" }),
    ]);
    expect(groups.draft.map((s) => s.number)).toEqual([1]);
    expect(groups.approved.map((s) => s.number)).toEqual([2]);
    expect(groups["needs-review"].map((s) => s.number)).toEqual([3]);
    expect(groups.merged.map((s) => s.number)).toEqual([4]);
    expect(groups["changes-requested"]).toEqual([]);
  });
});
