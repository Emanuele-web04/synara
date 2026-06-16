import type { ReviewPullRequestSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  type ActiveReviewFilter,
  applyReviewFilters,
  assigneeFilterDef,
  authorFilterDef,
  baseBranchFilterDef,
  buildReviewPullFilterOptions,
  checksFilterDef,
  filterReviewPullRequests,
  headBranchFilterDef,
  labelFilterDef,
  reviewPullFilterDefs,
  sortReviewItems,
  reviewPullSortOptions,
  statusFilterDef,
  toReviewServerListFilters,
  uniqueReviewPullRequests,
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
    labels: [],
    assignees: [],
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

  it("derives unique, sorted label options from the items present", () => {
    const options = labelFilterDef.extractOptions([
      pr({ labels: ["bug", "priority 1"] }),
      pr({ labels: ["feature", "bug"] }),
    ]);
    expect(options.map((option) => option.value)).toEqual(["bug", "feature", "priority 1"]);
  });

  it("derives unique, sorted assignee options from the items present", () => {
    const options = assigneeFilterDef.extractOptions([
      pr({ assignees: ["bob", "alice"] }),
      pr({ assignees: ["alice", "carol"] }),
    ]);
    expect(options.map((option) => option.value)).toEqual(["alice", "bob", "carol"]);
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

describe("buildReviewPullFilterOptions", () => {
  it("derives all PR filter options in one pass", () => {
    const options = buildReviewPullFilterOptions([
      pr({
        author: "bob",
        baseBranch: "release",
        headBranch: "feature/review-board",
        headSelector: "octocat:feature/review-board",
        labels: ["bug", "priority 1"],
        assignees: ["carol"],
        checksStatus: "failing",
      }),
      pr({
        author: "alice",
        baseBranch: "main",
        headBranch: "bugfix/search",
        labels: ["feature", "bug"],
        assignees: ["alice"],
        isDraft: true,
        checksStatus: "passing",
      }),
    ]);

    expect(options.get("author")?.map((option) => option.value)).toEqual(["alice", "bob"]);
    expect(options.get("base")?.map((option) => option.value)).toEqual(["main", "release"]);
    expect(options.get("head")?.map((option) => option.value)).toEqual([
      "bugfix/search",
      "octocat:feature/review-board",
    ]);
    expect(options.get("label")?.map((option) => option.value)).toEqual([
      "bug",
      "feature",
      "priority 1",
    ]);
    expect(options.get("assignee")?.map((option) => option.value)).toEqual(["alice", "carol"]);
    expect(options.get("status")?.map((option) => option.value)).toEqual([
      "needs-review",
      "draft",
    ]);
    expect(options.get("checks")?.map((option) => option.value)).toEqual(["passing", "failing"]);
  });
});

describe("uniqueReviewPullRequests", () => {
  it("dedupes cached PR summaries by number and URL", () => {
    expect(
      uniqueReviewPullRequests([
        pr({ number: 1, url: "https://github.com/acme/repo/pull/1", title: "old" }),
        pr({ number: 1, url: "https://github.com/acme/repo/pull/1", title: "new" }),
        pr({ number: 2, url: "https://github.com/acme/repo/pull/2", title: "other" }),
      ]).map((item) => item.title),
    ).toEqual(["new", "other"]);
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
        labels: ["performance"],
        assignees: ["tyler"],
      }),
      pr({ number: 2, title: "Fix logout", url: "https://github.com/acme/repo/pull/221" }),
      pr({ number: 3, title: "Improve review", reviewRequests: ["reviewer"] }),
      pr({ number: 4, title: "Unrelated" }),
    ];

    expect(filterReviewPullRequests(items, "search-panel", []).map((item) => item.number)).toEqual([
      1,
    ]);
    expect(filterReviewPullRequests(items, "octocat:", []).map((item) => item.number)).toEqual([1]);
    expect(filterReviewPullRequests(items, "performance", []).map((item) => item.number)).toEqual([
      1,
    ]);
    expect(filterReviewPullRequests(items, "tyler", []).map((item) => item.number)).toEqual([1]);
    expect(filterReviewPullRequests(items, "pull/221", []).map((item) => item.number)).toEqual([
      2,
    ]);
    expect(filterReviewPullRequests(items, "reviewer", []).map((item) => item.number)).toEqual([3]);
  });
});

describe("toReviewServerListFilters", () => {
  it("projects bounded server-side list facets into stable filters", () => {
    expect(
      toReviewServerListFilters([
        filter("author", ["alice"]),
        filter("base", ["main"]),
        filter("head", ["feature/review-board"]),
        filter("label", ["bug"]),
        filter("assignee", ["tyler"]),
        filter("status", ["approved", "needs-review"]),
        filter("checks", ["pending", "passing"]),
      ]),
    ).toEqual({
      author: "alice",
      baseBranch: "main",
      headBranch: "feature/review-board",
      label: "bug",
      assignee: "tyler",
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
        filter("assignee", ["alice", "bob"]),
      ]),
    ).toEqual({});
  });

  it("projects multi-label OR filters into stable server filters", () => {
    expect(toReviewServerListFilters([filter("label", ["feature", "bug"])])).toEqual({
      labels: ["bug", "feature"],
    });
  });

  it("pushes single draft status natively without changing mixed-status OR semantics", () => {
    expect(toReviewServerListFilters([filter("status", ["draft"])])).toEqual({
      draft: true,
      columns: ["draft"],
    });

    expect(toReviewServerListFilters([filter("status", ["approved", "draft"])])).toEqual({
      columns: ["approved", "draft"],
    });
  });
});
