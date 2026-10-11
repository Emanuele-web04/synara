// One bounded queue and one rate-limit pause for every background `gh` read (inbox, pull request
// detail, git status lookups, thread badges). GitHub's secondary limits count concurrent requests
// per account, and requests sent while limited prolong the block, so reads share the slots and
// fail fast until the pause expires. Mutations never go through the gate.

import { Effect, Semaphore } from "effect";

import { GITHUB_INBOX_RATE_LIMIT_FALLBACK_PAUSE_MS } from "../githubInbox/githubInbox.logic";
import { GitHubCliError } from "./Errors";

/** Concurrent GitHub reads across the whole server. Mutations bypass this queue so user actions
 * never wait behind list refreshes. */
export const GITHUB_READ_SLOTS = 6;

export interface GitHubReadGate {
  /** Runs a read in one of the shared slots; fails with a `rate-limited` error while paused. */
  readonly withRead: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | GitHubCliError, R>;
  /** Starts the pause when `error` is a GitHub rate-limit failure; any other value is ignored. */
  readonly noteFailure: (error: unknown) => void;
}

export function makeGitHubReadGate(options?: {
  /** Injectable for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}): GitHubReadGate {
  const now = options?.now ?? Date.now;
  const slots = Semaphore.makeUnsafe(GITHUB_READ_SLOTS);
  let pausedUntil = 0;

  const noteFailure: GitHubReadGate["noteFailure"] = (error) => {
    if (error instanceof GitHubCliError && error.reason === "rate-limited") {
      // The CLI reports no reset time, so this is the same short guess the inbox uses.
      pausedUntil = Math.max(pausedUntil, now() + GITHUB_INBOX_RATE_LIMIT_FALLBACK_PAUSE_MS);
    }
  };

  const failWhilePaused = Effect.suspend(() =>
    pausedUntil > now()
      ? Effect.fail(
          new GitHubCliError({
            operation: "withRead",
            detail: "GitHub rate limit reached. Synara will retry after the limit resets.",
            reason: "rate-limited",
          }),
        )
      : Effect.void,
  );

  return {
    noteFailure,
    withRead: (effect) =>
      failWhilePaused.pipe(
        Effect.andThen(
          slots.withPermits(1)(
            // Checked again once a slot is free: a read queued before the limit hit must not run.
            failWhilePaused.pipe(
              Effect.andThen(
                effect.pipe(Effect.tapError((error) => Effect.sync(() => noteFailure(error)))),
              ),
            ),
          ),
        ),
      ),
  };
}
