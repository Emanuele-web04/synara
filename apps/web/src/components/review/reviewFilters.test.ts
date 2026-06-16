import type { ReviewPullRequestSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  type ActiveReviewFilter,
  applyReviewFilters,
  authorFilterDef,
  baseBranchFilterDef,
  checksFilterDef,
  filterReviewPullRequests,
  headBranchFilterDef,
  reviewPullFilterDefs,
  sortReviewItems,
  reviewPullSortOptions,
  statusFilterDef,
  toReviewServerListFilters,
} from "./reviewFilters";

function pr(overrides: Partial<ReviewPullRequestSummary>): ReviewPullRequestSummary {
  return {
    number: 1,
    title: "Pull request",
    url: "",
    baseBranch: "main",
    headBranch: "feature",
    author: "alice",
    updatedAt: "2026-01-01T00:00:00Z",
    state: "open",
    reviewDecision: null,
    isDraft: false,
    additions: 1,
    deletions: 1,
    checksStatus: "none",
    reviewRequests: [],
    ...overrides,
  };
}

function filter(fieldId: string, values: string[]): ActiveReviewFilter {
  return { fieldId, values: new Set(values) };
}

describe("review filter definitions", () => {
  it("derives unique, sorted author options from the items present", () => {
    const options = authorFilterDef.extractOptions([
      pr({ author: "bob" }),
      pr({ author: "alice" }),
      pr({ author: "bob" }),
    ]);
    expect(options.map((option) => option.value)).toEqual(["alice", "bob"]);
  });

  it("derives unique, sorted base branch options from the items present", () => {
    const options = baseBranchFilterDef.extractOptions([
      pr({ baseBranch: "release" }),
      pr({ baseBranch: "main" }),
      pr({ baseBranch: "release" }),
    ]);
    expect(options.map((option) => option.value)).toEqual(["main", "release"]);
  });

  it("derives unique, sorted head branch options from the items present", () => {
    const options = headBranchFilterDef.extractOptions([
      pr({ headBranch: "feature/review-board", headSelector: "octocat:feature/review-board" }),
      pr({ headBranch: "bugfix/search" }),
      pr({ headBranch: "feature/review-board", headSelector: "octocat:feature/review-board" }),
    ]);
    expect(options.map((option) => option.value)).toEqual([
      "bugfix/search",
      "octocat:feature/review-board",
    ]);
  });

  it("only offers check statuses that actually occur (never 'none')", () => {
    const options = checksFilterDef.extractOptions([
      pr({ checksStatus: "failing" }),
      pr({ checksStatus: "none" }),
    ]);
    expect(options.map((option) => option.value)).toEqual(["failing"]);
  });

  it("matches an item to its derived status column", () => {
    const draft = pr({ isDraft: true });
    expect(statusFilterDef.match(draft, new Set(["draft"]))).toBe(true);
    expect(statusFilterDef.match(draft, new Set(["needs-review"]))).toBe(false);
  });
});

describe("applyReviewFilters", () => {
  const items = [
    pr({ number: 1, author: "alice", checksStatus: "passing" }),
    pr({ number: 2, author: "bob", checksStatus: "failing" }),
    pr({ number: 3, author: "alice", checksStatus: "failing" }),
  ];

  it("returns all items when no filter values are set", () => {
    expect(applyReviewFilters(items, [], reviewPullFilterDefs)).toHaveLength(3);
    expect(applyReviewFilters(items, [filter("author", [])], reviewPullFilterDefs)).toHaveLength(3);
  });

  it("ORs values within a facet", () => {
    const result = applyReviewFilters(
      items,
      [filter("author", ["alice", "bob"])],
      reviewPullFilterDefs,
    );
    expect(result).toHaveLength(3);
  });

  it("ANDs across facets", () => {
    const result = applyReviewFilters(
      items,
      [filter("author", ["alice"]), filter("checks", ["failing"])],
      reviewPullFilterDefs,
    );
    expect(result.map((item) => item.number)).toEqual([3]);
  });
});

describe("sortReviewItems", () => {
  it("sorts by most recently updated", () => {
    const result = sortReviewItems(
      [
        pr({ number: 1, updatedAt: "2026-01-01T00:00:00Z" }),
        pr({ number: 2, updatedAt: "2026-02-01T00:00:00Z" }),
      ],
      "updated",
      reviewPullSortOptions,
    );
    expect(result.map((item) => item.number)).toEqual([2, 1]);
  });

  it("returns items unchanged for an unknown sort id", () => {
    const input = [pr({ number: 1 }), pr({ number: 2 })];
    expect(sortReviewItems(input, "nope", reviewPullSortOptions)).toBe(input);
  });
});

describe("filterReviewPullRequests", () => {
  it("combines text search with facet filters", () => {
    const items = [
      pr({ number: 1, title: "Add login", author: "alice" }),
      pr({ number: 2, title: "Fix logout", author: "bob" }),
      pr({ number: 3, title: "Add logging", author: "alice" }),
    ];
    const result = filterReviewPullRequests(items, "log", [filter("author", ["alice"])]);
    expect(result.map((item) => item.number)).toEqual([1, 3]);
  });

  it("matches branch names, URLs, and requested reviewers in text search", () => {
    const items = [
      pr({
        number: 1,
        title: "Add login",
        headBranch: "feature/search-panel",
        headSelector: "octocat:feature/search-panel",
      }),
      pr({ number: 2, title: "Fix logout", url: "https://github.com/acme/repo/pull/221" }),
      pr({ number: 3, title: "Improve review", reviewRequests: ["tyler"] }),
      pr({ number: 4, title: "Unrelated" }),
    ];

    expect(filterReviewPullRequests(items, "search-panel", []).map((item) => item.number)).toEqual([
      1,
    ]);
    expect(filterReviewPullRequests(items, "octocat:", []).map((item) => item.number)).toEqual([1]);
    expect(filterReviewPullRequests(items, "pull/221", []).map((item) => item.number)).toEqual([
      2,
    ]);
    expect(filterReviewPullRequests(items, "tyler", []).map((item) => item.number)).toEqual([3]);
  });
});

describe("toReviewServerListFilters", () => {
  it("projects bounded server-side list facets into stable filters", () => {
    expect(
      toReviewServerListFilters([
        filter("author", ["alice"]),
        filter("base", ["main"]),
        filter("head", ["feature/review-board"]),
        filter("status", ["approved", "needs-review"]),
        filter("checks", ["pending", "passing"]),
      ]),
    ).toEqual({
      author: "alice",
      baseBranch: "main",
      headBranch: "feature/review-board",
      columns: ["approved", "needs-review"],
      checks: ["passing", "pending"],
    });
  });

  it("leaves multi-value OR filters on the client when GitHub has no native OR flag", () => {
    expect(
      toReviewServerListFilters([
        filter("author", ["alice", "bob"]),
        filter("base", ["main", "dev"]),
        filter("head", ["feature/review-board", "bugfix/search"]),
      ]),
    ).toEqual({});
  });
});
