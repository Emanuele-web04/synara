import { Effect, Layer, Option } from "effect";

import { deriveReviewLane, reviewPullRequestContentHash } from "../reviewLane.ts";
import {
  ReviewPullRequestStore,
  type ReviewPullRequestUpsert,
} from "../Services/ReviewPullRequestStore.ts";
import {
  REVIEW_SYNC_PAGE_SIZE,
  REVIEW_SYNC_RATE_LIMIT_COOLDOWN_MS,
  REVIEW_SYNC_RESERVE_FLOOR,
  ReviewRemoteSource,
  type ReviewRemoteBudget,
  type ReviewRemotePage,
  ReviewSync,
  type ReviewSyncResult,
  type ReviewSyncShape,
  type ReviewSyncStopReason,
} from "../Services/ReviewSync.ts";

const MAX_SYNC_PAGES = 50;

const makeReviewSync = Effect.gen(function* () {
  const store = yield* ReviewPullRequestStore;
  const remote = yield* ReviewRemoteSource;

  const syncRepository: ReviewSyncShape["syncRepository"] = (input) =>
    Effect.gen(function* () {
      const mode = input.mode ?? "delta";

      const existing = yield* store.getSyncState({ repositoryId: input.repositoryId });
      let state = Option.getOrNull(existing);
      if (state !== null && state.tokenIdentity !== input.tokenIdentity) {
        yield* store.clearRepository({ repositoryId: input.repositoryId });
        state = null;
      }

      // Governor pre-check: if the last sync left us below the reserve and the
      // window has not reset yet, do not spend more. Reads keep serving from SQLite.
      if (
        state !== null &&
        state.pointsRemaining !== null &&
        state.pointsRemaining < REVIEW_SYNC_RESERVE_FLOOR &&
        state.rateResetAt !== null &&
        input.now < state.rateResetAt
      ) {
        return {
          upserted: 0,
          skippedUnchanged: 0,
          pagesFetched: 0,
          reconciled: false,
          stopReason: "pre-budget-floor",
          pointsRemaining: state.pointsRemaining,
        } satisfies ReviewSyncResult;
      }

      const watermark = mode === "full" ? null : (state?.lastSeenUpdatedAt ?? null);
      // Delta PRs are past the watermark, so their content always changed and the
      // skip never fires. Only a full re-scan needs hashes to skip unchanged rows.
      const openHashes =
        mode === "full"
          ? yield* store.getOpenContentHashes({ repositoryId: input.repositoryId })
          : new Map<number, string>();

      let cursor: string | null = null;
      let maxUpdatedAt: string | null = watermark;
      let upserted = 0;
      let skippedUnchanged = 0;
      let pagesFetched = 0;
      // Boxed: TS narrows a closure-mutated `let` back to null at the outer read; the box is one shared cell.
      const lastBudget: { current: ReviewRemoteBudget | null } = { current: null };
      let stopReason: ReviewSyncStopReason = "end";
      let reachedEnd = false;
      let reconciled = false;
      const seenOpenNumbers: number[] = [];

      // Persist on every exit so a mid-scan failure can't strand sync_state. The watermark advances
      // only when the scan caught up (reached end / hit watermark); a partial run leaves it for retry.
      const persistSyncState = Effect.gen(function* () {
        const caughtUp = reachedEnd || stopReason === "watermark";
        yield* store.upsertSyncState({
          repositoryId: input.repositoryId,
          tokenIdentity: input.tokenIdentity,
          ...(caughtUp && maxUpdatedAt !== null ? { lastSeenUpdatedAt: maxUpdatedAt } : {}),
          lastSyncedAt: input.now,
          ...(reconciled ? { fullResyncedAt: input.now } : {}),
          ...(lastBudget.current !== null
            ? {
                lastGraphqlCost: lastBudget.current.cost,
                pointsRemaining: lastBudget.current.remaining,
                rateResetAt: lastBudget.current.resetAt,
              }
            : {}),
        });
      }).pipe(Effect.ignore);

      const runScan = Effect.gen(function* () {
        while (true) {
          // Already over the limit: record the reset so the pre-check skips until then, instead
          // of re-failing every board load. Reads keep serving from SQLite. Non-rate-limit errors
          // still propagate.
          const page: ReviewRemotePage | { readonly rateLimitedAt: number } = yield* remote
            .fetchUpdatedPage({
              cwd: input.cwd,
              after: cursor,
              pageSize: REVIEW_SYNC_PAGE_SIZE,
            })
            .pipe(
              Effect.catch((error) =>
                error.rateLimited === true
                  ? Effect.succeed({
                      rateLimitedAt:
                        error.resetAt ?? input.now + REVIEW_SYNC_RATE_LIMIT_COOLDOWN_MS,
                    })
                  : Effect.fail(error),
              ),
            );
          if ("rateLimitedAt" in page) {
            lastBudget.current = { cost: 0, remaining: 0, resetAt: page.rateLimitedAt };
            stopReason = "rate-limited";
            break;
          }
          pagesFetched += 1;
          lastBudget.current = page.budget;

          let hitWatermark = false;
          const pageUpserts: ReviewPullRequestUpsert[] = [];
          for (const pr of page.pullRequests) {
            if (watermark !== null && pr.updatedAt <= watermark) {
              hitWatermark = true;
              break;
            }
            if (pr.state === "open") {
              seenOpenNumbers.push(pr.number);
            }
            const hash = reviewPullRequestContentHash(pr);
            if (openHashes.get(pr.number) === hash) {
              skippedUnchanged += 1;
            } else {
              pageUpserts.push({
                repositoryId: input.repositoryId,
                tokenIdentity: input.tokenIdentity,
                syncedAt: input.now,
                lane: deriveReviewLane(pr),
                contentHash: hash,
                summary: pr,
              });
            }
            if (maxUpdatedAt === null || pr.updatedAt > maxUpdatedAt) {
              maxUpdatedAt = pr.updatedAt;
            }
          }
          if (pageUpserts.length > 0) {
            yield* store.upsertPullRequests(pageUpserts);
            upserted += pageUpserts.length;
          }

          if (hitWatermark) {
            stopReason = "watermark";
            break;
          }
          if (!page.hasNextPage || page.endCursor === null) {
            stopReason = "end";
            reachedEnd = true;
            break;
          }
          if (page.budget.remaining < REVIEW_SYNC_RESERVE_FLOOR) {
            stopReason = "budget";
            break;
          }
          if (pagesFetched >= MAX_SYNC_PAGES) {
            stopReason = "budget";
            break;
          }
          cursor = page.endCursor;
        }

        // Tombstone reconcile is only safe after a full scan that reached the end,
        // where every open PR was observed. A delta stops at the watermark.
        reconciled = mode === "full" && reachedEnd;
        if (reconciled) {
          yield* store.tombstoneExcept({
            repositoryId: input.repositoryId,
            keepNumbers: seenOpenNumbers,
            at: input.now,
          });
        }
      });

      yield* runScan.pipe(Effect.ensuring(persistSyncState));

      const finalBudget: ReviewRemoteBudget | null = lastBudget.current;
      return {
        upserted,
        skippedUnchanged,
        pagesFetched,
        reconciled,
        stopReason,
        pointsRemaining: finalBudget?.remaining ?? null,
      } satisfies ReviewSyncResult;
    });

  return { syncRepository } satisfies ReviewSyncShape;
});

export const ReviewSyncLive = Layer.effect(ReviewSync, makeReviewSync);
