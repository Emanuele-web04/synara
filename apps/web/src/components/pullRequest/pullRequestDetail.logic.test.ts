import { describe, expect, it } from "vitest";

import type { PullRequestComment, PullRequestCommit } from "@synara/contracts";

import type { RightDockPane } from "~/rightDockStore.logic";

import {
  buildPullRequestTimelineEvents,
  pullRequestDetailInputFromPane,
  stripHtmlComments,
  describePullRequestChecksBrief,
  describePullRequestMergeStatus,
} from "./pullRequestDetail.logic";

function makeCommit(overrides: Partial<PullRequestCommit> = {}): PullRequestCommit {
  return {
    oid: "abcdef1234567890",
    messageHeadline: "Fix the widget",
    messageBody: "",
    committedDate: "2026-07-02T10:00:00Z",
    authors: [],
    ...overrides,
  };
}

function makeComment(overrides: Partial<PullRequestComment> = {}): PullRequestComment {
  return {
    id: "comment-1",
    kind: "issue-comment",
    author: { login: "reviewer", name: null, avatarUrl: null, url: null },
    body: "Looks good",
    createdAt: "2026-07-03T10:00:00Z",
    updatedAt: null,
    url: null,
    path: null,
    reviewState: null,
    ...overrides,
  };
}

function makeTimelineSource() {
  return {
    createdAt: "2026-07-01T10:00:00Z",
    author: { login: "author", name: null, avatarUrl: null, url: null },
    commits: [makeCommit()],
    comments: [makeComment()],
    mergedAt: null,
    closedAt: null,
  };
}

describe("buildPullRequestTimelineEvents", () => {
  it("orders created, commit, and comment events chronologically", () => {
    const events = buildPullRequestTimelineEvents(makeTimelineSource());
    expect(events.map((event) => event.id)).toEqual(["created", "abcdef1234567890", "comment-1"]);
  });

  it("surfaces preserved commit author names in the timeline", () => {
    const events = buildPullRequestTimelineEvents({
      ...makeTimelineSource(),
      commits: [
        makeCommit({
          authors: [{ login: null, name: "Local author", avatarUrl: null, url: null }],
        }),
      ],
    });
    expect(events.find((event) => event.id === "abcdef1234567890")?.title).toBe(
      "Commit abcdef1 by Local author",
    );
  });

  it("falls back to placeholders for missing authors and empty commit messages", () => {
    const events = buildPullRequestTimelineEvents({
      ...makeTimelineSource(),
      author: null,
      commits: [makeCommit({ messageHeadline: "" })],
      comments: [makeComment({ author: null })],
    });
    expect(events[0]?.title).toBe("Someone opened this pull request");
    expect(events[1]?.body).toBe("No commit message.");
    expect(events[2]?.title).toBe("Someone commented");
  });

  it("names people as the list rows do: display name first, login as the fallback", () => {
    const events = buildPullRequestTimelineEvents({
      ...makeTimelineSource(),
      author: { login: "octo", name: "Octo Cat", avatarUrl: null, url: null },
    });
    expect(events[0]?.title).toBe("Octo Cat opened this pull request");
    expect(events[2]?.title).toBe("reviewer commented");
  });

  it("builds an issue's timeline: no commits, and the issue's own words", () => {
    const events = buildPullRequestTimelineEvents(
      {
        createdAt: "2026-07-01T10:00:00Z",
        author: { login: "author", name: null, avatarUrl: null, url: null },
        comments: [makeComment()],
        closedAt: "2026-07-05T10:00:00Z",
      },
      "issue",
    );
    expect(events.map((event) => event.title)).toEqual([
      "author opened this issue",
      "reviewer commented",
      "Issue closed",
    ]);
  });

  it("appends a merged event and suppresses the closed event when both timestamps exist", () => {
    const events = buildPullRequestTimelineEvents({
      ...makeTimelineSource(),
      mergedAt: "2026-07-04T10:00:00Z",
      closedAt: "2026-07-04T10:00:00Z",
    });
    const ids = events.map((event) => event.id);
    expect(ids).toContain("merged");
    expect(ids).not.toContain("closed");
    expect(events.at(-1)?.title).toBe("Pull request merged");
  });

  it("appends a closed event for a closed-but-unmerged pull request", () => {
    const events = buildPullRequestTimelineEvents({
      ...makeTimelineSource(),
      closedAt: "2026-07-04T10:00:00Z",
    });
    expect(events.at(-1)?.title).toBe("Pull request closed");
  });
});

describe("pullRequestDetailInputFromPane", () => {
  const basePane: RightDockPane = {
    id: "pane-1",
    kind: "pullRequest",
    threadId: null,
    diffTurnId: null,
    diffFilePath: null,
    filePath: null,
    pullRequestProjectId: "project-1" as RightDockPane["pullRequestProjectId"],
    pullRequestRepository: "acme/widgets",
    pullRequestNumber: 350,
    pullRequestInitialTab: null,
  };

  it("builds the detail input from a fully-populated pull request pane", () => {
    expect(pullRequestDetailInputFromPane(basePane)).toEqual({
      projectId: "project-1",
      repository: "acme/widgets",
      number: 350,
    });
  });

  it("returns null for empty pull request panes and other pane kinds", () => {
    expect(pullRequestDetailInputFromPane({ ...basePane, pullRequestNumber: null })).toBeNull();
    expect(pullRequestDetailInputFromPane({ ...basePane, kind: "diff" })).toBeNull();
  });
});

describe("stripHtmlComments", () => {
  it("removes multi-line comments anywhere in the body", () => {
    expect(stripHtmlComments("Before\n<!--\nline one\nline two\n-->\nAfter")).toBe(
      "Before\n\nAfter",
    );
  });

  it("keeps comments inside fenced code blocks", () => {
    const markdown = "Intro\n```html\n<!-- keep me -->\n```\n<!-- drop me -->";
    expect(stripHtmlComments(markdown)).toBe("Intro\n```html\n<!-- keep me -->\n```");
  });
});

describe("describePullRequestMergeStatus", () => {
  const open = { state: "open", isDraft: false, baseBranch: "main" } as const;
  it("names the merge state in words", () => {
    expect(describePullRequestMergeStatus({ ...open, mergeability: "mergeable" })).toEqual({
      tone: "success",
      label: "Can merge without conflicts",
    });
    expect(describePullRequestMergeStatus({ ...open, mergeability: "conflicting" }).label).toBe(
      "Conflicts with main",
    );
    expect(
      describePullRequestMergeStatus({
        ...open,
        isDraft: true,
        mergeability: "mergeable",
      }).label,
    ).toBe("Draft");
    expect(
      describePullRequestMergeStatus({
        ...open,
        state: "merged",
        mergeability: "unknown",
      }).label,
    ).toBe("Merged");
  });
});

describe("describePullRequestChecksBrief", () => {
  it("counts checks by outcome", () => {
    expect(describePullRequestChecksBrief([])).toEqual({
      tone: "none",
      label: "No checks",
    });
    expect(describePullRequestChecksBrief([{ status: "success" }, { status: "success" }])).toEqual({
      tone: "success",
      label: "2 successful",
    });
    expect(
      describePullRequestChecksBrief([
        { status: "failure" },
        { status: "pending" },
        { status: "success" },
      ]),
    ).toEqual({ tone: "failure", label: "1 failing, 1 pending, 1 successful" });
  });
});
