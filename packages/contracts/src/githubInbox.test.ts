import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { GitHubInboxItem, GitHubInboxListInput } from "./githubInbox";

const decodeItem = Schema.decodeUnknownSync(GitHubInboxItem);

const projectContext = { projectId: "project-1", projectTitle: "Project One", isPinned: false };

describe("GitHubInboxItem", () => {
  it("decodes an issue row", () => {
    const issue = decodeItem({
      kind: "issue",
      projectId: "project-1",
      projectTitle: "Project One",
      projectContexts: [projectContext],
      repository: "acme/widgets",
      number: 7,
      title: "Crash on start",
      url: "https://github.com/acme/widgets/issues/7",
      author: null,
      state: "closed",
      stateReason: "not-planned",
      labels: [{ name: "kind:bug", color: "d73a4a" }],
      assignees: [],
      commentCount: 2,
      createdAt: "2026-07-13T08:00:00.000Z",
      updatedAt: "2026-07-14T08:00:00.000Z",
      closedAt: "2026-07-14T08:00:00.000Z",
      isPinned: true,
      viewerInvolvement: { authored: false, assigned: false, involved: true },
    });
    expect(issue.kind).toBe("issue");
    expect(issue.kind === "issue" ? issue.stateReason : null).toBe("not-planned");
  });

  it("decodes a pull request row from a server that predates the inbox fields", () => {
    const pullRequest = decodeItem({
      kind: "pullRequest",
      projectId: "project-1",
      projectTitle: "Project One",
      repository: "acme/widgets",
      number: 42,
      title: "Prioritize this",
      url: "https://github.com/acme/widgets/pull/42",
      author: null,
      headBranch: "feature/pin",
      baseBranch: "main",
      state: "merged",
      isDraft: false,
      additions: 2,
      deletions: 1,
      createdAt: "2026-07-13T08:00:00.000Z",
      updatedAt: "2026-07-14T08:00:00.000Z",
      reviewDecision: null,
      viewerReviewRequested: false,
      labels: [],
    });
    expect(pullRequest).toMatchObject({ kind: "pullRequest", state: "merged", commentCount: 0 });
  });

  it("rejects an issue with a pull request state", () => {
    expect(() =>
      decodeItem({
        kind: "issue",
        projectId: "project-1",
        projectTitle: "Project One",
        projectContexts: [projectContext],
        repository: "acme/widgets",
        number: 7,
        title: "Crash on start",
        url: "https://github.com/acme/widgets/issues/7",
        author: null,
        state: "merged",
        stateReason: null,
        labels: [],
        assignees: [],
        commentCount: 0,
        createdAt: "2026-07-13T08:00:00.000Z",
        updatedAt: "2026-07-14T08:00:00.000Z",
        closedAt: null,
        isPinned: false,
        viewerInvolvement: { authored: false, assigned: false, involved: false },
      }),
    ).toThrow();
  });
});

describe("GitHubInboxListInput", () => {
  it("accepts only the open and closed lists", () => {
    const decode = Schema.decodeUnknownSync(GitHubInboxListInput);
    expect(decode({ state: "closed", forceRefresh: true })).toEqual({
      state: "closed",
      forceRefresh: true,
    });
    expect(() => decode({ state: "merged" })).toThrow();
    expect(decode({ state: "open", sort: "created" })).toEqual({ state: "open", sort: "created" });
    expect(() => decode({ state: "open", sort: "invalid" })).toThrow();
  });
});
