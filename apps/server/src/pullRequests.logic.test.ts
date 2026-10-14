import { describe, expect, it } from "vitest";

import {
  isPullRequestMergeMethodAllowed,
  isValidGitHubRepositoryNameWithOwner,
  isViewerReviewRequested,
  orderPullRequestListEntries,
  projectPullRequestIdentityKey,
  repositoryPullRequestIdentityKey,
  selectRecoverablePullRequestPins,
} from "./pullRequests.logic";

import type { PullRequestListEntry } from "@synara/contracts";

function makeEntry(overrides: Partial<PullRequestListEntry> = {}): PullRequestListEntry {
  return {
    projectId: "project-1" as PullRequestListEntry["projectId"],
    projectTitle: "Project One",
    repository: "acme/widgets",
    number: 1,
    title: "Untitled",
    url: "https://github.com/acme/widgets/pull/1",
    author: null,
    headBranch: "feature",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    additions: 0,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    reviewDecision: null,
    viewerReviewRequested: false,
    isPinned: false,
    projectContexts: [
      {
        projectId: "project-1" as PullRequestListEntry["projectId"],
        projectTitle: "Project One",
        isPinned: false,
      },
    ],
    mergeability: "unknown",
    stack: null,
    labels: [],
    ...overrides,
  };
}

describe("isValidGitHubRepositoryNameWithOwner", () => {
  it.each(["owner/--flag value"])("rejects %s", (repository) =>
    expect(isValidGitHubRepositoryNameWithOwner(repository)).toBe(false),
  );
});

describe("project pull request priority", () => {
  it("keeps identical repository PRs independent across projects and repository casing", () => {
    const first = projectPullRequestIdentityKey({
      projectId: "project-1",
      repository: " Acme/Widgets ",
      number: 42,
    });
    expect(first).toBe(
      projectPullRequestIdentityKey({
        projectId: "project-1",
        repository: "acme/widgets",
        number: 42,
      }),
    );
    expect(first).not.toBe(
      projectPullRequestIdentityKey({
        projectId: "project-2",
        repository: "acme/widgets",
        number: 42,
      }),
    );
  });

  it("recovers only missing pins from truncated batches owned by the same project", () => {
    const pins = [
      { projectId: "project-a", repositoryKey: "acme/widgets", number: 1 },
      { projectId: "project-b", repositoryKey: "acme/widgets", number: 2 },
      { projectId: "project-a", repositoryKey: "acme/complete", number: 3 },
      { projectId: "project-a", repositoryKey: "acme/widgets", number: 4 },
    ];
    const presentKeys = new Set([
      projectPullRequestIdentityKey({
        projectId: "project-a",
        repository: "acme/widgets",
        number: 4,
      }),
    ]);
    const recovered = selectRecoverablePullRequestPins({
      pins,
      presentKeys,
      repositoryKeysByProject: new Map([
        ["project-a", new Set(["acme/widgets", "acme/complete"])],
        ["project-b", new Set(["acme/other"])],
      ]),
      batches: [
        {
          repository: "Acme/Widgets",
          truncated: true,
          projectIds: ["project-a"],
        },
        {
          repository: "acme/complete",
          truncated: false,
          projectIds: ["project-a"],
        },
      ],
    });

    expect(recovered).toEqual([pins[0]]);
  });

  it("coalesces remote lookups across projects without coalescing different repositories", () => {
    expect(repositoryPullRequestIdentityKey({ repository: " Acme/Widgets ", number: 42 })).toBe(
      repositoryPullRequestIdentityKey({ repository: "acme/widgets", number: 42 }),
    );
    expect(repositoryPullRequestIdentityKey({ repository: "acme/widgets", number: 42 })).not.toBe(
      repositoryPullRequestIdentityKey({ repository: "acme/other", number: 42 }),
    );
  });

  it("places pinned pull requests first while keeping newest-first order in each section", () => {
    const olderPinned = makeEntry({ number: 1, isPinned: true });
    const newerPinned = makeEntry({
      number: 2,
      isPinned: true,
      updatedAt: "2026-07-04T00:00:00.000Z",
    });
    const newestUnpinned = makeEntry({
      number: 3,
      updatedAt: "2026-07-05T00:00:00.000Z",
    });
    const olderUnpinned = makeEntry({ number: 4 });

    expect(
      orderPullRequestListEntries([olderUnpinned, olderPinned, newestUnpinned, newerPinned]).map(
        (entry) => entry.number,
      ),
    ).toEqual([2, 1, 3, 4]);
  });
});

describe("isViewerReviewRequested", () => {
  const viewer = { login: "Viewer", name: null, avatarUrl: null, url: null };

  it("does not flag a self-authored pull request", () => {
    expect(isViewerReviewRequested(viewer, ["viewer"], "VIEWER")).toBe(false);
  });
});

describe("review-requested flag", () => {
  const viewer = { login: "Viewer", name: null, avatarUrl: null, url: null };
  const teammate = { login: "teammate", name: null, avatarUrl: null, url: null };

  it("accepts an explicit user request or GitHub's team-aware search match", () => {
    expect(isViewerReviewRequested(teammate, ["VIEWER"], "viewer")).toBe(true);
    expect(isViewerReviewRequested(teammate, [], "viewer", true)).toBe(true);
    expect(isViewerReviewRequested(teammate, [], "viewer")).toBe(false);
  });

  it("never flags the viewer's own pull request, even when the search matched", () => {
    expect(isViewerReviewRequested(viewer, [], "viewer", true)).toBe(false);
  });
});

describe("isPullRequestMergeMethodAllowed", () => {
  const capabilities = {
    merge: false,
    squash: true,
    rebase: false,
    deleteBranchOnMerge: true,
  };

  it("uses repository capabilities for the requested method", () => {
    expect(isPullRequestMergeMethodAllowed(capabilities, "squash")).toBe(true);
    expect(isPullRequestMergeMethodAllowed(capabilities, "merge")).toBe(false);
  });
});
