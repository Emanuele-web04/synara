import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";

import type {
  ReviewInlineComment,
  ReviewSubmitInput,
  ReviewSubmitResult,
} from "@t3tools/contracts";

import { GitHubCliError } from "../../git/Errors.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import {
  GitHubCli,
  type GitHubCliShape,
  type GitHubCreateReviewResult,
  type GitHubReviewInlineComment,
} from "../../git/Services/GitHubCli.ts";
import { GitManager, type GitManagerShape } from "../../git/Services/GitManager.ts";
import { ReviewSubmission } from "../Services/ReviewSubmission.ts";
import { ReviewSubmissionLive } from "./ReviewSubmission.ts";

const PR_URL = "https://github.com/pingdotgg/codething-mvp/pull/101";
const PR_NUMBER = 101;
const PR_OWNER = "pingdotgg";
const PR_REPO = "codething-mvp";
const LIVE_HEAD_SHA = "abc1230000000000000000000000000000000000";

// Added line 3 (RIGHT) and removed line 2 (LEFT) are the only valid anchors.
const PR_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,5 +1,6 @@",
  " const a = 1;",
  "-const stale = 2;",
  "+const fresh = 2;",
  "+const added = 3;",
  " const b = 4;",
  " const c = 5;",
  " const d = 6;",
  "",
].join("\n");

interface Recorded {
  readonly resolvePullRequest: Array<{ cwd: string; reference: string }>;
  readonly getPullRequestHeadSha: Array<{ cwd: string; reference: string }>;
  readonly getPullRequestDiff: Array<{ cwd: string; reference: string }>;
  readonly submitPullRequestReview: Array<{
    cwd: string;
    reference: string;
    event: string;
    body?: string;
  }>;
  readonly createPullRequestReviewWithComments: Array<{
    cwd: string;
    owner: string;
    repo: string;
    number: number;
    event: string;
    commitId: string;
    body?: string;
    comments: ReadonlyArray<GitHubReviewInlineComment>;
  }>;
}

interface FakeOptions {
  readonly liveHeadSha?: string;
  readonly diff?: string;
  readonly headShaFails?: boolean;
  readonly diffFails?: boolean;
  readonly submitFails?: boolean;
  readonly withCommentsFails?: boolean;
  readonly createResult?: GitHubCreateReviewResult;
}

function unexpected(method: string): never {
  throw new Error(`Unexpected GitHubCli call: ${method}`);
}

function makeFakes(options: FakeOptions = {}): {
  layer: Layer.Layer<ReviewSubmission>;
  recorded: Recorded;
} {
  const recorded: Recorded = {
    resolvePullRequest: [],
    getPullRequestHeadSha: [],
    getPullRequestDiff: [],
    submitPullRequestReview: [],
    createPullRequestReviewWithComments: [],
  };

  const liveHeadSha = options.liveHeadSha ?? LIVE_HEAD_SHA;
  const diff = options.diff ?? PR_DIFF;

  const gitManager: GitManagerShape = {
    resolvePullRequest: (input) => {
      recorded.resolvePullRequest.push({ cwd: input.cwd, reference: input.reference });
      return Effect.succeed({
        pullRequest: {
          number: PR_NUMBER,
          title: "Pull request",
          url: PR_URL,
          baseBranch: "main",
          headBranch: "feature/pull-request",
          state: "open" as const,
        },
      });
    },
    status: () => unexpected("GitManager.status"),
    readWorkingTreeDiff: () => unexpected("GitManager.readWorkingTreeDiff"),
    summarizeDiff: () => unexpected("GitManager.summarizeDiff"),
    preparePullRequestThread: () => unexpected("GitManager.preparePullRequestThread"),
    handoffThread: () => unexpected("GitManager.handoffThread"),
    runStackedAction: () => unexpected("GitManager.runStackedAction"),
  };

  const gitHubCli: GitHubCliShape = {
    getReviewPullRequestOverview: () =>
      Effect.fail(
        new GitHubCliError({
          operation: "execute",
          detail: "getReviewPullRequestOverview not stubbed in test",
        }),
      ),
    getReviewPullRequestHeader: () =>
      Effect.fail(
        new GitHubCliError({
          operation: "execute",
          detail: "getReviewPullRequestHeader not stubbed in test",
        }),
      ),
    getReviewConversation: () =>
      Effect.fail(
        new GitHubCliError({
          operation: "execute",
          detail: "getReviewConversation not stubbed in test",
        }),
      ),
    getReviewTimeline: () =>
      Effect.fail(
        new GitHubCliError({
          operation: "execute",
          detail: "getReviewTimeline not stubbed in test",
        }),
      ),
    getPullRequestHeadSha: (input) => {
      recorded.getPullRequestHeadSha.push({ cwd: input.cwd, reference: input.reference });
      return options.headShaFails
        ? Effect.fail(new GitHubCliError({ operation: "getPullRequestHeadSha", detail: "boom" }))
        : Effect.succeed(liveHeadSha);
    },
    getPullRequestDiff: (input) => {
      recorded.getPullRequestDiff.push({ cwd: input.cwd, reference: input.reference });
      return options.diffFails
        ? Effect.fail(new GitHubCliError({ operation: "getPullRequestDiff", detail: "boom" }))
        : Effect.succeed(diff);
    },
    submitPullRequestReview: (input) => {
      recorded.submitPullRequestReview.push({
        cwd: input.cwd,
        reference: input.reference,
        event: input.event,
        ...(input.body !== undefined ? { body: input.body } : {}),
      });
      return options.submitFails
        ? Effect.fail(new GitHubCliError({ operation: "submitPullRequestReview", detail: "boom" }))
        : Effect.void;
    },
    createPullRequestReviewWithComments: (input) => {
      recorded.createPullRequestReviewWithComments.push({
        cwd: input.cwd,
        owner: input.owner,
        repo: input.repo,
        number: input.number,
        event: input.event,
        commitId: input.commitId,
        ...(input.body !== undefined ? { body: input.body } : {}),
        comments: input.comments,
      });
      return options.withCommentsFails
        ? Effect.fail(
            new GitHubCliError({
              operation: "createPullRequestReviewWithComments",
              detail: "boom",
            }),
          )
        : Effect.succeed(options.createResult ?? {});
    },
    execute: () => unexpected("GitHubCli.execute"),
    listOpenPullRequests: () => unexpected("GitHubCli.listOpenPullRequests"),
    getPullRequest: () => unexpected("GitHubCli.getPullRequest"),
    listRepositoryPullRequests: () => unexpected("GitHubCli.listRepositoryPullRequests"),
    getAuthenticatedUser: () => unexpected("GitHubCli.getAuthenticatedUser"),
    getPullRequestThreads: () => unexpected("GitHubCli.getPullRequestThreads"),
    setPullRequestThreadResolution: () => unexpected("GitHubCli.setPullRequestThreadResolution"),
    addPullRequestThreadReply: () => unexpected("GitHubCli.addPullRequestThreadReply"),
    updatePullRequestThreadComment: () => unexpected("GitHubCli.updatePullRequestThreadComment"),
    deletePullRequestThreadComment: () => unexpected("GitHubCli.deletePullRequestThreadComment"),
    getRepositoryCloneUrls: () => unexpected("GitHubCli.getRepositoryCloneUrls"),
    createPullRequest: () => unexpected("GitHubCli.createPullRequest"),
    getDefaultBranch: () => unexpected("GitHubCli.getDefaultBranch"),
    checkoutPullRequest: () => unexpected("GitHubCli.checkoutPullRequest"),
    projectScopeAvailable: () => unexpected("GitHubCli.projectScopeAvailable"),
    listProjects: () => unexpected("GitHubCli.listProjects"),
    getProjectBoard: () => unexpected("GitHubCli.getProjectBoard"),
    moveProjectCard: () => unexpected("GitHubCli.moveProjectCard"),
    getRepositoryOwner: () => unexpected("GitHubCli.getRepositoryOwner"),
  };

  const depsLayer = Layer.mergeAll(
    Layer.succeed(GitHubCli, gitHubCli),
    Layer.succeed(GitManager, gitManager),
    Layer.succeed(GitCore, {} as never),
  );

  return {
    layer: ReviewSubmissionLive.pipe(Layer.provide(depsLayer)),
    recorded,
  };
}

function submitInput(overrides: Partial<ReviewSubmitInput> = {}): ReviewSubmitInput {
  return {
    cwd: "/repo",
    reference: PR_URL,
    event: "comment",
    ...overrides,
  };
}

function comment(overrides: Partial<ReviewInlineComment> = {}): ReviewInlineComment {
  return {
    path: "src/app.ts",
    line: 3,
    side: "RIGHT",
    body: "valid note",
    ...overrides,
  };
}

const runSubmit = (
  layer: Layer.Layer<ReviewSubmission>,
  input: ReviewSubmitInput,
): Effect.Effect<ReviewSubmitResult, unknown> =>
  Effect.gen(function* () {
    const service = yield* ReviewSubmission;
    return yield* service.submit(input);
  }).pipe(Effect.provide(layer));

it.effect("verdict-only submit posts via submitPullRequestReview and reports submitted", () => {
  const { layer, recorded } = makeFakes();
  return Effect.gen(function* () {
    const result = yield* runSubmit(layer, submitInput({ event: "approve" }));

    expect(result).toEqual({ submitted: true });
    expect(recorded.submitPullRequestReview).toEqual([
      { cwd: "/repo", reference: PR_URL, event: "approve" },
    ]);
    expect(recorded.createPullRequestReviewWithComments).toHaveLength(0);
    // No comments requested -> diff is never fetched.
    expect(recorded.getPullRequestDiff).toHaveLength(0);
  });
});

it.effect(
  "all-valid inline comments post via createPullRequestReviewWithComments at live head",
  () => {
    const { layer, recorded } = makeFakes();
    const valid = [comment({ line: 3, side: "RIGHT" }), comment({ line: 2, side: "LEFT" })];
    return Effect.gen(function* () {
      const result = yield* runSubmit(
        layer,
        submitInput({ event: "request_changes", body: "fix this", comments: valid }),
      );

      expect(result).toEqual({ submitted: true });
      expect(recorded.submitPullRequestReview).toHaveLength(0);
      expect(recorded.createPullRequestReviewWithComments).toHaveLength(1);

      const call = recorded.createPullRequestReviewWithComments[0]!;
      expect(call.commitId).toBe(LIVE_HEAD_SHA);
      expect(call.owner).toBe(PR_OWNER);
      expect(call.repo).toBe(PR_REPO);
      expect(call.number).toBe(PR_NUMBER);
      expect(call.event).toBe("request_changes");
      expect(call.body).toBe("fix this");
      expect(call.comments).toEqual(valid);
    });
  },
);

it.effect(
  "partially-valid comments post the valid ones and return the invalid in skippedComments",
  () => {
    const { layer, recorded } = makeFakes();
    const valid = comment({ line: 3, side: "RIGHT" });
    const invalidPath = comment({ path: "src/missing.ts", line: 3, side: "RIGHT" });
    const invalidLine = comment({ line: 999, side: "RIGHT" });
    return Effect.gen(function* () {
      const result = yield* runSubmit(
        layer,
        submitInput({ comments: [valid, invalidPath, invalidLine] }),
      );

      expect(result.submitted).toBe(true);
      expect(result.skippedComments).toEqual([invalidPath, invalidLine]);
      expect(result.headMoved).toBeUndefined();

      const call = recorded.createPullRequestReviewWithComments[0]!;
      expect(call.comments).toEqual([valid]);
      expect(call.commitId).toBe(LIVE_HEAD_SHA);
      expect(recorded.submitPullRequestReview).toHaveLength(0);
    });
  },
);

it.effect("all-invalid comment-only reviews return skipped comments without submitting", () => {
  const { layer, recorded } = makeFakes();
  const allInvalid = [
    comment({ path: "src/missing.ts", line: 3, side: "RIGHT" }),
    comment({ line: 999, side: "RIGHT" }),
  ];
  return Effect.gen(function* () {
    const result = yield* runSubmit(layer, submitInput({ comments: allInvalid }));

    expect(result.submitted).toBe(false);
    expect(result.skippedComments).toEqual(allInvalid);
    expect(recorded.createPullRequestReviewWithComments).toHaveLength(0);
    expect(recorded.submitPullRequestReview).toHaveLength(0);
  });
});

it.effect("all-invalid inline comments with a body do not degrade to body-only submit", () => {
  const { layer, recorded } = makeFakes();
  const allInvalid = [comment({ path: "src/missing.ts", line: 3, side: "RIGHT" })];
  return Effect.gen(function* () {
    const result = yield* runSubmit(
      layer,
      submitInput({
        event: "request_changes",
        body: "body should not post alone",
        comments: allInvalid,
      }),
    );

    expect(result.submitted).toBe(false);
    expect(result.skippedComments).toEqual(allInvalid);
    expect(recorded.createPullRequestReviewWithComments).toHaveLength(0);
    expect(recorded.submitPullRequestReview).toHaveLength(0);
  });
});

it.effect("expectedHeadSha differing from live head refuses to post inline comments", () => {
  const { layer, recorded } = makeFakes();
  const valid = comment({ line: 3, side: "RIGHT" });
  return Effect.gen(function* () {
    const result = yield* runSubmit(
      layer,
      submitInput({
        comments: [valid],
        expectedHeadSha: "stale111111111111111111111111111111111111",
      }),
    );

    expect(result.headMoved).toBe(true);
    expect(result.submitted).toBe(false);
    expect(recorded.createPullRequestReviewWithComments).toHaveLength(0);
    expect(recorded.submitPullRequestReview).toHaveLength(0);
  });
});

it.effect("expectedHeadSha differing from live head refuses body-only review submit", () => {
  const { layer, recorded } = makeFakes();
  return Effect.gen(function* () {
    const result = yield* runSubmit(
      layer,
      submitInput({
        event: "request_changes",
        body: "stale body",
        expectedHeadSha: "stale111111111111111111111111111111111111",
      }),
    );

    expect(result).toEqual({ submitted: false, headMoved: true });
    expect(recorded.createPullRequestReviewWithComments).toHaveLength(0);
    expect(recorded.submitPullRequestReview).toHaveLength(0);
    expect(recorded.getPullRequestDiff).toHaveLength(0);
  });
});

it.effect(
  "inline comment preparation failures surface as ReviewError without body-only submit",
  () => {
    const { layer, recorded } = makeFakes({ diffFails: true });
    return Effect.gen(function* () {
      const error = yield* runSubmit(
        layer,
        submitInput({ event: "request_changes", body: "body", comments: [comment()] }),
      ).pipe(Effect.flip);

      expect((error as { _tag?: string })._tag).toBe("ReviewError");
      expect((error as { message?: string }).message).toContain(
        "Could not prepare inline comments",
      );
      expect(recorded.createPullRequestReviewWithComments).toHaveLength(0);
      expect(recorded.submitPullRequestReview).toHaveLength(0);
    });
  },
);

it.effect("expectedHeadSha verification failures surface as ReviewError before submit", () => {
  const { layer, recorded } = makeFakes({ headShaFails: true });
  return Effect.gen(function* () {
    const error = yield* runSubmit(
      layer,
      submitInput({ body: "body", expectedHeadSha: LIVE_HEAD_SHA }),
    ).pipe(Effect.flip);

    expect((error as { _tag?: string })._tag).toBe("ReviewError");
    expect((error as { message?: string }).message).toContain("Could not verify pull request head");
    expect(recorded.createPullRequestReviewWithComments).toHaveLength(0);
    expect(recorded.submitPullRequestReview).toHaveLength(0);
  });
});

it.effect("a gh failure on the comment submit surfaces as a typed ReviewError, not a crash", () => {
  const { layer } = makeFakes({ withCommentsFails: true });
  const valid = comment({ line: 3, side: "RIGHT" });
  return Effect.gen(function* () {
    const error = yield* runSubmit(layer, submitInput({ comments: [valid] })).pipe(Effect.flip);

    expect((error as { _tag?: string })._tag).toBe("ReviewError");
    expect((error as { operation?: string }).operation).toBe("submit");
    expect((error as { message?: string }).message).toContain("Could not submit review");
  });
});

it.effect("a gh failure on a verdict-only submit surfaces as a typed ReviewError", () => {
  const { layer } = makeFakes({ submitFails: true });
  return Effect.gen(function* () {
    const error = yield* runSubmit(layer, submitInput({ event: "approve" })).pipe(Effect.flip);

    expect((error as { _tag?: string })._tag).toBe("ReviewError");
    expect((error as { operation?: string }).operation).toBe("submit");
  });
});
