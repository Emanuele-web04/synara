import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  ReviewChangesetResult,
  ReviewListPullRequestsInput,
  ReviewListPullRequestsResult,
} from "./review";

const decodeChangeset = Schema.decodeUnknownEffect(ReviewChangesetResult);
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
      reviewRequested: "tyler",
      baseBranch: "main",
      headBranch: "feature/review-board",
      label: "bug",
      labels: ["bug", "feature"],
      assignee: "alice",
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
      reviewRequested: "tyler",
      baseBranch: "main",
      headBranch: "feature/review-board",
      label: "bug",
      labels: ["bug", "feature"],
      assignee: "alice",
      draft: true,
      columns: ["needs-review", "approved"],
      checks: ["passing", "pending"],
    });
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
