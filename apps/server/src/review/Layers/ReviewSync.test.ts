import type { ReviewPullRequestSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import Migration0046 from "../../persistence/Migrations/046_ReviewPullRequests.ts";
import Migration0047 from "../../persistence/Migrations/047_ReviewReviewRequests.ts";
import { ReviewPullRequestStore } from "../Services/ReviewPullRequestStore.ts";
import {
  ReviewRemoteSource,
  type ReviewRemotePage,
  type ReviewRemoteSourceShape,
  ReviewSync,
  ReviewSyncError,
} from "../Services/ReviewSync.ts";
import { ReviewPullRequestStoreLive } from "./ReviewPullRequestStore.ts";
import { ReviewSyncLive } from "./ReviewSync.ts";

function summary(
  overrides: Partial<ReviewPullRequestSummary> & { number: number },
): ReviewPullRequestSummary {
  return {
    number: overrides.number,
    title: overrides.title ?? `PR ${String(overrides.number)}`,
    url: overrides.url ?? `https://github.com/acme/repo/pull/${String(overrides.number)}`,
    baseBranch: overrides.baseBranch ?? "main",
    headBranch: overrides.headBranch ?? `branch-${String(overrides.number)}`,
    author: overrides.author ?? "alice",
    updatedAt: overrides.updatedAt ?? "2026-06-16T00:00:00.000Z",
    state: overrides.state ?? "open",
    reviewDecision: overrides.reviewDecision ?? null,
    isDraft: overrides.isDraft ?? false,
    additions: overrides.additions ?? 1,
    deletions: overrides.deletions ?? 0,
    checksStatus: overrides.checksStatus ?? "pending",
    reviewRequests: overrides.reviewRequests ?? [],
    labels: overrides.labels ?? [],
    assignees: overrides.assignees ?? [],
  };
}

function page(
  pullRequests: ReadonlyArray<ReviewPullRequestSummary>,
  opts?: {
    hasNextPage?: boolean;
    endCursor?: string | null;
    budget?: { cost: number; remaining: number; resetAt: number };
  },
): ReviewRemotePage {
  return {
    pullRequests,
    hasNextPage: opts?.hasNextPage ?? false,
    endCursor: opts?.endCursor ?? null,
    budget: opts?.budget ?? { cost: 1, remaining: 4999, resetAt: 0 },
  };
}

function scriptedRemote() {
  const queue: (ReviewRemotePage | ReviewSyncError)[] = [];
  const shape: ReviewRemoteSourceShape = {
    fetchUpdatedPage: () => {
      const next = queue.shift();
      if (next === undefined) {
        return Effect.fail(
          new ReviewSyncError({ operation: "fetchUpdatedPage", detail: "no scripted page" }),
        );
      }
      return next instanceof ReviewSyncError ? Effect.fail(next) : Effect.succeed(next);
    },
  };
  return {
    layer: Layer.succeed(ReviewRemoteSource, shape),
    push: (...items: (ReviewRemotePage | ReviewSyncError)[]) => queue.push(...items),
  };
}

function buildLayer(remote: ReturnType<typeof scriptedRemote>) {
  const deps = Layer.mergeAll(ReviewPullRequestStoreLive, remote.layer).pipe(
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  );
  return ReviewSyncLive.pipe(Layer.provideMerge(deps));
}

describe("ReviewSync", () => {
  it("delta sync stops at the watermark and fetches only newer PRs", async () => {
    const remote = scriptedRemote();
    const result = await Effect.gen(function* () {
      yield* Migration0046;
      yield* Migration0047;
      const sync = yield* ReviewSync;
      yield* Effect.sync(() =>
        remote.push(
          page([
            summary({ number: 2, updatedAt: "2026-06-16T02:00:00.000Z" }),
            summary({ number: 1, updatedAt: "2026-06-16T01:00:00.000Z" }),
          ]),
        ),
      );
      const first = yield* sync.syncRepository({
        cwd: "/r",
        repositoryId: "repo",
        tokenIdentity: "gh",
        now: 1000,
      });
      yield* Effect.sync(() =>
        remote.push(
          page([
            summary({ number: 3, updatedAt: "2026-06-16T03:00:00.000Z" }),
            summary({ number: 2, updatedAt: "2026-06-16T02:00:00.000Z" }),
          ]),
        ),
      );
      const second = yield* sync.syncRepository({
        cwd: "/r",
        repositoryId: "repo",
        tokenIdentity: "gh",
        now: 2000,
      });
      return { first, second };
    }).pipe(Effect.provide(buildLayer(remote)), Effect.runPromise);

    expect(result.first.upserted).toBe(2);
    expect(result.second.upserted).toBe(1);
    expect(result.second.stopReason).toBe("watermark");
  });

  it("full sync skips unchanged rows and reconciles missing PRs", async () => {
    const remote = scriptedRemote();
    const pr1 = summary({ number: 1, updatedAt: "2026-06-16T01:00:00.000Z" });
    const pr2 = summary({ number: 2, updatedAt: "2026-06-16T02:00:00.000Z" });
    const pr3 = summary({ number: 3, updatedAt: "2026-06-16T03:00:00.000Z" });
    const result = await Effect.gen(function* () {
      yield* Migration0046;
      yield* Migration0047;
      const sync = yield* ReviewSync;
      const store = yield* ReviewPullRequestStore;
      yield* Effect.sync(() => remote.push(page([pr3, pr2, pr1])));
      yield* sync.syncRepository({
        cwd: "/r",
        repositoryId: "repo",
        tokenIdentity: "gh",
        now: 1000,
        mode: "full",
      });
      yield* Effect.sync(() => remote.push(page([pr2, pr1])));
      const second = yield* sync.syncRepository({
        cwd: "/r",
        repositoryId: "repo",
        tokenIdentity: "gh",
        now: 2000,
        mode: "full",
      });
      const lane = yield* store.getLane({ repositoryId: "repo", lane: "needs-review", limit: 10 });
      return { second, numbers: lane.map((pr) => pr.number).sort() };
    }).pipe(Effect.provide(buildLayer(remote)), Effect.runPromise);

    expect(result.second.upserted).toBe(0);
    expect(result.second.skippedUnchanged).toBe(2);
    expect(result.second.reconciled).toBe(true);
    expect(result.numbers).toEqual([1, 2]);
  });

  it("stops paginating when the budget drops below the reserve floor", async () => {
    const remote = scriptedRemote();
    const result = await Effect.gen(function* () {
      yield* Migration0046;
      yield* Migration0047;
      const sync = yield* ReviewSync;
      yield* Effect.sync(() =>
        remote.push(
          page([summary({ number: 1, updatedAt: "2026-06-16T01:00:00.000Z" })], {
            hasNextPage: true,
            endCursor: "cursor-1",
            budget: { cost: 50, remaining: 500, resetAt: 9_999_999 },
          }),
        ),
      );
      return yield* sync.syncRepository({
        cwd: "/r",
        repositoryId: "repo",
        tokenIdentity: "gh",
        now: 1000,
      });
    }).pipe(Effect.provide(buildLayer(remote)), Effect.runPromise);

    expect(result.stopReason).toBe("budget");
    expect(result.pagesFetched).toBe(1);
    expect(result.pointsRemaining).toBe(500);
  });

  it("records a backoff and stops gracefully when GitHub reports the limit exceeded", async () => {
    const remote = scriptedRemote();
    const result = await Effect.gen(function* () {
      yield* Migration0046;
      yield* Migration0047;
      const store = yield* ReviewPullRequestStore;
      const sync = yield* ReviewSync;
      yield* Effect.sync(() =>
        remote.push(
          new ReviewSyncError({
            operation: "fetchUpdatedPage",
            detail: "API rate limit already exceeded",
            rateLimited: true,
            resetAt: 50_000,
          }),
        ),
      );
      const syncResult = yield* sync.syncRepository({
        cwd: "/r",
        repositoryId: "repo",
        tokenIdentity: "gh",
        now: 1000,
      });
      const state = yield* store.getSyncState({ repositoryId: "repo" });
      return { syncResult, state };
    }).pipe(Effect.provide(buildLayer(remote)), Effect.runPromise);

    expect(result.syncResult.stopReason).toBe("rate-limited");
    expect(result.syncResult.pointsRemaining).toBe(0);
    expect(result.state._tag).toBe("Some");
    if (result.state._tag === "Some") {
      expect(result.state.value.pointsRemaining).toBe(0);
      expect(result.state.value.rateResetAt).toBe(50_000);
      expect(result.state.value.lastSyncedAt).toBe(1000);
    }
  });

  it("honors the recorded reset, then resumes once the window reopens", async () => {
    const remote = scriptedRemote();
    const result = await Effect.gen(function* () {
      yield* Migration0046;
      yield* Migration0047;
      const sync = yield* ReviewSync;
      yield* Effect.sync(() =>
        remote.push(
          new ReviewSyncError({
            operation: "fetchUpdatedPage",
            detail: "API rate limit already exceeded",
            rateLimited: true,
            resetAt: 50_000,
          }),
        ),
      );
      const limited = yield* sync.syncRepository({
        cwd: "/r",
        repositoryId: "repo",
        tokenIdentity: "gh",
        now: 1000,
      });
      // Within the window: must skip without touching the remote (no page scripted).
      const skipped = yield* sync.syncRepository({
        cwd: "/r",
        repositoryId: "repo",
        tokenIdentity: "gh",
        now: 20_000,
      });
      // Past the reset: a page is scripted and the scan proceeds.
      yield* Effect.sync(() =>
        remote.push(page([summary({ number: 7, updatedAt: "2026-06-17T00:00:00.000Z" })])),
      );
      const resumed = yield* sync.syncRepository({
        cwd: "/r",
        repositoryId: "repo",
        tokenIdentity: "gh",
        now: 60_000,
      });
      return { limited, skipped, resumed };
    }).pipe(Effect.provide(buildLayer(remote)), Effect.runPromise);

    expect(result.limited.stopReason).toBe("rate-limited");
    expect(result.skipped.stopReason).toBe("pre-budget-floor");
    expect(result.skipped.pagesFetched).toBe(0);
    expect(result.resumed.upserted).toBe(1);
    expect(result.resumed.stopReason).toBe("end");
  });

  it("skips the sync entirely while below the reserve floor and the window has not reset", async () => {
    const remote = scriptedRemote();
    const result = await Effect.gen(function* () {
      yield* Migration0046;
      yield* Migration0047;
      const store = yield* ReviewPullRequestStore;
      const sync = yield* ReviewSync;
      yield* store.upsertSyncState({
        repositoryId: "repo",
        tokenIdentity: "gh",
        pointsRemaining: 200,
        rateResetAt: 5_000_000,
      });
      // No scripted page: if the sync hit the remote it would fail.
      return yield* sync.syncRepository({
        cwd: "/r",
        repositoryId: "repo",
        tokenIdentity: "gh",
        now: 1000,
      });
    }).pipe(Effect.provide(buildLayer(remote)), Effect.runPromise);

    expect(result.stopReason).toBe("pre-budget-floor");
    expect(result.pagesFetched).toBe(0);
  });

  it("wipes the repo and resyncs when the token identity changes", async () => {
    const remote = scriptedRemote();
    const result = await Effect.gen(function* () {
      yield* Migration0046;
      yield* Migration0047;
      const store = yield* ReviewPullRequestStore;
      const sync = yield* ReviewSync;
      yield* store.upsertPullRequest({
        repositoryId: "repo",
        tokenIdentity: "old-token",
        syncedAt: 1,
        lane: "needs-review",
        contentHash: "h-old",
        summary: summary({ number: 99, updatedAt: "2026-06-15T00:00:00.000Z" }),
      });
      yield* store.upsertSyncState({
        repositoryId: "repo",
        tokenIdentity: "old-token",
        lastSeenUpdatedAt: "2026-06-15T00:00:00.000Z",
      });
      yield* Effect.sync(() =>
        remote.push(page([summary({ number: 5, updatedAt: "2026-06-16T05:00:00.000Z" })])),
      );
      yield* sync.syncRepository({
        cwd: "/r",
        repositoryId: "repo",
        tokenIdentity: "new-token",
        now: 2000,
      });
      const lane = yield* store.getLane({ repositoryId: "repo", lane: "needs-review", limit: 10 });
      return lane.map((pr) => pr.number).sort();
    }).pipe(Effect.provide(buildLayer(remote)), Effect.runPromise);

    expect(result).toEqual([5]);
  });
});
