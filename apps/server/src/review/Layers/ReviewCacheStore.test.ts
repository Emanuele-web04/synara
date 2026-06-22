import { describe, expect, it } from "vitest";
import { Effect, Exit, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import Migration0039 from "../../persistence/Migrations/039_ReviewCache.ts";
import { ReviewCacheStore } from "../Services/ReviewCacheStore.ts";
import { ReviewCacheStoreLive } from "./ReviewCacheStore.ts";

const layer = ReviewCacheStoreLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()));

describe("ReviewCacheStore", () => {
  it("reads and writes pull request list entries", async () => {
    const result = await Effect.gen(function* () {
      yield* Migration0039;
      const store = yield* ReviewCacheStore;
      yield* store.upsertPullRequestList({
        repositoryId: "repo",
        listFilter: JSON.stringify({ state: "open", limit: null }),
        data: { pullRequests: [] },
        fetchedAt: 100,
        ttlMs: 30_000,
        tokenIdentity: "gh",
      });
      return yield* store.getPullRequestList({
        repositoryId: "repo",
        listFilter: JSON.stringify({ state: "open", limit: null }),
      });
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.data.pullRequests).toEqual([]);
      expect(result.value.lastValidatedAt).toBe(100);
    }
  });

  it("returns a typed decode failure for corrupt cached JSON", async () => {
    const exit = await Effect.gen(function* () {
      yield* Migration0039;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO review_cache_pr_list (
          repository_id,
          list_filter,
          payload_json,
          fetched_at,
          last_validated_at,
          ttl_ms,
          token_identity
        )
        VALUES (
          ${"repo"},
          ${"open"},
          ${"{not json"},
          ${100},
          ${100},
          ${30_000},
          ${"gh"}
        )
      `;
      const store = yield* ReviewCacheStore;
      return yield* store.getPullRequestList({ repositoryId: "repo", listFilter: "open" });
    }).pipe(Effect.provide(layer), Effect.runPromiseExit);

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("bounds pull request list cache rows per repository", async () => {
    const result = await Effect.gen(function* () {
      yield* Migration0039;
      const store = yield* ReviewCacheStore;
      const sql = yield* SqlClient.SqlClient;

      for (const index of Array.from({ length: 70 }, (_, value) => value)) {
        yield* store.upsertPullRequestList({
          repositoryId: "repo",
          listFilter: JSON.stringify({ search: `query-${String(index)}` }),
          data: { pullRequests: [] },
          fetchedAt: 1_000 + index,
          ttlMs: 30_000,
          tokenIdentity: "gh",
        });
      }

      const rows = yield* sql<{ count: number }>`
        SELECT count(*) AS count
        FROM review_cache_pr_list
        WHERE repository_id = ${"repo"}
      `;
      const oldestRows = yield* sql<{ listFilter: string }>`
        SELECT list_filter AS "listFilter"
        FROM review_cache_pr_list
        WHERE repository_id = ${"repo"}
        ORDER BY fetched_at ASC
        LIMIT 1
      `;
      return {
        count: rows[0]?.count ?? 0,
        oldestListFilter: oldestRows[0]?.listFilter ?? "",
      };
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(result.count).toBe(64);
    expect(result.oldestListFilter).toBe(JSON.stringify({ search: "query-6" }));
  });

  it("repairs legacy cached changesets that predate patch provenance fields", async () => {
    const result = await Effect.gen(function* () {
      yield* Migration0039;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO review_cache_pr_diff (
          repository_id,
          reference,
          head_sha,
          payload_json,
          fetched_at,
          last_validated_at,
          ttl_ms,
          token_identity
        )
        VALUES (
          ${"repo"},
          ${"42"},
          ${"abc123"},
          ${JSON.stringify({
            target: { _tag: "pullRequest", repositoryId: "repo", number: 42 },
            patch: "diff --git a/a.ts b/a.ts\n",
            files: [],
            pullRequest: {
              number: 42,
              title: "Legacy cache",
              url: "https://github.com/example/repo/pull/42",
              baseBranch: "main",
              headBranch: "feature",
              state: "open",
            },
            headSha: "abc123",
          })},
          ${100},
          ${100},
          ${30_000},
          ${"gh"}
        )
      `;
      const store = yield* ReviewCacheStore;
      return yield* store.getPullRequestChangeset({
        repositoryId: "repo",
        reference: "42",
        headSha: "abc123",
      });
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.data.patchSignature).toHaveLength(16);
      expect(result.value.data.patchSource).toBe("github");
    }
  });
});
