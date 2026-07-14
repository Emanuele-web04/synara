import { describe, expect, it } from "vitest";

import type { PullRequestActor, PullRequestListEntry } from "@synara/contracts";

import {
  countUniqueViewerReviewRequests,
  groupPullRequestEntriesByInvolvement,
  pullRequestListEntryKey,
} from "./pullRequestList.logic";

function makeActor(login: string): PullRequestActor {
  return { login, name: null, avatarUrl: null, url: null };
}

function makeEntry(overrides: Partial<PullRequestListEntry> = {}): PullRequestListEntry {
  return {
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
    labels: [],
    ...overrides,
  };
}

describe("groupPullRequestEntriesByInvolvement", () => {
  it("buckets self-authored entries into Authored regardless of review-request state", () => {
    const entry = makeEntry({ author: makeActor("viewer"), viewerReviewRequested: true });
    const groups = groupPullRequestEntriesByInvolvement([entry], "viewer");
    expect(groups).toEqual([{ key: "authored", label: "Authored", entries: [entry] }]);
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
});

describe("pull request list identity", () => {
  it("keeps rows from projects sharing one repository distinct", () => {
    const first = makeEntry();
    const second = makeEntry({
      projectId: "project-2" as PullRequestListEntry["projectId"],
      projectTitle: "Project Two",
    });
    expect(pullRequestListEntryKey(first)).not.toBe(pullRequestListEntryKey(second));
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
