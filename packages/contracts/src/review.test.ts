import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  ReviewChangesetResult,
  ReviewPullRequestHeader,
  ReviewPullRequestSurfaceInput,
  ReviewPullRequestSurfaceResult,
  ReviewListPullRequestsInput,
  ReviewListPullRequestsResult,
} from "./review";

const decodeChangeset = Schema.decodeUnknownEffect(ReviewChangesetResult);
const decodeHeader = Schema.decodeUnknownEffect(ReviewPullRequestHeader);
const decodeSurfaceInput = Schema.decodeUnknownEffect(ReviewPullRequestSurfaceInput);
const decodeSurfaceResult = Schema.decodeUnknownEffect(ReviewPullRequestSurfaceResult);
const decodeListInput = Schema.decodeUnknownEffect(ReviewListPullRequestsInput);
const decodeListResult = Schema.decodeUnknownEffect(ReviewListPullRequestsResult);

it.effect("accepts legacy changeset payloads without patch signatures", () =>
  Effect.gen(function* () {
    const changeset = yield* decodeChangeset({
      target: {
        _tag: "pullRequest",
        repositoryId: "repo",
        number: 42,
      },
      patch: "diff --git a/a.ts b/a.ts\n",
      files: [],
    });

    assert.equal(changeset.patch, "diff --git a/a.ts b/a.ts\n");
    assert.equal(changeset.patchSignature, undefined);
  }),
);

it.effect("accepts review list server-side filter fields", () =>
  Effect.gen(function* () {
    const input = yield* decodeListInput({
      cwd: "/repo",
      state: "merged",
      limit: 25,
      search: "review board",
      author: "alice",
      authors: ["alice", "bob"],
      reviewRequested: "tyler",
      baseBranch: "main",
      baseBranches: ["main", "release"],
      headBranch: "feature/review-board",
      headBranches: ["feature/review-board", "octocat:feature/review-board"],
      label: "bug",
      labels: ["bug", "feature"],
      assignee: "alice",
      assignees: ["alice", "bob"],
      draft: true,
      columns: ["needs-review", "approved"],
      checks: ["passing", "pending"],
    });

    assert.deepEqual(input, {
      cwd: "/repo",
      state: "merged",
      limit: 25,
      search: "review board",
      author: "alice",
      authors: ["alice", "bob"],
      reviewRequested: "tyler",
      baseBranch: "main",
      baseBranches: ["main", "release"],
      headBranch: "feature/review-board",
      headBranches: ["feature/review-board", "octocat:feature/review-board"],
      label: "bug",
      labels: ["bug", "feature"],
      assignee: "alice",
      assignees: ["alice", "bob"],
      draft: true,
      columns: ["needs-review", "approved"],
      checks: ["passing", "pending"],
    });
  }),
);

it.effect("accepts lightweight pull request headers without heavy overview fields", () =>
  Effect.gen(function* () {
    const header = yield* decodeHeader({
      detail: {
        number: 42,
        title: "Fast PR header",
        url: "https://github.com/acme/demo/pull/42",
        state: "open",
        isDraft: false,
        author: "alice",
        baseBranch: "main",
        headBranch: "feature/review-loading",
        body: "Body",
        createdAt: "2026-06-16T12:00:00Z",
        updatedAt: "2026-06-16T12:00:00Z",
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        reviewDecision: null,
        mergeable: "MERGEABLE",
        milestone: null,
        labels: [],
        assignees: [],
      },
    });

    assert.equal(header.detail.commitsCount, undefined);
    assert.equal(header.detail.checksStatus, undefined);
    assert.equal(header.detail.reviewers, undefined);
  }),
);

it.effect("accepts aggregate pull request surface payloads with optional pieces", () =>
  Effect.gen(function* () {
    const input = yield* decodeSurfaceInput({
      cwd: "/repo",
      reference: "42",
      source: { _tag: "pullRequest", reference: "42" },
      includeConversation: true,
      includeChangeset: true,
    });
    const result = yield* decodeSurfaceResult({
      overview: {
        detail: {
          number: 42,
          title: "Review loading",
          url: "https://github.com/acme/demo/pull/42",
          state: "open",
          isDraft: false,
          author: "alice",
          baseBranch: "main",
          headBranch: "feature/review-loading",
          body: "Body",
          createdAt: "2026-06-16T12:00:00Z",
          updatedAt: "2026-06-16T12:00:00Z",
          additions: 1,
          deletions: 0,
          changedFiles: 1,
          commitsCount: 1,
          reviewDecision: null,
          mergeable: "MERGEABLE",
          checksStatus: "passing",
          milestone: null,
          labels: [],
          assignees: [],
          reviewers: [],
        },
        commits: [],
        checks: [],
      },
      conversation: { events: [] },
      changeset: {
        target: { _tag: "pullRequest", repositoryId: "repo", number: 42 },
        patch: "diff --git a/a.ts b/a.ts\n",
        files: [],
      },
    });

    assert.deepEqual(input, {
      cwd: "/repo",
      reference: "42",
      source: { _tag: "pullRequest", reference: "42" },
      includeConversation: true,
      includeChangeset: true,
    });
    assert.equal(result.overview.detail.number, 42);
    assert.deepEqual(result.conversation, { events: [] });
    assert.equal(result.changeset?.patch, "diff --git a/a.ts b/a.ts\n");
  }),
);

it.effect("accepts review list completeness metadata", () =>
  Effect.gen(function* () {
    const result = yield* decodeListResult({
      pullRequests: [
        {
          number: 42,
          title: "Forked review",
          url: "https://github.com/acme/demo/pull/42",
          baseBranch: "main",
          headBranch: "feature/review-board",
          headSelector: "octocat:feature/review-board",
          author: "alice",
          updatedAt: "2026-06-16T12:00:00Z",
          state: "open",
          reviewDecision: null,
          isDraft: false,
          additions: 1,
          deletions: 0,
          checksStatus: "pending",
          reviewRequests: [],
          labels: ["bug"],
          assignees: ["alice"],
        },
      ],
      meta: {
        resultLimit: 50,
        candidateLimit: 1000,
        candidateCount: 1000,
        candidateLimitReached: true,
        matchedCount: 86,
        returnedCount: 50,
        bounded: true,
      },
    });

    assert.deepEqual(result, {
      pullRequests: [
        {
          number: 42,
          title: "Forked review",
          url: "https://github.com/acme/demo/pull/42",
          baseBranch: "main",
          headBranch: "feature/review-board",
          headSelector: "octocat:feature/review-board",
          author: "alice",
          updatedAt: "2026-06-16T12:00:00Z",
          state: "open",
          reviewDecision: null,
          isDraft: false,
          additions: 1,
          deletions: 0,
          checksStatus: "pending",
          reviewRequests: [],
          labels: ["bug"],
          assignees: ["alice"],
        },
      ],
      meta: {
        resultLimit: 50,
        candidateLimit: 1000,
        candidateCount: 1000,
        candidateLimitReached: true,
        matchedCount: 86,
        returnedCount: 50,
        bounded: true,
      },
    });
  }),
);

it.effect("accepts legacy review list results without metadata", () =>
  Effect.gen(function* () {
    const result = yield* decodeListResult({
      pullRequests: [
        {
          number: 43,
          title: "Legacy review",
          url: "https://github.com/acme/demo/pull/43",
          baseBranch: "main",
          headBranch: "feature/legacy",
          author: "alice",
          updatedAt: "2026-06-16T12:00:00Z",
          state: "open",
          reviewDecision: null,
          isDraft: false,
          additions: 1,
          deletions: 0,
          checksStatus: "pending",
          reviewRequests: [],
        },
      ],
    });

    assert.deepEqual(result, {
      pullRequests: [
        {
          number: 43,
          title: "Legacy review",
          url: "https://github.com/acme/demo/pull/43",
          baseBranch: "main",
          headBranch: "feature/legacy",
          author: "alice",
          updatedAt: "2026-06-16T12:00:00Z",
          state: "open",
          reviewDecision: null,
          isDraft: false,
          additions: 1,
          deletions: 0,
          checksStatus: "pending",
          reviewRequests: [],
          labels: [],
          assignees: [],
        },
      ],
    });
  }),
);
