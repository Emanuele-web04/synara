// Per-(repository, state, sort) inbox snapshots with the request budget rules from the inbox plan:
// a short freshness window shared by every caller, a free conditional probe before refetching,
// a rate-limit gate, and exponential backoff for failing repositories. The last good snapshot is
// kept so a rate-limited or failing repository still shows its rows with a warning.
//
// A full read is two GraphQL documents sent at the same time: the repository lists and the
// viewer's `involves:@me` search. Each takes its own read slot and releases it on completion, so
// a read never holds one slot while waiting for another.

import type { GitHubInboxRateLimit, GitHubInboxSort, GitHubInboxState } from "@synara/contracts";
import { Effect, type Scope } from "effect";

import { GitHubCliError } from "../git/Errors";
import type {
  GitHubCliShape,
  GitHubGraphQlRateLimit,
  GitHubInboxIssue,
  GitHubInboxPullRequest,
  GitHubRepositoryInboxInvolvement,
  GitHubRepositoryInboxLists,
  GitHubRepositoryInboxSnapshot,
} from "../git/Services/GitHubCli";
import { makeKeyedSingleFlightCache } from "../pullRequests/KeyedSingleFlightCache";
import { isGlobalGitHubCliError } from "../pullRequests/projectRepositoryAccess";
import {
  GITHUB_INBOX_FORCE_REFRESH_COOLDOWN_MS,
  GITHUB_INBOX_MAX_PROBE_EXTENSION_MS,
  GITHUB_INBOX_RATE_LIMIT_FALLBACK_PAUSE_MS,
  GITHUB_INBOX_RATE_LIMIT_FLOOR,
  GITHUB_INBOX_SNAPSHOT_TTL_MS,
  githubInboxFailureBackoffMs,
  summarizeGitHubInboxError,
} from "./githubInbox.logic";

const MAX_STORED_SNAPSHOTS = 512;

export interface GitHubInboxSnapshotEntry {
  readonly snapshot: GitHubRepositoryInboxSnapshot;
  /** ETag of the change probe taken just before `snapshot` was read; null if unavailable. */
  readonly etag: string | null;
  /** Last full GraphQL read. */
  readonly fetchedAt: number;
  /** Last time a read or a 304 probe confirmed the snapshot current. */
  readonly validatedAt: number;
  /** The involvement search failed, so `snapshot` holds the lists alone. Such an entry is served
   * as `stale` and read in full again after the failure backoff. */
  readonly involvementError: GitHubCliError | null;
}

export type GitHubInboxSnapshotLoad =
  | { readonly _tag: "fresh"; readonly entry: GitHubInboxSnapshotEntry }
  | {
      readonly _tag: "stale";
      /** Last good snapshot, if any, served in place of a fresh one. */
      readonly entry: GitHubInboxSnapshotEntry | null;
      readonly error: GitHubCliError;
      /** Epoch milliseconds after which the repository will be read again. */
      readonly retryAt: number | null;
    };

export interface GitHubInboxSnapshotStore {
  /** Fails only with gh setup errors (not installed, not authenticated); everything else is a
   * `stale` result so one repository cannot hide the others. */
  readonly load: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly state: GitHubInboxState;
    readonly sort: GitHubInboxSort;
    readonly forceRefresh: boolean;
  }) => Effect.Effect<GitHubInboxSnapshotLoad, GitHubCliError>;
  /** After a mutation: drop in-flight reads and force a full read next time, keeping the old
   * snapshot only as a fallback. */
  readonly invalidateRepository: (repository: string) => Effect.Effect<void>;
  readonly rateLimit: () => GitHubInboxRateLimit | null;
}

function snapshotKey(repository: string, state: GitHubInboxState, sort: GitHubInboxSort): string {
  return `${repository.trim().toLowerCase()}\u0000${state}\u0000${sort}`;
}

function lowerRemaining(
  left: GitHubGraphQlRateLimit | null,
  right: GitHubGraphQlRateLimit | null,
): GitHubGraphQlRateLimit | null {
  if (!left || !right) return left ?? right;
  return right.remaining < left.remaining ? right : left;
}

/** Merge the involvement search into the lists by number (GitHub numbers pull requests and
 * issues from one sequence per repository). Without it, only the lists are kept. */
export function mergeRepositoryInbox(
  lists: GitHubRepositoryInboxLists,
  involvement: GitHubRepositoryInboxInvolvement | null,
): GitHubRepositoryInboxSnapshot {
  if (!involvement) return { ...lists, involvedNumbers: [] };
  const present = new Set<number>();
  for (const item of lists.pullRequests) present.add(item.number);
  for (const item of lists.issues) present.add(item.number);
  const pullRequests: GitHubInboxPullRequest[] = [...lists.pullRequests];
  const issues: GitHubInboxIssue[] = [...lists.issues];
  for (const remote of involvement.items) {
    if (present.has(remote.item.number)) continue;
    present.add(remote.item.number);
    if (remote.kind === "pullRequest") pullRequests.push(remote.item);
    else issues.push(remote.item);
  }
  return {
    ...lists,
    pullRequests,
    issues,
    involvedNumbers: involvement.involvedNumbers,
    rateLimit: lowerRemaining(lists.rateLimit, involvement.rateLimit),
  };
}

export const makeGitHubInboxSnapshotStore = (dependencies: {
  readonly github: GitHubCliShape;
  readonly withGitHubRead: GitHubCliShape["withRead"];
  /** Injectable for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}): Effect.Effect<GitHubInboxSnapshotStore, never, Scope.Scope> =>
  Effect.gen(function* () {
    const now = dependencies.now ?? Date.now;
    const entries = new Map<string, GitHubInboxSnapshotEntry>();
    // Bumped by invalidation so a read that started earlier cannot store its result.
    const generations = new Map<string, number>();
    const fullReadRequired = new Set<string>();
    const failures = new Map<
      string,
      { readonly count: number; readonly retryAt: number; readonly error: GitHubCliError }
    >();
    let latestRateLimit: { readonly remaining: number; readonly resetAt: number } | null = null;
    let pausedUntil = 0;

    // Single flight only: freshness is decided above with the injectable clock, so the cache
    // never holds a value past the call that produced it.
    const inFlight = yield* makeKeyedSingleFlightCache<GitHubInboxSnapshotEntry, GitHubCliError>({
      maxEntries: MAX_STORED_SNAPSHOTS,
      ttlMs: 0,
    });

    const isCurrentGeneration = (key: string, generation: number) =>
      (generations.get(key) ?? 0) === generation;

    const store = (key: string, generation: number, entry: GitHubInboxSnapshotEntry) => {
      if (!isCurrentGeneration(key, generation)) return;
      entries.delete(key);
      entries.set(key, entry);
      fullReadRequired.delete(key);
      while (entries.size > MAX_STORED_SNAPSHOTS) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    };

    const recordRateLimit = (snapshot: GitHubRepositoryInboxSnapshot) => {
      const rateLimit = snapshot.rateLimit;
      const resetAt = rateLimit ? Date.parse(rateLimit.resetAt) : Number.NaN;
      if (!rateLimit || !Number.isFinite(resetAt)) return;
      latestRateLimit = { remaining: rateLimit.remaining, resetAt };
      if (rateLimit.remaining < GITHUB_INBOX_RATE_LIMIT_FLOOR) {
        pausedUntil = Math.max(pausedUntil, resetAt);
      }
    };

    const pauseAfterRateLimitError = (at: number) => {
      // A known, near reset with an exhausted budget is exact; otherwise (secondary limits,
      // abuse detection) GitHub gives the CLI no reset time and a short pause is the safe guess.
      const knownReset =
        latestRateLimit &&
        latestRateLimit.resetAt > at &&
        latestRateLimit.remaining < GITHUB_INBOX_RATE_LIMIT_FLOOR
          ? latestRateLimit.resetAt
          : null;
      pausedUntil = Math.max(
        pausedUntil,
        knownReset ?? at + GITHUB_INBOX_RATE_LIMIT_FALLBACK_PAUSE_MS,
      );
      return pausedUntil;
    };

    // Only a gh setup error from the involvement search fails the read; anything else keeps the
    // list rows and is reported with them.
    const readInvolvement = (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly state: GitHubInboxState;
      readonly sort: GitHubInboxSort;
    }) =>
      dependencies
        .withGitHubRead(
          dependencies.github.listRepositoryInboxInvolvement({
            cwd: input.cwd,
            repository: input.repository,
            state: input.state,
            sort: input.sort,
          }),
        )
        .pipe(
          Effect.map((involvement) => ({ involvement, error: null })),
          Effect.catch((error) =>
            isGlobalGitHubCliError(error)
              ? Effect.fail(error)
              : Effect.succeed({
                  involvement: null,
                  error: new GitHubCliError({
                    operation: "listRepositoryInboxInvolvement",
                    detail: `Older items involving you could not be loaded: ${summarizeGitHubInboxError(error)}`,
                    reason: error.reason,
                  }),
                }),
          ),
        );

    const read = (input: {
      readonly key: string;
      readonly generation: number;
      readonly cwd: string;
      readonly repository: string;
      readonly state: GitHubInboxState;
      readonly sort: GitHubInboxSort;
      readonly skipProbe: boolean;
    }) =>
      Effect.gen(function* () {
        const previous = entries.get(input.key);
        const startedAt = now();
        const canProbe =
          !input.skipProbe &&
          !fullReadRequired.has(input.key) &&
          previous?.etag != null &&
          startedAt - previous.fetchedAt < GITHUB_INBOX_MAX_PROBE_EXTENSION_MS;

        const probe = yield* dependencies
          .withGitHubRead(
            dependencies.github.probeRepositoryInboxChanges({
              cwd: input.cwd,
              repository: input.repository,
              etag: canProbe ? (previous?.etag ?? null) : null,
            }),
          )
          .pipe(
            // The probe only saves work. If it fails for any reason other than the budget
            // (for example a repository with issues disabled), read the repository in full.
            Effect.catch((error) =>
              error.reason === "rate-limited" || isGlobalGitHubCliError(error)
                ? Effect.fail(error)
                : Effect.succeed({ changed: true as const, etag: null }),
            ),
          );
        if (!probe.changed && previous) {
          const extended = { ...previous, validatedAt: now() };
          store(input.key, input.generation, extended);
          return extended;
        }

        // A lists failure fails the read and interrupts the search; the reverse only when the
        // search hit a gh setup error.
        const [lists, involved] = yield* Effect.all(
          [
            dependencies.withGitHubRead(
              dependencies.github.listRepositoryInbox({
                cwd: input.cwd,
                repository: input.repository,
                state: input.state,
                sort: input.sort,
              }),
            ),
            readInvolvement(input),
          ],
          { concurrency: 2 },
        );
        const snapshot = mergeRepositoryInbox(lists, involved.involvement);
        recordRateLimit(snapshot);
        const readAt = now();
        const entry: GitHubInboxSnapshotEntry = {
          snapshot,
          // Without an ETag the next read is a full one, which retries the search.
          etag: probe.changed && involved.error === null ? probe.etag : null,
          fetchedAt: readAt,
          validatedAt: readAt,
          involvementError: involved.error,
        };
        store(input.key, input.generation, entry);
        return entry;
      });

    const staleAfterFailure = (
      key: string,
      generation: number,
      entry: GitHubInboxSnapshotEntry | null,
      error: GitHubCliError,
    ): GitHubInboxSnapshotLoad => {
      const failedAt = now();
      if (error.reason === "rate-limited") {
        return { _tag: "stale", entry, error, retryAt: pauseAfterRateLimitError(failedAt) };
      }
      // Existing waiters may finish after invalidation, but their failure must not
      // replace the newer generation's backoff. Rate limits above remain global.
      if (!isCurrentGeneration(key, generation)) {
        return { _tag: "stale", entry, error, retryAt: null };
      }
      const count = (failures.get(key)?.count ?? 0) + 1;
      const retryAt = failedAt + githubInboxFailureBackoffMs(count);
      failures.set(key, { count, retryAt, error });
      return { _tag: "stale", entry, error, retryAt };
    };

    const load: GitHubInboxSnapshotStore["load"] = (input) =>
      Effect.gen(function* () {
        const key = snapshotKey(input.repository, input.state, input.sort);
        const startedAt = now();
        const existing = entries.get(key) ?? null;
        // Repeated clicks on refresh share the full read the first one made. A mutation in
        // between sets `fullReadRequired`, so the click after an action still reads GitHub.
        const forceRefresh =
          input.forceRefresh &&
          !(
            existing &&
            existing.involvementError === null &&
            !fullReadRequired.has(key) &&
            startedAt - existing.fetchedAt < GITHUB_INBOX_FORCE_REFRESH_COOLDOWN_MS
          );
        const generation = (generations.get(key) ?? 0) + (forceRefresh ? 1 : 0);
        if (forceRefresh) {
          generations.set(key, generation);
          failures.delete(key);
          yield* inFlight.invalidate(key);
        }

        if (
          !forceRefresh &&
          existing &&
          existing.involvementError === null &&
          !fullReadRequired.has(key) &&
          startedAt - existing.validatedAt < GITHUB_INBOX_SNAPSHOT_TTL_MS
        ) {
          return { _tag: "fresh", entry: existing } as const;
        }

        const failure = failures.get(key);
        if (!forceRefresh && failure && failure.retryAt > startedAt) {
          return {
            _tag: "stale",
            entry: existing,
            error: failure.error,
            retryAt: failure.retryAt,
          } as const;
        }
        // A manual refresh clears repository backoff but never overrides GitHub's budget.
        if (pausedUntil > startedAt) {
          return {
            _tag: "stale",
            entry: existing,
            error: new GitHubCliError({
              operation: "listRepositoryInbox",
              detail: "GitHub rate limit is nearly exhausted; waiting for it to reset.",
              reason: "rate-limited",
            }),
            retryAt: pausedUntil,
          } as const;
        }

        return yield* inFlight
          .get(
            key,
            read({
              key,
              generation,
              cwd: input.cwd,
              repository: input.repository,
              state: input.state,
              sort: input.sort,
              skipProbe: forceRefresh,
            }),
          )
          .pipe(
            Effect.map((entry): GitHubInboxSnapshotLoad => {
              // The list rows arrived but the involvement search did not: show them with the
              // failure, under the same backoff as a failed read.
              if (entry.involvementError) {
                return staleAfterFailure(key, generation, entry, entry.involvementError);
              }
              if (isCurrentGeneration(key, generation)) failures.delete(key);
              return { _tag: "fresh", entry };
            }),
            Effect.catch((error): Effect.Effect<GitHubInboxSnapshotLoad, GitHubCliError> => {
              if (isGlobalGitHubCliError(error)) return Effect.fail(error);
              return Effect.succeed(
                staleAfterFailure(key, generation, entries.get(key) ?? null, error),
              );
            }),
          );
      });

    const invalidateRepository: GitHubInboxSnapshotStore["invalidateRepository"] = (repository) =>
      Effect.gen(function* () {
        for (const state of ["open", "closed"] as const) {
          for (const sort of ["created", "updated"] as const) {
            const key = snapshotKey(repository, state, sort);
            generations.set(key, (generations.get(key) ?? 0) + 1);
            fullReadRequired.add(key);
            yield* inFlight.invalidate(key);
          }
        }
      });

    return {
      load,
      invalidateRepository,
      rateLimit: () =>
        latestRateLimit
          ? {
              remaining: latestRateLimit.remaining,
              resetAt: new Date(latestRateLimit.resetAt).toISOString(),
            }
          : null,
    } satisfies GitHubInboxSnapshotStore;
  });
