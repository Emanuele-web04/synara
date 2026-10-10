import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  PullRequestActor,
  PullRequestCommit,
  PullRequestCommitAuthor,
  PullRequestCommentInput,
  PullRequestActionResult,
  PullRequestDetail,
  PullRequestListEntry,
  PullRequestsUnavailableError,
} from "./pullRequests";

const decodeListEntry = Schema.decodeUnknownSync(PullRequestListEntry);
const decodeDetail = Schema.decodeUnknownSync(PullRequestDetail);
const decodeCommentInput = Schema.decodeUnknownSync(PullRequestCommentInput);
const decodeActionResult = Schema.decodeUnknownSync(PullRequestActionResult);

describe("PullRequestCommitAuthor", () => {
  const decodeAuthor = Schema.decodeUnknownSync(PullRequestCommitAuthor);
  const localAuthor = {
    login: null,
    name: "Local author",
    avatarUrl: null,
    url: null,
  };

  it("preserves name-only authors through the commit wire contract", () => {
    const commit = Schema.decodeUnknownSync(PullRequestCommit)({
      oid: "abc123",
      messageHeadline: "Keep local author",
      messageBody: "",
      committedDate: "2026-09-08T13:18:37Z",
      authors: [localAuthor],
    });
    expect(commit.authors).toEqual([localAuthor]);
    expect(() => Schema.decodeUnknownSync(PullRequestActor)(localAuthor)).toThrow();
  });

  it.each(["", "   ", 123])("rejects invalid login %j", (login) => {
    expect(() => decodeAuthor({ ...localAuthor, login })).toThrow();
  });

  it("rejects non-string names", () => {
    expect(() => decodeAuthor({ ...localAuthor, name: 123 })).toThrow();
  });
});

function listEntry() {
  return {
    projectId: "project-1",
    projectTitle: "Project One",
    repository: "acme/widgets",
    number: 42,
    title: "Prioritize this",
    url: "https://github.com/acme/widgets/pull/42",
    author: null,
    headBranch: "feature/pin",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    additions: 2,
    deletions: 1,
    createdAt: "2026-07-13T08:00:00.000Z",
    updatedAt: "2026-07-14T08:00:00.000Z",
    reviewDecision: null,
    viewerReviewRequested: false,
    labels: [],
  };
}

describe("PullRequestListEntry", () => {
  it("defaults legacy payloads missing pin and mergeability metadata", () => {
    // what an older server sends
    const decoded = decodeListEntry(listEntry());
    expect(decoded.isPinned).toBe(false);
    expect(decoded.projectContexts).toEqual([]);
    expect(decoded.mergeability).toBe("unknown");
    expect(decoded.stack).toBeNull();
    expect(decoded.commentCount).toBe(0);
    expect(decoded.assignees).toEqual([]);
    expect(decoded.viewerInvolvement).toEqual({
      authored: false,
      assigned: false,
      involved: false,
    });
    expect(
      decodeListEntry({ ...listEntry(), isPinned: true, mergeability: "conflicting" }),
    ).toMatchObject({ isPinned: true, mergeability: "conflicting" });
  });
});

describe("PullRequestDetail", () => {
  it("defaults mergeability for a real pre-field detail payload", () => {
    const decoded = decodeDetail({
      projectId: "project-1",
      projectTitle: "Project One",
      workspaceRoot: "/workspace/project-one",
      repository: "acme/widgets",
      number: 42,
      title: "Prioritize this",
      body: "Description",
      url: "https://github.com/acme/widgets/pull/42",
      author: null,
      state: "open",
      isDraft: false,
      mergeable: null,
      mergeStateStatus: null,
      reviewDecision: null,
      additions: 2,
      deletions: 1,
      changedFiles: 1,
      headBranch: "feature/pin",
      baseBranch: "main",
      createdAt: "2026-07-13T08:00:00.000Z",
      updatedAt: "2026-07-14T08:00:00.000Z",
      mergedAt: null,
      closedAt: null,
      maintainerCanModify: true,
      reviewers: [],
      labels: [],
      checks: [],
      comments: [],
      commentsTruncated: false,
      commentsIncomplete: false,
      commits: [],
      mergeCapabilities: {
        merge: true,
        squash: true,
        rebase: true,
        deleteBranchOnMerge: false,
      },
    });

    expect(decoded.mergeability).toBe("unknown");
    expect(decoded.stack).toBeNull();
    expect(decoded.stackMetadataIncomplete).toBe(false);
    expect(
      decodeDetail({ ...decoded, stackMetadataIncomplete: true }).stackMetadataIncomplete,
    ).toBe(true);
  });
});

describe("PullRequestActionResult", () => {
  it("defaults old mutation acknowledgements to no merge outcome", () => {
    expect(
      decodeActionResult({
        projectId: "project-1",
        repository: "acme/widgets",
        number: 42,
        workspaceRoot: "/workspace/project-one",
      }).mergeOutcome,
    ).toBeNull();
  });
});

describe("PullRequestCommentInput", () => {
  const base = {
    projectId: "project-1",
    repository: "acme/widgets",
    number: 42,
  } as const;

  it("accepts GitHub's maximum comment length and rejects one character more", () => {
    expect(decodeCommentInput({ ...base, body: "x".repeat(65_536) }).body).toHaveLength(65_536);
    expect(() => decodeCommentInput({ ...base, body: "x".repeat(65_537) })).toThrow();
  });
});

describe("PullRequestsUnavailableError", () => {
  it("carries a retry time only for the rate-limited reason", () => {
    const decode = Schema.decodeUnknownSync(PullRequestsUnavailableError);
    expect(
      decode({
        _tag: "PullRequestsUnavailableError",
        reason: "rate-limited",
        message: "GitHub rate limit reached.",
        retryAt: "2026-07-15T01:00:00.000Z",
      }).retryAt,
    ).toBe("2026-07-15T01:00:00.000Z");
    expect(
      decode({
        _tag: "PullRequestsUnavailableError",
        reason: "gh-not-authenticated",
        message: "Sign in.",
      }).retryAt,
    ).toBeUndefined();
  });
});
