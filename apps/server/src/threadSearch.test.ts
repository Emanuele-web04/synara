// FILE: threadSearch.test.ts
// Purpose: Focused coverage for the palette's message-content search SQL against the migrated SQLite schema.
// Layer: Server read query tests

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { buildThreadSearchExcerpt, ThreadSearchQuery, ThreadSearchQueryLive } from "./threadSearch";

function runSearchTest<A, E>(effect: Effect.Effect<A, E, ThreadSearchQuery | SqlClient.SqlClient>) {
  const layer = ThreadSearchQueryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  );
  return effect.pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
}

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, kind, created_at, updated_at, deleted_at
    )
    VALUES
      ('project-app', 'App', '/work/app', '{}', 'project',
        '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.000Z', NULL),
      ('project-gone', 'Gone', '/work/gone', '{}', 'project',
        '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.000Z', '2026-09-02T09:00:00.000Z')
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, env_mode, created_at, updated_at, deleted_at, archived_at, parent_thread_id
    )
    VALUES
      ('thread-old', 'project-app', 'Old', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', 'local',
        '2026-01-01T09:00:00.000Z', '2026-01-02T09:00:00.000Z', NULL, NULL, NULL),
      ('thread-new', 'project-app', 'New', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', 'local',
        '2026-09-01T09:00:00.000Z', '2026-09-03T09:00:00.000Z', NULL, NULL, NULL),
      ('thread-archived', 'project-app', 'Archived', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', 'local',
        '2026-09-01T09:00:00.000Z', '2026-09-03T09:00:00.000Z', NULL, '2026-09-04T09:00:00.000Z', NULL),
      ('thread-deleted', 'project-app', 'Deleted', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', 'local',
        '2026-09-01T09:00:00.000Z', '2026-09-03T09:00:00.000Z', '2026-09-04T09:00:00.000Z', NULL, NULL),
      ('thread-child', 'project-app', 'Child', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', 'local',
        '2026-09-01T09:00:00.000Z', '2026-09-03T09:00:00.000Z', NULL, NULL, 'thread-new'),
      ('thread-gone-project', 'project-gone', 'Gone', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', 'local',
        '2026-09-01T09:00:00.000Z', '2026-09-03T09:00:00.000Z', NULL, NULL, NULL)
  `;
  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, source, created_at, updated_at
    )
    VALUES
      ('m-old-1', 'thread-old', NULL, 'assistant', 'The Refund webhook retries three times', 0, 'native',
        '2026-01-01T09:00:00.000Z', '2026-01-01T09:00:00.000Z'),
      ('m-old-2', 'thread-old', NULL, 'user', 'why does the refund webhook fail?', 0, 'native',
        '2026-01-01T08:00:00.000Z', '2026-01-01T08:00:00.000Z'),
      ('m-new-1', 'thread-new', NULL, 'assistant', 'webhook for refund is wired', 0, 'native',
        '2026-09-02T09:00:00.000Z', '2026-09-02T09:00:00.000Z'),
      ('m-new-2', 'thread-new', NULL, 'assistant', 'refund webhook still streaming', 1, 'native',
        '2026-09-02T10:00:00.000Z', '2026-09-02T10:00:00.000Z'),
      ('m-new-3', 'thread-new', NULL, 'system', 'refund webhook system note', 0, 'native',
        '2026-09-02T11:00:00.000Z', '2026-09-02T11:00:00.000Z'),
      ('m-archived', 'thread-archived', NULL, 'user', 'refund webhook', 0, 'native',
        '2026-09-02T09:00:00.000Z', '2026-09-02T09:00:00.000Z'),
      ('m-deleted', 'thread-deleted', NULL, 'user', 'refund webhook', 0, 'native',
        '2026-09-02T09:00:00.000Z', '2026-09-02T09:00:00.000Z'),
      ('m-child', 'thread-child', NULL, 'user', 'refund webhook', 0, 'native',
        '2026-09-02T09:00:00.000Z', '2026-09-02T09:00:00.000Z'),
      ('m-gone', 'thread-gone-project', NULL, 'user', 'refund webhook', 0, 'native',
        '2026-09-02T09:00:00.000Z', '2026-09-02T09:00:00.000Z'),
      ('m-like', 'thread-old', NULL, 'assistant', 'progress at 100% done', 0, 'native',
        '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z')
  `;
});

describe("ThreadSearchQuery", () => {
  it("returns one match per live top-level thread, newest thread first", async () => {
    const result = await runSearchTest(
      Effect.gen(function* () {
        yield* seed;
        const search = yield* ThreadSearchQuery;
        return yield* search.searchThreads({ query: "Refund  WEBHOOK" });
      }),
    );

    expect(result.matches).toEqual([
      { threadId: "thread-new", excerpt: "webhook for refund is wired", matchCount: 1 },
      { threadId: "thread-old", excerpt: "why does the refund webhook fail?", matchCount: 2 },
    ]);
  });

  it("treats LIKE wildcards in the query literally and honors the limit", async () => {
    const result = await runSearchTest(
      Effect.gen(function* () {
        yield* seed;
        const search = yield* ThreadSearchQuery;
        return {
          percent: yield* search.searchThreads({ query: "100%" }),
          wildcard: yield* search.searchThreads({ query: "1_0" }),
          limited: yield* search.searchThreads({ query: "webhook", limit: 1 }),
        };
      }),
    );

    expect(result.percent.matches.map((match) => match.threadId)).toEqual(["thread-old"]);
    expect(result.wildcard.matches).toEqual([]);
    expect(result.limited.matches.map((match) => match.threadId)).toEqual(["thread-new"]);
  });

  it("reads JSON-encoded bodies", async () => {
    const result = await runSearchTest(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          UPDATE projection_thread_messages
          SET text = '', text_json = ${JSON.stringify("encoded needle\u0000body")}
          WHERE message_id = 'm-new-1'
        `;
        const search = yield* ThreadSearchQuery;
        return yield* search.searchThreads({ query: "needle" });
      }),
    );

    expect(result.matches.map((match) => match.threadId)).toEqual(["thread-new"]);
  });
});

describe("buildThreadSearchExcerpt", () => {
  it("windows long bodies around the first hit", () => {
    const text = `${"lead ".repeat(200)}the needle sits here ${"tail ".repeat(200)}`;
    const excerpt = buildThreadSearchExcerpt(text, "needle", ["needle"]);

    expect(excerpt.length).toBeLessThanOrEqual(320);
    expect(excerpt.startsWith("...")).toBe(true);
    expect(excerpt.endsWith("...")).toBe(true);
    expect(excerpt).toContain("the needle sits here");
  });
});
