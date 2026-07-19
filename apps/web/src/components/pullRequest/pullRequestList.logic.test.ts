import { describe, expect, it } from "vitest";

import {
  type OrchestrationWorktreeWorkspace,
  type PullRequestActor,
  type PullRequestListEntry,
  ProjectId,
  WorktreeWorkspaceId,
} from "@synara/contracts";

import {
  countUniqueViewerReviewRequests,
  filterPullRequestEntriesByInvolvement,
  groupPullRequestEntriesByInvolvement,
  matchesPullRequestSearchQuery,
  orderPullRequestEntriesPinnedFirst,
  pullRequestListEntryKey,
  pullRequestPinToggleInputs,
  pullRequestWorkspaceAssociation,
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
    const entry = makeEntry({ author: makeActor("viewer"), viewerReviewRequested: true });
    const groups = groupPullRequestEntriesByInvolvement([entry], "viewer");
    expect(groups).toEqual([{ key: "authored", label: "My PRs", entries: [entry] }]);
  });

  it("buckets entries with an active review request into Review requested", () => {
    const entry = makeEntry({ author: makeActor("teammate"), viewerReviewRequested: true });
    const groups = groupPullRequestEntriesByInvolvement([entry], "viewer");
    expect(groups).toEqual([
      { key: "reviewRequested", label: "Review requested", entries: [entry] },
    ]);
  });

  it("buckets every other entry into Others without inventing review history", () => {
    const entry = makeEntry({ author: makeActor("teammate"), viewerReviewRequested: false });
    const groups = groupPullRequestEntriesByInvolvement([entry], "viewer");
    expect(groups).toEqual([{ key: "others", label: "Others", entries: [entry] }]);
  });

  it("buckets ghost-authored entries into Others", () => {
    const entry = makeEntry({ author: null, viewerReviewRequested: false });
    const groups = groupPullRequestEntriesByInvolvement([entry], "viewer");
    expect(groups).toEqual([{ key: "others", label: "Others", entries: [entry] }]);
  });

  it("matches viewer logins case-insensitively", () => {
    const entry = makeEntry({ author: makeActor("Viewer") });
    const groups = groupPullRequestEntriesByInvolvement([entry], "viewer");
    expect(groups[0]?.key).toBe("authored");
  });

  it("orders groups reviewRequested, authored, others and omits empty buckets", () => {
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
    expect(groups.map((group) => group.key)).toEqual(["reviewRequested", "authored", "others"]);
  });

  it("returns no groups for an empty entry list", () => {
    expect(groupPullRequestEntriesByInvolvement([], "viewer")).toEqual([]);
  });

  it("falls back gracefully when the viewer login is unknown", () => {
    const entry = makeEntry({ author: makeActor("someone") });
    const groups = groupPullRequestEntriesByInvolvement([entry], null);
    expect(groups[0]?.key).toBe("others");
  });

  it("uses account-scoped authorship when the aggregate viewer is unknown", () => {
    const authored = makeEntry({ viewerAuthored: true, author: makeActor("alice") });
    const other = makeEntry({ number: 2, viewerAuthored: false, author: makeActor("bob") });
    const groups = groupPullRequestEntriesByInvolvement([authored, other], null);
    expect(groups.map((group) => group.key)).toEqual(["authored", "others"]);
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

  it("counts one review request once across shared-project rows", () => {
    const first = makeEntry({ viewerReviewRequested: true });
    const duplicate = makeEntry({
      projectId: "project-2" as PullRequestListEntry["projectId"],
      viewerReviewRequested: true,
    });
    const other = makeEntry({ number: 2, viewerReviewRequested: true });
    expect(countUniqueViewerReviewRequests([first, duplicate, other])).toBe(2);
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

    expect(pullRequestPinToggleInputs(entry, true)).toEqual([
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

  it("keeps project-scoped pin toggles local", () => {
    const entry = makeEntry({ isPinned: true });
    expect(pullRequestPinToggleInputs(entry, false)).toEqual([
      {
        projectId: entry.projectId,
        repository: entry.repository,
        number: entry.number,
        isPinned: false,
      },
    ]);
  });

  it("pins every associated project from an aggregate unpinned row", () => {
    const entry = makeEntry({
      projectContexts: [
        {
          projectId: "project-1" as PullRequestListEntry["projectId"],
          projectTitle: "Project One",
          isPinned: false,
        },
        {
          projectId: "project-2" as PullRequestListEntry["projectId"],
          projectTitle: "Project Two",
          isPinned: false,
        },
      ],
    });
    expect(pullRequestPinToggleInputs(entry, true)).toEqual([
      {
        projectId: "project-1",
        repository: "acme/widgets",
        number: 1,
        isPinned: true,
      },
      {
        projectId: "project-2",
        repository: "acme/widgets",
        number: 1,
        isPinned: true,
      },
    ]);
  });
});

describe("filterPullRequestEntriesByInvolvement", () => {
  it("returns every entry for the all tab", () => {
    const entries = [makeEntry(), makeEntry({ number: 2 })];
    expect(filterPullRequestEntriesByInvolvement(entries, "viewer", "all")).toEqual(entries);
  });

  it("keeps only entries with an active review request for the reviewing tab", () => {
    const requested = makeEntry({ viewerReviewRequested: true });
    const other = makeEntry({ number: 2 });
    expect(
      filterPullRequestEntriesByInvolvement([requested, other], "viewer", "reviewing"),
    ).toEqual([requested]);
  });

  it("matches the viewer's authored entries case-insensitively", () => {
    const authored = makeEntry({ author: makeActor("Viewer") });
    const other = makeEntry({ number: 2, author: makeActor("teammate") });
    expect(filterPullRequestEntriesByInvolvement([authored, other], "viewer", "authored")).toEqual([
      authored,
    ]);
  });

  it("returns no authored entries when the viewer login is unknown", () => {
    const entry = makeEntry({ author: makeActor("someone") });
    expect(filterPullRequestEntriesByInvolvement([entry], null, "authored")).toEqual([]);
  });

  it("filters My PRs by account-scoped authorship when the aggregate viewer is null", () => {
    const authoredByFirstAccount = makeEntry({ viewerAuthored: true, author: makeActor("alice") });
    const authoredBySecondAccount = makeEntry({
      number: 2,
      viewerAuthored: true,
      author: makeActor("bob"),
    });
    const notAuthored = makeEntry({
      number: 3,
      viewerAuthored: false,
      author: makeActor("alice"),
    });

    expect(
      filterPullRequestEntriesByInvolvement(
        [authoredByFirstAccount, authoredBySecondAccount, notAuthored],
        null,
        "authored",
      ),
    ).toEqual([authoredByFirstAccount, authoredBySecondAccount]);
  });

  it("falls back to the aggregate viewer for entries from an older server", () => {
    const legacyEntry = makeEntry({ author: makeActor("Viewer"), viewerAuthored: undefined });
    expect(filterPullRequestEntriesByInvolvement([legacyEntry], "viewer", "authored")).toEqual([
      legacyEntry,
    ]);
  });
});

describe("matchesPullRequestSearchQuery", () => {
  it("matches every entry when the query is empty", () => {
    expect(matchesPullRequestSearchQuery(makeEntry(), "")).toBe(true);
  });

  it("matches title, repository, head/base branches, URL, and author case-insensitively", () => {
    const entry = makeEntry({
      title: "Fix Widget",
      repository: "acme/widgets",
      headBranch: "feat/widget-fix",
      baseBranch: "release/2026",
      author: makeActor("Reviewer"),
    });
    expect(matchesPullRequestSearchQuery(entry, "widget")).toBe(true);
    expect(matchesPullRequestSearchQuery(entry, "acme/")).toBe(true);
    expect(matchesPullRequestSearchQuery(entry, "feat/")).toBe(true);
    expect(matchesPullRequestSearchQuery(entry, "release/2026")).toBe(true);
    expect(matchesPullRequestSearchQuery(entry, "github.com/acme/widgets/pull/1")).toBe(true);
    expect(matchesPullRequestSearchQuery(entry, "reviewer")).toBe(true);
    expect(matchesPullRequestSearchQuery(entry, "nomatch")).toBe(false);
  });

  it("matches the pull request number with and without the leading hash", () => {
    const entry = makeEntry({ number: 350 });
    expect(matchesPullRequestSearchQuery(entry, "#350")).toBe(true);
    expect(matchesPullRequestSearchQuery(entry, "350")).toBe(true);
  });
});

describe("pullRequestWorkspaceAssociation", () => {
  const workspace: OrchestrationWorktreeWorkspace = {
    id: WorktreeWorkspaceId.makeUnsafe("workspace-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    repositoryIdentity: "github.com/acme/widgets",
    kind: "managed",
    state: "ready",
    title: "Widget fix",
    path: "/tmp/widget-fix",
    branch: "feature",
    headRef: "feature",
    targetRef: "main",
    targetResolvedCommit: null,
    createdFromCommit: null,
    sourceKind: "pull-request",
    sourceRef: "https://github.com/acme/widgets/pull/1",
    setupStatus: "succeeded",
    setupError: null,
    setupLogId: null,
    lastKnownPr: null,
    isPinned: false,
    lifecycleGeneration: 0,
    activeOperation: null,
    lastFailure: null,
    mutationRevision: 0,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
  };

  it("marks active and archived workspaces without excluding archived records", () => {
    expect(pullRequestWorkspaceAssociation(makeEntry(), [workspace])).toBe("active");
    expect(
      pullRequestWorkspaceAssociation(makeEntry(), [
        { ...workspace, archivedAt: "2026-07-16T01:00:00.000Z", state: "archived" },
      ]),
    ).toBe("archived");
  });

  it("does not associate another project or deleted workspace", () => {
    expect(
      pullRequestWorkspaceAssociation(makeEntry(), [
        { ...workspace, projectId: ProjectId.makeUnsafe("project-2") },
        {
          ...workspace,
          id: WorktreeWorkspaceId.makeUnsafe("workspace-2"),
          deletedAt: "2026-07-16T01:00:00.000Z",
        },
      ]),
    ).toBeNull();
  });
});
