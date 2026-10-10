// FILE: pullRequestAutoFix.ts
// Purpose: "Auto-fix CI" state per chat and pull request: the server watches every PR a
//          chat turned it on for (e.g. each PR of a stack) and starts a fix turn in that chat
//          when one fails, one fix at a time. Available in Stable and Beta.
// Layer: Shared contracts (server watcher, WS RPCs, Environment panel PR section)

import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

/** Fix turns allowed in a row without a green run before auto-fix pauses itself. */
export const PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS = 3;

/**
 * - `watching`: waiting for the PR's checks to settle.
 * - `fixing`: a durable fix request was recorded for `lastHandledHeadSha` and has not pushed yet.
 * - `paused`: stopped until the user turns it back on (see `pauseReason`).
 */
export const PullRequestAutoFixStatus = Schema.Literals(["watching", "fixing", "paused"]);
export type PullRequestAutoFixStatus = typeof PullRequestAutoFixStatus.Type;

/**
 * - `attempt-limit`: CI still failed after the maximum number of fix turns.
 * - `no-push`: a fix turn ended without pushing a new commit.
 * - `dispatch-interrupted`: no accepted durable fix command exists after interruption.
 */
export const PullRequestAutoFixPauseReason = Schema.Literals([
  "attempt-limit",
  "no-push",
  "dispatch-interrupted",
]);
export type PullRequestAutoFixPauseReason = typeof PullRequestAutoFixPauseReason.Type;

/** One watched pull request of one chat. */
export const PullRequestAutoFixState = Schema.Struct({
  threadId: ThreadId,
  pullRequestUrl: TrimmedNonEmptyString,
  /** Original URL retained so redirects can be turned off without another GitHub read. */
  requestedPullRequestUrl: Schema.optional(TrimmedNonEmptyString),
  status: PullRequestAutoFixStatus,
  pauseReason: Schema.NullOr(PullRequestAutoFixPauseReason),
  /** Fix turns started since the last green run. */
  attempts: NonNegativeInt,
  /** Head commit whose failing checks already started a fix turn. */
  lastHandledHeadSha: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type PullRequestAutoFixState = typeof PullRequestAutoFixState.Type;

export const PullRequestAutoFixGetInput = Schema.Struct({
  threadId: ThreadId,
});
export type PullRequestAutoFixGetInput = typeof PullRequestAutoFixGetInput.Type;

/** Every pull request the chat watches; a PR missing from the list has auto-fix off. */
export const PullRequestAutoFixListResult = Schema.Struct({
  states: Schema.Array(PullRequestAutoFixState),
});
export type PullRequestAutoFixListResult = typeof PullRequestAutoFixListResult.Type;

/** Turning it on again after a pause resumes with a fresh attempt count. */
export const PullRequestAutoFixSetInput = Schema.Struct({
  threadId: ThreadId,
  pullRequestUrl: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type PullRequestAutoFixSetInput = typeof PullRequestAutoFixSetInput.Type;

/** `state` is null once auto-fix is off for that pull request. */
export const PullRequestAutoFixResult = Schema.Struct({
  state: Schema.NullOr(PullRequestAutoFixState),
});
export type PullRequestAutoFixResult = typeof PullRequestAutoFixResult.Type;
