import type {
  ReviewInlineComment,
  ReviewRemoteThread,
  ReviewSubmitEvent,
  ReviewSubmitResult,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { parsePullRequestUrl } from "@t3tools/shared/git";

import { GitCore } from "../../git/Services/GitCore.ts";
import {
  GitHubCli,
  type GitHubReviewEvent,
  type GitHubReviewThread,
} from "../../git/Services/GitHubCli.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { ReviewError } from "../Errors.ts";
import { ReviewSubmission, type ReviewSubmissionShape } from "../Services/ReviewSubmission.ts";
import { validateInlineComments } from "../validateInlineComments.ts";

function reviewError(operation: string, detail: string, cause?: unknown): ReviewError {
  return new ReviewError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toGitHubReviewEvent(event: ReviewSubmitEvent): GitHubReviewEvent {
  return event;
}

function toRemoteThread(thread: GitHubReviewThread): ReviewRemoteThread {
  return {
    id: thread.id,
    isResolved: thread.isResolved,
    ...(thread.path ? { path: thread.path } : {}),
    ...(thread.line !== undefined && thread.line > 0 ? { line: thread.line } : {}),
    ...(thread.side ? { side: thread.side } : {}),
    comments: thread.comments.map((comment) => ({
      ...(comment.id ? { id: comment.id } : {}),
      author: comment.author,
      ...(comment.authorAvatarUrl ? { authorAvatarUrl: comment.authorAvatarUrl } : {}),
      body: comment.body,
      createdAt: comment.createdAt,
      ...(comment.url ? { url: comment.url } : {}),
    })),
  };
}

const makeReviewSubmission = Effect.gen(function* () {
  yield* GitCore;
  const gitHubCli = yield* GitHubCli;
  const gitManager = yield* GitManager;

  const submit: ReviewSubmissionShape["submit"] = (input) =>
    Effect.gen(function* () {
      const { pullRequest } = yield* gitManager
        .resolvePullRequest({ cwd: input.cwd, reference: input.reference })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "GitHubCliError" || error._tag === "GitCommandError"
              ? error
              : reviewError("submit", `Could not resolve pull request: ${error.message}`, error),
          ),
        );

      const liveHeadSha = yield* gitHubCli
        .getPullRequestHeadSha({ cwd: input.cwd, reference: input.reference })
        .pipe(
          Effect.catchTag("GitHubCliError", (error) =>
            input.expectedHeadSha !== undefined
              ? Effect.fail(
                  reviewError(
                    "submit",
                    `Could not verify pull request head: ${error.message}`,
                    error,
                  ),
                )
              : Effect.succeed(""),
          ),
        );

      const headMoved =
        input.expectedHeadSha !== undefined &&
        liveHeadSha.length > 0 &&
        liveHeadSha !== input.expectedHeadSha;
      if (headMoved) {
        return {
          submitted: false,
          headMoved: true,
        } satisfies ReviewSubmitResult;
      }

      const requestedComments = input.comments ?? [];
      let validComments: ReadonlyArray<ReviewInlineComment> = [];
      let skippedComments: ReadonlyArray<ReviewInlineComment> = [];
      if (requestedComments.length > 0) {
        const patch = yield* gitHubCli
          .getPullRequestDiff({ cwd: input.cwd, reference: input.reference })
          .pipe(
            Effect.mapError((error) =>
              reviewError("submit", `Could not prepare inline comments: ${error.message}`, error),
            ),
          );
        const validated = validateInlineComments(patch, requestedComments);
        validComments = validated.valid;
        skippedComments = validated.skipped;
      }

      const event = toGitHubReviewEvent(input.event);
      const parsedUrl = parsePullRequestUrl(pullRequest.url);
      const canPostComments =
        validComments.length > 0 && parsedUrl !== null && liveHeadSha.length > 0;
      if (requestedComments.length > 0 && validComments.length === 0) {
        return {
          submitted: false,
          skippedComments: requestedComments,
          ...(headMoved ? { headMoved: true } : {}),
        } satisfies ReviewSubmitResult;
      }

      const result: { url?: string; reviewId?: number } = canPostComments
        ? yield* gitHubCli
            .createPullRequestReviewWithComments({
              cwd: input.cwd,
              owner: parsedUrl.owner,
              repo: parsedUrl.repo,
              number: parsedUrl.number,
              event,
              commitId: liveHeadSha,
              ...(input.body !== undefined ? { body: input.body } : {}),
              comments: validComments,
            })
            .pipe(
              Effect.mapError((error) =>
                reviewError("submit", `Could not submit review: ${error.message}`, error),
              ),
            )
        : yield* gitHubCli
            .submitPullRequestReview({
              cwd: input.cwd,
              reference: input.reference,
              event,
              ...(input.body !== undefined ? { body: input.body } : {}),
            })
            .pipe(
              Effect.as({}),
              Effect.mapError((error) =>
                reviewError("submit", `Could not submit review: ${error.message}`, error),
              ),
            );

      const droppedAll = validComments.length === 0 ? requestedComments : skippedComments;

      return {
        submitted: true,
        ...(result.url !== undefined ? { url: result.url } : {}),
        ...(result.reviewId !== undefined ? { reviewId: result.reviewId } : {}),
        ...(droppedAll.length > 0 ? { skippedComments: droppedAll } : {}),
        ...(headMoved ? { headMoved: true } : {}),
      } satisfies ReviewSubmitResult;
    });

  const loadThreads: ReviewSubmissionShape["loadThreads"] = (input) =>
    gitHubCli.getPullRequestThreads({ cwd: input.cwd, reference: input.reference }).pipe(
      Effect.map((threads) => ({ threads: threads.map(toRemoteThread) })),
      Effect.mapError((error) =>
        reviewError("loadThreads", `Could not load review threads: ${error.message}`, error),
      ),
    );

  const resolveThread: ReviewSubmissionShape["resolveThread"] = (input) =>
    gitHubCli
      .setPullRequestThreadResolution({
        cwd: input.cwd,
        threadId: input.threadId,
        resolved: input.resolved,
      })
      .pipe(
        Effect.map((thread) => ({ threadId: thread.id, isResolved: thread.isResolved })),
        Effect.mapError((error) =>
          reviewError("resolveThread", `Could not update review thread: ${error.message}`, error),
        ),
      );

  const replyThread: ReviewSubmissionShape["replyThread"] = (input) =>
    gitHubCli
      .addPullRequestThreadReply({
        cwd: input.cwd,
        threadId: input.threadId,
        body: input.body,
      })
      .pipe(
        Effect.map((result) => ({ threadId: result.threadId })),
        Effect.mapError((error) =>
          reviewError("replyThread", `Could not post review reply: ${error.message}`, error),
        ),
      );

  const updateThreadComment: ReviewSubmissionShape["updateThreadComment"] = (input) =>
    gitHubCli
      .updatePullRequestThreadComment({
        cwd: input.cwd,
        commentId: input.commentId,
        body: input.body,
      })
      .pipe(
        Effect.map((result) => ({ commentId: result.commentId })),
        Effect.mapError((error) =>
          reviewError(
            "updateThreadComment",
            `Could not edit review comment: ${error.message}`,
            error,
          ),
        ),
      );

  const deleteThreadComment: ReviewSubmissionShape["deleteThreadComment"] = (input) =>
    gitHubCli.deletePullRequestThreadComment({ cwd: input.cwd, commentId: input.commentId }).pipe(
      Effect.map((result) => ({ commentId: result.commentId })),
      Effect.mapError((error) =>
        reviewError(
          "deleteThreadComment",
          `Could not delete review comment: ${error.message}`,
          error,
        ),
      ),
    );

  return {
    submit,
    loadThreads,
    resolveThread,
    replyThread,
    updateThreadComment,
    deleteThreadComment,
  } satisfies ReviewSubmissionShape;
});

export const ReviewSubmissionLive = Layer.effect(ReviewSubmission, makeReviewSubmission);
