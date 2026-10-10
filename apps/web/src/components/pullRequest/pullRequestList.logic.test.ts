import { describe, expect, it } from "vitest";

import type {
  GitHubInboxItem,
  ProjectId,
  PullRequestActor,
  PullRequestListEntry,
} from "@synara/contracts";

import {
  filterInboxItemsByInvolvement,
  groupPullRequestEntriesByInvolvement,
  inboxItemViewerRelation,
  matchesPullRequestSearchQuery,
  orderPullRequestEntriesPinnedFirst,
  pullRequestListEntryKey,
  pullRequestPinToggleInputs,
  safeGitHubLabelColor,
  scopeInboxItemsToProjects,
} from "./pullRequestList.logic";

function makeActor(login: string): PullRequestActor {
  return { login, name: null, avatarUrl: null, url: null };
}

function makeEntry(overrides: Partial<PullRequestListEntry> = {}): PullRequestListEntry {
  const entry: PullRequestListEntry = {
    projectId: "project-1" as PullRequestListEntry["projectId"],
    projectTitle: "Project One",
    repository: "acme/widgets",
    number: 1,
    title: "Untitled",
    url: "https://github.com/acme/widgets/pull/1",
    author: makeActor("someone"),
    headBranch: "feature",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    additions: 1,
    deletions: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    reviewDecision: null,
    viewerReviewRequested: false,
    isPinned: false,
    projectContexts: [],
    mergeability: "unknown",
    stack: null,
    labels: [],
    ...overrides,
  };
  return {
    ...entry,
    projectContexts: overrides.projectContexts ?? [
      {
        projectId: entry.projectId,
        projectTitle: entry.projectTitle,
        isPinned: entry.isPinned ?? false,
      },
    ],
  };
}

function makeIssue(
  overrides: Partial<Extract<GitHubInboxItem, { kind: "issue" }>> = {},
): GitHubInboxItem {
  const projectId = overrides.projectId ?? ("project-1" as ProjectId);
  return {
    kind: "issue",
    projectId,
    projectTitle: "Project One",
    projectContexts: [{ projectId, projectTitle: "Project One", isPinned: false }],
    repository: "acme/widgets",
    number: 7,
    title: "An issue",
    url: "https://github.com/acme/widgets/issues/7",
    author: null,
    state: "open",
    stateReason: null,
    labels: [],
    assignees: [],
    commentCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    isPinned: false,
    viewerInvolvement: { authored: false, assigned: false, involved: false },
    ...overrides,
  };
}

function asPullRequestItem(entry: PullRequestListEntry): GitHubInboxItem {
  return { kind: "pullRequest", ...entry };
}

describe("groupPullRequestEntriesByInvolvement", () => {
  it("places pinned entries in one leading group without duplicating their involvement", () => {
    const pinned = makeEntry({
      isPinned: true,
      author: makeActor("viewer"),
      viewerReviewRequested: true,
    });
    const reviewing = makeEntry({ number: 2, viewerReviewRequested: true });
    const groups = groupPullRequestEntriesByInvolvement([reviewing, pinned], "viewer");

    expect(groups.map((group) => group.key)).toEqual(["pinned", "reviewRequested"]);
    expect(groups.flatMap((group) => group.entries)).toEqual([pinned, reviewing]);
  });

  it("buckets self-authored entries into Authored regardless of review-request state", () => {
    const entry = makeEntry({
      author: makeActor("viewer"),
      viewerReviewRequested: true,
    });
    const groups = groupPullRequestEntriesByInvolvement([entry], "viewer");
    expect(groups).toEqual([{ key: "authored", label: "Authored by me", entries: [entry] }]);
  });

  it("buckets entries with an active review request into Review requested", () => {
    const entry = makeEntry({
      author: makeActor("teammate"),
      viewerReviewRequested: true,
    });
    const groups = groupPullRequestEntriesByInvolvement([entry], "viewer");
    expect(groups).toEqual([
      { key: "reviewRequested", label: "Needs my review", entries: [entry] },
    ]);
  });

  it("buckets every other entry into Others without inventing review history", () => {
    const entry = makeEntry({
      author: makeActor("teammate"),
      viewerReviewRequested: false,
    });
    const groups = groupPullRequestEntriesByInvolvement([entry], "viewer");
    expect(groups).toEqual([{ key: "others", label: "Everything else", entries: [entry] }]);
  });

  it("matches viewer logins case-insensitively", () => {
    const entry = makeEntry({ author: makeActor("Viewer") });
    const groups = groupPullRequestEntriesByInvolvement([entry], "viewer");
    expect(groups[0]?.key).toBe("authored");
  });

  it("orders groups authored, reviewRequested, others and omits empty buckets", () => {
    const reviewing = makeEntry({
      number: 1,
      author: makeActor("teammate"),
      viewerReviewRequested: true,
    });
    const other = makeEntry({
      number: 2,
      author: makeActor("someone-else"),
      viewerReviewRequested: false,
    });
    const authored = makeEntry({ number: 3, author: makeActor("viewer") });
    const groups = groupPullRequestEntriesByInvolvement([authored, other, reviewing], "viewer");
    expect(groups.map((group) => group.key)).toEqual(["authored", "reviewRequested", "others"]);
  });

  it("groups pull requests and issues together by how they involve the viewer", () => {
    const pinnedIssue = makeIssue({ number: 10, isPinned: true });
    const reviewing = asPullRequestItem(
      makeEntry({
        number: 11,
        author: makeActor("teammate"),
        viewerReviewRequested: true,
      }),
    );
    const assignedIssue = makeIssue({
      number: 12,
      author: makeActor("viewer"),
      viewerInvolvement: { authored: true, assigned: true, involved: true },
    });
    const authoredIssue = makeIssue({
      number: 13,
      viewerInvolvement: { authored: true, assigned: false, involved: true },
    });
    const mentionedIssue = makeIssue({
      number: 14,
      viewerInvolvement: { authored: false, assigned: false, involved: true },
    });
    const groups = groupPullRequestEntriesByInvolvement(
      [mentionedIssue, authoredIssue, assignedIssue, reviewing, pinnedIssue],
      "viewer",
    );
    expect(
      groups.map((group) => [group.label, group.entries.map((entry) => entry.number)]),
    ).toEqual([
      ["Pinned", [10]],
      ["Authored by me", [13, 12]],
      ["Needs my review", [11]],
      ["Involving me", [14]],
    ]);
  });

  it("uses the assignee list when the server sent no involvement flags", () => {
    const entry = makeEntry({ assignees: [makeActor("Viewer")] });
    expect(groupPullRequestEntriesByInvolvement([entry], "viewer")[0]?.key).toBe("involved");
  });

  it("falls back gracefully when the viewer login is unknown", () => {
    const entry = makeEntry({ author: makeActor("someone") });
    const groups = groupPullRequestEntriesByInvolvement([entry], null);
    expect(groups[0]?.key).toBe("others");
  });
});

describe("orderPullRequestEntriesPinnedFirst", () => {
  it("moves pins first without disturbing order inside either section", () => {
    const first = makeEntry({ number: 1 });
    const pinnedFirst = makeEntry({ number: 2, isPinned: true });
    const second = makeEntry({ number: 3 });
    const pinnedSecond = makeEntry({ number: 4, isPinned: true });

    expect(
      orderPullRequestEntriesPinnedFirst([first, pinnedFirst, second, pinnedSecond]).map(
        (entry) => entry.number,
      ),
    ).toEqual([2, 4, 1, 3]);
  });
});

describe("pull request list identity", () => {
  it("uses one stable row identity across projects sharing a repository", () => {
    const first = makeEntry();
    const second = makeEntry({
      projectId: "project-2" as PullRequestListEntry["projectId"],
      projectTitle: "Project Two",
    });
    expect(pullRequestListEntryKey(first)).toBe(pullRequestListEntryKey(second));
  });
});

describe("pullRequestPinToggleInputs", () => {
  it("clears every owning project from an aggregate pinned row", () => {
    const entry = makeEntry({
      isPinned: true,
      projectContexts: [
        {
          projectId: "project-1" as PullRequestListEntry["projectId"],
          projectTitle: "Project One",
          isPinned: true,
        },
        {
          projectId: "project-2" as PullRequestListEntry["projectId"],
          projectTitle: "Project Two",
          isPinned: true,
        },
      ],
    });

    expect(pullRequestPinToggleInputs(entry)).toEqual([
      {
        projectId: "project-1",
        repository: "acme/widgets",
        number: 1,
        isPinned: false,
      },
      {
        projectId: "project-2",
        repository: "acme/widgets",
        number: 1,
        isPinned: false,
      },
    ]);
  });

  it("keeps pin toggles to the projects in scope", () => {
    const projectA = "project-a" as ProjectId;
    const projectB = "project-b" as ProjectId;
    const shared = asPullRequestItem(
      makeEntry({
        projectId: projectA,
        isPinned: true,
        projectContexts: [
          { projectId: projectA, projectTitle: "A", isPinned: true },
          { projectId: projectB, projectTitle: "B", isPinned: false },
        ],
      }),
    );
    const [scoped] = scopeInboxItemsToProjects([shared], [projectB]);
    expect(scoped).toBeDefined();
    expect(pullRequestPinToggleInputs(scoped!)).toEqual([
      {
        projectId: projectB,
        repository: "acme/widgets",
        number: 1,
        isPinned: true,
      },
    ]);
  });
});

describe("filterInboxItemsByInvolvement", () => {
  const requested = asPullRequestItem(makeEntry({ number: 1, viewerReviewRequested: true }));
  const authored = asPullRequestItem(makeEntry({ number: 2, author: makeActor("Viewer") }));
  const assignedIssue = makeIssue({
    number: 3,
    assignees: [makeActor("viewer")],
  });
  const mentionedIssue = makeIssue({
    number: 4,
    viewerInvolvement: { authored: false, assigned: false, involved: true },
  });
  const unrelated = makeIssue({ number: 5 });
  const items = [requested, authored, assignedIssue, mentionedIssue, unrelated];
  const numbers = (involvement: Parameters<typeof filterInboxItemsByInvolvement>[2]) =>
    filterInboxItemsByInvolvement(items, "viewer", involvement).map((item) => item.number);

  it("keeps every row for Everything", () => {
    expect(numbers("everything")).toEqual([1, 2, 3, 4, 5]);
  });

  it("narrows to each relation, matching logins case-insensitively", () => {
    expect(numbers("reviewRequested")).toEqual([1]);
    expect(numbers("authored")).toEqual([2]);
    expect(numbers("assigned")).toEqual([3]);
    expect(numbers("involved")).toEqual([1, 2, 3, 4]);
  });

  it("returns no authored rows when the viewer login is unknown and no flag says so", () => {
    expect(filterInboxItemsByInvolvement(items, null, "authored")).toEqual([]);
  });

  it("never treats an issue as awaiting review", () => {
    expect(
      inboxItemViewerRelation({ ...makeIssue(), viewerReviewRequested: true }, "viewer")
        .reviewRequested,
    ).toBe(false);
  });
});

describe("matchesPullRequestSearchQuery", () => {
  it("matches title, repository, branch, and author case-insensitively", () => {
    const entry = makeEntry({
      title: "Fix Widget",
      repository: "acme/widgets",
      headBranch: "feat/widget-fix",
      author: makeActor("Reviewer"),
    });
    expect(matchesPullRequestSearchQuery(entry, "widget")).toBe(true);
    expect(matchesPullRequestSearchQuery(entry, "acme/")).toBe(true);
    expect(matchesPullRequestSearchQuery(entry, "feat/")).toBe(true);
    expect(matchesPullRequestSearchQuery(entry, "reviewer")).toBe(true);
    expect(matchesPullRequestSearchQuery(entry, "nomatch")).toBe(false);
  });

  it("matches issues by title, number, and label", () => {
    const issue = makeIssue({
      title: "Windows Defender flags the installer",
      labels: [{ name: "kind:bug", color: null }],
    });
    expect(matchesPullRequestSearchQuery(issue, "defender")).toBe(true);
    expect(matchesPullRequestSearchQuery(issue, "#7")).toBe(true);
    expect(matchesPullRequestSearchQuery(issue, "kind:bug")).toBe(true);
    expect(matchesPullRequestSearchQuery(issue, "feature")).toBe(false);
  });

  it("matches the pull request number with and without the leading hash", () => {
    const entry = makeEntry({ number: 350 });
    expect(matchesPullRequestSearchQuery(entry, "#350")).toBe(true);
    expect(matchesPullRequestSearchQuery(entry, "350")).toBe(true);
  });
});

describe("scopeInboxItemsToProjects", () => {
  const projectA = "project-a" as ProjectId;
  const projectB = "project-b" as ProjectId;
  const projectC = "project-c" as ProjectId;
  const shared = asPullRequestItem(
    makeEntry({
      number: 5,
      projectId: projectA,
      projectTitle: "A",
      isPinned: true,
      projectContexts: [
        { projectId: projectA, projectTitle: "A", isPinned: true },
        { projectId: projectB, projectTitle: "B", isPinned: false },
      ],
    }),
  );
  const issueInC = makeIssue({ number: 8, projectId: projectC });

  it("keeps every row when no project is selected", () => {
    expect(scopeInboxItemsToProjects([shared, issueInC], [])).toEqual([shared, issueInC]);
  });

  it("shows a shared row with the selected project's own pin", () => {
    const [scoped] = scopeInboxItemsToProjects([shared], [projectB]);

    expect(scoped).toMatchObject({
      projectId: projectB,
      projectTitle: "B",
      isPinned: false,
    });
    expect(scoped?.projectContexts).toEqual([
      { projectId: projectB, projectTitle: "B", isPinned: false },
    ]);
    expect(scopeInboxItemsToProjects([shared], [projectC])).toEqual([]);
  });

  it("keeps rows from any selected project, with only the selected contexts", () => {
    const scoped = scopeInboxItemsToProjects([shared, issueInC], [projectA, projectC]);
    expect(scoped.map((item) => item.number)).toEqual([5, 8]);
    expect(scoped[0]?.projectContexts?.map((context) => context.projectId)).toEqual([projectA]);
    expect(scoped[0]?.isPinned).toBe(true);
  });
});

describe("safeGitHubLabelColor", () => {
  it("passes only six-digit hex colors through", () => {
    expect(safeGitHubLabelColor("d73a4a")).toBe("#d73a4a");
    expect(safeGitHubLabelColor("red; background: url(x)")).toBeNull();
    expect(safeGitHubLabelColor("#d73a4a")).toBeNull();
    expect(safeGitHubLabelColor(null)).toBeNull();
  });
});
