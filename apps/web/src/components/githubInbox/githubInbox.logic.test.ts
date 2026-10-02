import { describe, expect, it } from "vitest";

import type {
  GitHubInboxItem,
  GitHubInboxRepositoryBatch,
  ProjectId,
  PullRequestActor,
} from "@synara/contracts";

import {
  collectInboxLabelOptions,
  countActiveGitHubInboxFilters,
  countInboxItemsByKind,
  countTruncatedInboxRepositories,
  githubInboxSelection,
  githubInboxSendTargets,
  groupVisibleInboxItems,
  resolveInboxItemReference,
  mergeGitHubInboxSearch,
  parseGitHubInboxSearch,
  resolveGitHubInboxFilters,
  githubInboxListState,
  selectVisibleInboxItems,
  toggleGitHubInboxLabel,
  type GitHubInboxFilterSettings,
  type GitHubInboxFilters,
} from "./githubInbox.logic";

const projectA = "project-a" as ProjectId;
const projectB = "project-b" as ProjectId;

function actor(login: string): PullRequestActor {
  return { login, name: null, avatarUrl: null, url: null };
}

function pullRequest(
  number: number,
  overrides: Partial<Extract<GitHubInboxItem, { kind: "pullRequest" }>> = {},
): GitHubInboxItem {
  const projectId = overrides.projectId ?? projectA;
  return {
    kind: "pullRequest",
    projectId,
    projectTitle: projectId === projectA ? "A" : "B",
    projectContexts: [
      {
        projectId,
        projectTitle: projectId === projectA ? "A" : "B",
        isPinned: overrides.isPinned ?? false,
      },
    ],
    repository: "acme/widgets",
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    author: actor("someone"),
    headBranch: `feature-${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    additions: 1,
    deletions: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    reviewDecision: null,
    viewerReviewRequested: false,
    isPinned: false,
    mergeability: "unknown",
    stack: null,
    labels: [],
    commentCount: 0,
    assignees: [],
    viewerInvolvement: { authored: false, assigned: false, involved: false },
    ...overrides,
  };
}

function issue(
  number: number,
  overrides: Partial<Extract<GitHubInboxItem, { kind: "issue" }>> = {},
): GitHubInboxItem {
  const projectId = overrides.projectId ?? projectA;
  return {
    kind: "issue",
    projectId,
    projectTitle: projectId === projectA ? "A" : "B",
    projectContexts: [
      {
        projectId,
        projectTitle: projectId === projectA ? "A" : "B",
        isPinned: overrides.isPinned ?? false,
      },
    ],
    repository: projectId === projectA ? "acme/widgets" : "acme/gadgets",
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/widgets/issues/${number}`,
    author: actor("someone"),
    state: "open",
    stateReason: null,
    labels: [],
    assignees: [],
    commentCount: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    closedAt: null,
    isPinned: false,
    viewerInvolvement: { authored: false, assigned: false, involved: false },
    ...overrides,
  };
}

const DEFAULT_SETTINGS: GitHubInboxFilterSettings = {
  githubInboxKind: "all",
  githubInboxState: "open",
  githubInboxInvolvement: "everything",
  githubInboxProjectIds: [],
  githubInboxLabels: [],
};

function filters(overrides: Partial<GitHubInboxFilters> = {}): GitHubInboxFilters {
  return {
    kind: "all",
    state: "open",
    involvement: "everything",
    projectIds: [],
    labels: [],
    ...overrides,
  };
}

describe("parseGitHubInboxSearch", () => {
  it("keeps valid overrides and selection, and drops everything else", () => {
    expect(
      parseGitHubInboxSearch({
        type: "issue",
        state: "closed",
        involvement: "assigned",
        projectId: "project-a",
        q: "crash",
        kind: "issue",
        selectedProjectId: "project-a",
        selectedRepo: "acme/widgets",
        number: 7,
        unknown: "ignored",
      }),
    ).toEqual({
      type: "issue",
      state: "closed",
      involvement: "assigned",
      projectId: "project-a",
      q: "crash",
      kind: "issue",
      selectedProjectId: "project-a",
      selectedRepo: "acme/widgets",
      number: 7,
    });
    expect(
      parseGitHubInboxSearch({
        type: "gist",
        state: "draft",
        selectedRepo: "../etc",
        number: -1,
      }),
    ).toEqual({});
  });

  it("reads links from the pull request page", () => {
    // The old sidebar forced involvement=all&state=open on every visit.
    expect(parseGitHubInboxSearch({ involvement: "all", state: "open" })).toEqual({
      state: "open",
    });
    expect(parseGitHubInboxSearch({ involvement: "reviewing", state: "merged" })).toEqual({
      involvement: "reviewRequested",
      state: "merged",
    });
    expect(parseGitHubInboxSearch({ involvement: "authored" })).toEqual({
      involvement: "authored",
    });
  });

  it("caps the search text", () => {
    expect(parseGitHubInboxSearch({ q: "x".repeat(500) }).q).toHaveLength(200);
  });
});

describe("mergeGitHubInboxSearch", () => {
  it("drops cleared fields so the URL only carries what is set", () => {
    expect(
      mergeGitHubInboxSearch({ type: "issue", q: "crash" }, { type: undefined, q: "" }),
    ).toEqual({});
  });
});

describe("githubInboxSelection", () => {
  it("defaults the kind to pull request for links from the pull request page", () => {
    expect(
      githubInboxSelection({
        selectedProjectId: projectA,
        selectedRepo: "acme/widgets",
        number: 4,
      }),
    ).toEqual({
      kind: "pullRequest",
      projectId: projectA,
      repository: "acme/widgets",
      number: 4,
    });
  });

  it("ignores a selection outside the URL's project override", () => {
    expect(
      githubInboxSelection({
        projectId: projectB,
        selectedProjectId: projectA,
        selectedRepo: "acme/widgets",
        number: 4,
      }),
    ).toBeNull();
  });
});

describe("resolveGitHubInboxFilters", () => {
  const existing = new Set([projectA, projectB]);

  it("uses the persisted filters when the URL has no overrides", () => {
    expect(
      resolveGitHubInboxFilters(
        {},
        {
          ...DEFAULT_SETTINGS,
          githubInboxKind: "issue",
          githubInboxState: "closed",
          githubInboxProjectIds: [projectA, projectB],
          githubInboxLabels: ["kind:bug"],
        },
        existing,
      ),
    ).toEqual({
      kind: "issue",
      state: "closed",
      involvement: "everything",
      projectIds: [projectA, projectB],
      labels: ["kind:bug"],
    });
  });

  it("lets URL overrides win for one visit", () => {
    expect(
      resolveGitHubInboxFilters(
        { type: "pullRequest", involvement: "authored", projectId: projectB },
        { ...DEFAULT_SETTINGS, githubInboxProjectIds: [projectA] },
        existing,
      ),
    ).toMatchObject({
      kind: "pullRequest",
      involvement: "authored",
      projectIds: [projectB],
    });
  });

  it("forgets persisted projects that were removed", () => {
    expect(
      resolveGitHubInboxFilters(
        {},
        { ...DEFAULT_SETTINGS, githubInboxProjectIds: ["gone", projectA] },
        existing,
      ).projectIds,
    ).toEqual([projectA]);
  });
});

describe("selectVisibleInboxItems", () => {
  const viewer = "viewer";
  const items: GitHubInboxItem[] = [
    pullRequest(1, {
      viewerReviewRequested: true,
      labels: [{ name: "kind:bug", color: null }],
    }),
    issue(2, {
      assignees: [actor("viewer")],
      labels: [{ name: "Kind:Bug", color: "d73a4a" }],
    }),
    issue(3, { projectId: projectB, title: "Crash on launch" }),
    pullRequest(4, { isPinned: true, author: actor("viewer") }),
  ];
  const numbers = (next: GitHubInboxFilters, normalizedQuery = "") =>
    selectVisibleInboxItems(items, next, { viewer, normalizedQuery }).map((item) => item.number);

  it("shows both kinds, pinned first", () => {
    expect(numbers(filters())).toEqual([4, 3, 2, 1]);
  });

  it("filters by kind", () => {
    expect(numbers(filters({ kind: "pullRequest" }))).toEqual([4, 1]);
    expect(numbers(filters({ kind: "issue" }))).toEqual([3, 2]);
  });

  it("filters by any selected project", () => {
    expect(numbers(filters({ projectIds: [projectB] }))).toEqual([3]);
    expect(numbers(filters({ projectIds: [projectA, projectB] }))).toEqual([4, 3, 2, 1]);
  });

  it("filters by involvement across kinds", () => {
    expect(numbers(filters({ involvement: "reviewRequested" }))).toEqual([1]);
    expect(numbers(filters({ involvement: "assigned" }))).toEqual([2]);
    expect(numbers(filters({ involvement: "authored" }))).toEqual([4]);
    expect(numbers(filters({ involvement: "involved" }))).toEqual([4, 2, 1]);
  });

  it("matches any selected label, ignoring case", () => {
    expect(numbers(filters({ labels: ["KIND:BUG"] }))).toEqual([2, 1]);
  });

  it("combines kind, project, involvement, label, and text filters", () => {
    expect(numbers(filters({ kind: "issue", labels: ["kind:bug"] }))).toEqual([2]);
    expect(numbers(filters({ kind: "issue", projectIds: [projectB] }), "crash")).toEqual([3]);
    expect(numbers(filters({ kind: "pullRequest", involvement: "assigned" }))).toEqual([]);
  });

  it.each([
    { sort: "created" as const, expected: [4, 3, 2, 1] },
    { sort: "updated" as const, expected: [4, 1, 3, 2] },
  ])("orders interleaved rows by $sort with pins first", ({ sort, expected }) => {
    const older = items.map((item) =>
      item.number === 1 ? { ...item, updatedAt: "2030-01-01T00:00:00.000Z" } : item,
    );
    const ordered = selectVisibleInboxItems(older, filters(), {
      sort,
      viewer,
      normalizedQuery: "",
    });
    expect(ordered.map((item) => item.number)).toEqual(expected);
  });

  it("lists pins first, then every other row in one list by latest activity", () => {
    // The viewer's own row is the oldest; it must not jump ahead of newer rows by others.
    const ownIsOldest = items.map((item) =>
      item.number === 4
        ? pullRequest(4, { author: actor("viewer"), updatedAt: "2000-01-01T00:00:00.000Z" })
        : item,
    );
    const visible = selectVisibleInboxItems(ownIsOldest, filters(), {
      sort: "updated",
      viewer,
      normalizedQuery: "",
    });
    const groups = groupVisibleInboxItems(visible);
    expect(groups.map((group) => group.key)).toEqual(["all"]);
    expect(groups[0]?.entries.map((item) => item.number).at(-1)).toBe(4);

    const pinned = groupVisibleInboxItems(
      selectVisibleInboxItems(items, filters(), { viewer, normalizedQuery: "" }),
    );
    expect(pinned.map((group) => group.key)).toEqual(["pinned", "all"]);
    expect(pinned[0]?.entries.map((item) => item.number)).toEqual([4]);
  });
});

describe("merged state filter", () => {
  it("reads the closed list and keeps only merged pull requests", () => {
    const closedList = [
      pullRequest(1, { state: "merged" }),
      pullRequest(2, { state: "closed" }),
      issue(3, { state: "closed" }),
    ];
    const merged = filters({ state: "merged" });
    expect(githubInboxListState("merged")).toBe("closed");
    expect(
      selectVisibleInboxItems(closedList, merged, { viewer: "me", normalizedQuery: "" }).map(
        (item) => item.number,
      ),
    ).toEqual([1]);
    // GitHub's closed totals would overcount, so the tabs count the matching rows.
    expect(
      countInboxItemsByKind(closedList, merged, {
        viewer: "me",
        normalizedQuery: "",
        repositoryBatches: [
          {
            repository: "acme/widgets",
            projectIds: [projectA],
            truncatedPullRequests: false,
            truncatedIssues: false,
            totalPullRequests: 40,
            totalIssues: 9,
            fetchedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      }),
    ).toEqual({ all: 1, pullRequest: 1, issue: 0 });
  });
});

describe("collectInboxLabelOptions", () => {
  it("counts labels in scope, most used first, and keeps selected ones listed", () => {
    const items = [
      issue(1, { labels: [{ name: "kind:bug", color: "d73a4a" }] }),
      issue(2, {
        labels: [
          { name: "kind:bug", color: "d73a4a" },
          { name: "area:ui", color: null },
        ],
      }),
      issue(3, {
        projectId: projectB,
        labels: [{ name: "area:server", color: null }],
      }),
    ];
    expect(
      collectInboxLabelOptions(items, filters({ projectIds: [projectA], labels: ["stale"] })),
    ).toEqual([
      { name: "kind:bug", color: "#d73a4a", count: 2 },
      { name: "area:ui", color: null, count: 1 },
      { name: "stale", color: null, count: 0 },
    ]);
  });

  it("toggles labels case-insensitively", () => {
    expect(toggleGitHubInboxLabel(["kind:bug"], "Kind:Bug")).toEqual([]);
    expect(toggleGitHubInboxLabel(["kind:bug"], "area:ui")).toEqual(["kind:bug", "area:ui"]);
  });
});

describe("countActiveGitHubInboxFilters", () => {
  it("counts every filter away from its default, including the closed state", () => {
    expect(countActiveGitHubInboxFilters(filters(), "  ")).toBe(0);
    expect(countActiveGitHubInboxFilters(filters({ state: "closed" }), "")).toBe(1);
    expect(
      countActiveGitHubInboxFilters(
        filters({
          kind: "issue",
          state: "closed",
          involvement: "assigned",
          projectIds: [projectA],
          labels: ["x"],
        }),
        " crash ",
      ),
    ).toBe(6);
  });
});

describe("countInboxItemsByKind", () => {
  const items: GitHubInboxItem[] = [
    pullRequest(1, { labels: [{ name: "kind:bug", color: null }] }),
    pullRequest(2),
    issue(3, { labels: [{ name: "kind:bug", color: null }] }),
    issue(4, { projectId: projectB }),
  ];
  const context = { viewer: "viewer", normalizedQuery: "" };

  it("shows GitHub's own totals while nothing narrows the view, and matches once it does", () => {
    const repositoryBatches = [
      {
        repository: "acme/app",
        projectIds: [projectA, projectB],
        truncatedPullRequests: true,
        truncatedIssues: true,
        totalPullRequests: 191,
        totalIssues: 151,
        fetchedAt: "2026-09-02T00:00:00.000Z",
      },
    ];
    const withTotals = { ...context, repositoryBatches };
    expect(countInboxItemsByKind(items, filters(), withTotals)).toEqual({
      all: 342,
      pullRequest: 191,
      issue: 151,
    });
    // A label filter is applied here, not by GitHub, so the count is the rows that match.
    expect(countInboxItemsByKind(items, filters({ labels: ["kind:bug"] }), withTotals)).toEqual({
      all: 2,
      pullRequest: 1,
      issue: 1,
    });
  });

  it("counts each kind under the other filters, whatever kind is selected", () => {
    expect(countInboxItemsByKind(items, filters({ kind: "issue" }), context)).toEqual({
      all: 4,
      pullRequest: 2,
      issue: 2,
    });
    expect(countInboxItemsByKind(items, filters({ labels: ["kind:bug"] }), context)).toEqual({
      all: 2,
      pullRequest: 1,
      issue: 1,
    });
    expect(countInboxItemsByKind(items, filters({ projectIds: [projectB] }), context)).toEqual({
      all: 1,
      pullRequest: 0,
      issue: 1,
    });
    expect(
      countInboxItemsByKind(items, filters(), {
        ...context,
        normalizedQuery: "pull request 2",
      }),
    ).toEqual({ all: 1, pullRequest: 1, issue: 0 });
  });
});

describe("countTruncatedInboxRepositories", () => {
  const batches: GitHubInboxRepositoryBatch[] = [
    {
      repository: "acme/widgets",
      projectIds: [projectA],
      truncatedPullRequests: true,
      truncatedIssues: false,
      fetchedAt: "2026-09-02T00:00:00.000Z",
    },
    {
      repository: "acme/gadgets",
      projectIds: [projectB],
      truncatedPullRequests: false,
      truncatedIssues: true,
      fetchedAt: "2026-09-02T00:00:00.000Z",
    },
  ];

  it("counts repositories cut for the kind and projects in view", () => {
    expect(countTruncatedInboxRepositories(batches, filters())).toBe(2);
    expect(countTruncatedInboxRepositories(batches, filters({ kind: "pullRequest" }))).toBe(1);
    expect(countTruncatedInboxRepositories(batches, filters({ kind: "issue" }))).toBe(1);
    expect(
      countTruncatedInboxRepositories(batches, filters({ kind: "issue", projectIds: [projectA] })),
    ).toBe(0);
  });
});

describe("githubInboxSendTargets", () => {
  const selection = {
    kind: "pullRequest" as const,
    projectId: projectA,
    repository: "Acme/Widgets",
    number: 5,
  };
  const shared = pullRequest(5, {
    projectContexts: [
      { projectId: projectA, projectTitle: "A", isPinned: false },
      { projectId: projectB, projectTitle: "B", isPinned: false },
    ],
  });

  it("offers every project whose repository lists the item", () => {
    expect(githubInboxSendTargets([shared, issue(5)], selection, { projectIds: [] })).toEqual([
      { projectId: projectA, projectTitle: "A" },
      { projectId: projectB, projectTitle: "B" },
    ]);
  });

  it("narrows to the project filter when it leaves a candidate", () => {
    expect(githubInboxSendTargets([shared], selection, { projectIds: [projectB] })).toEqual([
      { projectId: projectB, projectTitle: "B" },
    ]);
    expect(
      githubInboxSendTargets([shared], selection, {
        projectIds: ["project-c" as ProjectId],
      }),
    ).toHaveLength(2);
  });

  it("is empty for an item the list has not loaded, leaving the panel its own project", () => {
    expect(githubInboxSendTargets([], selection, { projectIds: [] })).toEqual([]);
  });
});

describe("resolveInboxItemReference", () => {
  const list = [issue(7, { repository: "acme/widgets" }), issue(8, { repository: "acme/gadgets" })];

  it("finds the loaded item a pasted GitHub issue link names", () => {
    expect(
      resolveInboxItemReference("https://github.com/acme/gadgets/issues/8?x=1", list)?.number,
    ).toBe(8);
  });

  it("ignores links to repositories that are not in the list", () => {
    expect(resolveInboxItemReference("https://github.com/other/repo/issues/7", list)).toBeNull();
  });

  it("resolves a #number only when exactly one item carries it", () => {
    expect(resolveInboxItemReference("#7", list)?.number).toBe(7);
    expect(
      resolveInboxItemReference("#7", [...list, issue(7, { repository: "acme/gadgets" })]),
    ).toBeNull();
    expect(resolveInboxItemReference("widgets", list)).toBeNull();
  });
});
