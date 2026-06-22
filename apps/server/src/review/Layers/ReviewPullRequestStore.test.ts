import type { ReviewPullRequestSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import Migration0046 from "../../persistence/Migrations/046_ReviewPullRequests.ts";
import Migration0047 from "../../persistence/Migrations/047_ReviewReviewRequests.ts";
import { ReviewPullRequestStore } from "../Services/ReviewPullRequestStore.ts";
import { ReviewPullRequestStoreLive } from "./ReviewPullRequestStore.ts";

const layer = ReviewPullRequestStoreLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

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

describe("ReviewPullRequestStore", () => {
  it("upserts rows and reads a lane newest-first", async () => {
    const result = await Effect.gen(function* () {
      yield* Migration0046;
      yield* Migration0047;
      const store = yield* ReviewPullRequestStore;
      yield* store.upsertPullRequest({
        repositoryId: "repo",
        tokenIdentity: "gh",
        syncedAt: 100,
        lane: "needs-review",
        contentHash: "h1",
        summary: summary({ number: 1, updatedAt: "2026-06-16T00:00:00.000Z", labels: ["bug"] }),
      });
      yield* store.upsertPullRequest({
        repositoryId: "repo",
        tokenIdentity: "gh",
        syncedAt: 100,
        lane: "needs-review",
        contentHash: "h2",
        summary: summary({ number: 2, updatedAt: "2026-06-17T00:00:00.000Z" }),
      });
      return yield* store.getLane({ repositoryId: "repo", lane: "needs-review", limit: 10 });
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(result.map((pr) => pr.number)).toEqual([2, 1]);
    expect(result[1]?.labels).toEqual(["bug"]);
  });

  it("batch-upserts in one call and reports open existence cheaply", async () => {
    const result = await Effect.gen(function* () {
      yield* Migration0046;
      yield* Migration0047;
      const store = yield* ReviewPullRequestStore;
      const before = yield* store.hasOpenPullRequests({ repositoryId: "repo" });
      yield* store.upsertPullRequests([
        {
          repositoryId: "repo",
          tokenIdentity: "gh",
          syncedAt: 100,
          lane: "needs-review",
          contentHash: "h1",
          summary: summary({ number: 1, labels: ["bug"] }),
        },
        {
          repositoryId: "repo",
          tokenIdentity: "gh",
          syncedAt: 100,
          lane: "approved",
          contentHash: "h2",
          summary: summary({ number: 2, reviewDecision: "APPROVED" }),
        },
      ]);
      const after = yield* store.hasOpenPullRequests({ repositoryId: "repo" });
      const lane = yield* store.getLane({ repositoryId: "repo", lane: "needs-review", limit: 10 });
      return {
        before,
        after,
        laneNumbers: lane.map((pr) => pr.number),
        laneLabels: lane[0]?.labels,
      };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(result.before).toBe(false);
    expect(result.after).toBe(true);
    expect(result.laneNumbers).toEqual([1]);
    expect(result.laneLabels).toEqual(["bug"]);
  });

  it("upsert replaces label children and clears a tombstone", async () => {
    const result = await Effect.gen(function* () {
      yield* Migration0046;
      yield* Migration0047;
      const store = yield* ReviewPullRequestStore;
      yield* store.upsertPullRequest({
        repositoryId: "repo",
        tokenIdentity: "gh",
        syncedAt: 100,
        lane: "approved",
        contentHash: "h1",
        summary: summary({ number: 7, reviewDecision: "APPROVED", labels: ["bug", "p1"] }),
      });
      yield* store.tombstoneExcept({ repositoryId: "repo", keepNumbers: [], at: 200 });
      const afterTombstone = yield* store.getLane({
        repositoryId: "repo",
        lane: "approved",
        limit: 10,
      });
      yield* store.upsertPullRequest({
        repositoryId: "repo",
        tokenIdentity: "gh",
        syncedAt: 300,
        lane: "approved",
        contentHash: "h2",
        summary: summary({ number: 7, reviewDecision: "APPROVED", labels: ["p2"] }),
      });
      const afterReupsert = yield* store.getLane({
        repositoryId: "repo",
        lane: "approved",
        limit: 10,
      });
      return { afterTombstone, afterReupsert };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(result.afterTombstone).toHaveLength(0);
    expect(result.afterReupsert).toHaveLength(1);
    expect(result.afterReupsert[0]?.labels).toEqual(["p2"]);
  });

  it("reconciles via tombstoneExcept and reports open content hashes", async () => {
    const result = await Effect.gen(function* () {
      yield* Migration0046;
      yield* Migration0047;
      const store = yield* ReviewPullRequestStore;
      for (const number of [1, 2, 3]) {
        yield* store.upsertPullRequest({
          repositoryId: "repo",
          tokenIdentity: "gh",
          syncedAt: 100,
          lane: "needs-review",
          contentHash: `h${String(number)}`,
          summary: summary({ number }),
        });
      }
      yield* store.tombstoneExcept({ repositoryId: "repo", keepNumbers: [1, 3], at: 200 });
      const lane = yield* store.getLane({ repositoryId: "repo", lane: "needs-review", limit: 10 });
      const hashes = yield* store.getOpenContentHashes({ repositoryId: "repo" });
      return { numbers: lane.map((pr) => pr.number).sort(), hashes };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(result.numbers).toEqual([1, 3]);
    expect(result.hashes.get(2)).toBeUndefined();
    expect(result.hashes.get(1)).toBe("h1");
  });

  it("queries by author, label, base, and lane with SQL filters", async () => {
    const result = await Effect.gen(function* () {
      yield* Migration0046;
      yield* Migration0047;
      const store = yield* ReviewPullRequestStore;
      const seed = [
        {
          number: 1,
          lane: "needs-review",
          overrides: { author: "alice", baseBranch: "main", labels: ["bug"] },
        },
        {
          number: 2,
          lane: "needs-review",
          overrides: { author: "bob", baseBranch: "main", labels: ["feat"] },
        },
        {
          number: 3,
          lane: "approved",
          overrides: { author: "alice", baseBranch: "release", labels: ["bug"] },
        },
      ] as const;
      for (const item of seed) {
        yield* store.upsertPullRequest({
          repositoryId: "repo",
          tokenIdentity: "gh",
          syncedAt: 100,
          lane: item.lane,
          contentHash: `h${String(item.number)}`,
          summary: summary({ number: item.number, ...item.overrides }),
        });
      }
      const byAuthor = yield* store.queryPullRequests({
        repositoryId: "repo",
        state: "open",
        authors: ["alice"],
        sort: "updated",
        limit: 10,
      });
      const byLabel = yield* store.queryPullRequests({
        repositoryId: "repo",
        state: "open",
        labels: ["bug"],
        sort: "updated",
        limit: 10,
      });
      const byBaseAndLane = yield* store.queryPullRequests({
        repositoryId: "repo",
        state: "open",
        baseBranches: ["main"],
        lanes: ["needs-review"],
        sort: "updated",
        limit: 10,
      });
      return {
        byAuthor: byAuthor.map((pr) => pr.number).sort(),
        byLabel: byLabel.map((pr) => pr.number).sort(),
        byBaseAndLane: byBaseAndLane.map((pr) => pr.number).sort(),
      };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(result.byAuthor).toEqual([1, 3]);
    expect(result.byLabel).toEqual([1, 3]);
    expect(result.byBaseAndLane).toEqual([1, 2]);
  });

  it("queries by requested reviewer with an EXISTS join", async () => {
    const result = await Effect.gen(function* () {
      yield* Migration0046;
      yield* Migration0047;
      const store = yield* ReviewPullRequestStore;
      yield* store.upsertPullRequest({
        repositoryId: "repo",
        tokenIdentity: "gh",
        syncedAt: 100,
        lane: "needs-review",
        contentHash: "h1",
        summary: summary({ number: 1, reviewRequests: ["tyler"] }),
      });
      yield* store.upsertPullRequest({
        repositoryId: "repo",
        tokenIdentity: "gh",
        syncedAt: 100,
        lane: "needs-review",
        contentHash: "h2",
        summary: summary({ number: 2, reviewRequests: ["alice"] }),
      });
      const matched = yield* store.queryPullRequests({
        repositoryId: "repo",
        state: "open",
        reviewRequested: "tyler",
        sort: "updated",
        limit: 10,
      });
      return matched.map((pr) => pr.number);
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(result).toEqual([1]);
  });

  it("round-trips sync state and keeps existing values on partial update", async () => {
    const result = await Effect.gen(function* () {
      yield* Migration0046;
      yield* Migration0047;
      const store = yield* ReviewPullRequestStore;
      yield* store.upsertSyncState({
        repositoryId: "repo",
        tokenIdentity: "gh",
        lastSeenUpdatedAt: "2026-06-16T00:00:00.000Z",
        pointsRemaining: 4800,
      });
      yield* store.upsertSyncState({
        repositoryId: "repo",
        tokenIdentity: "gh",
        lastSyncedAt: 12345,
      });
      return yield* store.getSyncState({ repositoryId: "repo" });
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.lastSeenUpdatedAt).toBe("2026-06-16T00:00:00.000Z");
      expect(result.value.pointsRemaining).toBe(4800);
      expect(result.value.lastSyncedAt).toBe(12345);
    }
  });

  it("clears a repository", async () => {
    const result = await Effect.gen(function* () {
      yield* Migration0046;
      yield* Migration0047;
      const store = yield* ReviewPullRequestStore;
      yield* store.upsertPullRequest({
        repositoryId: "repo",
        tokenIdentity: "gh",
        syncedAt: 100,
        lane: "draft",
        contentHash: "h1",
        summary: summary({ number: 9, isDraft: true }),
      });
      yield* store.upsertSyncState({ repositoryId: "repo", tokenIdentity: "gh" });
      yield* store.clearRepository({ repositoryId: "repo" });
      const lane = yield* store.getLane({ repositoryId: "repo", lane: "draft", limit: 10 });
      const state = yield* store.getSyncState({ repositoryId: "repo" });
      return { lane, state };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(result.lane).toHaveLength(0);
    expect(Option.isNone(result.state)).toBe(true);
  });
});
