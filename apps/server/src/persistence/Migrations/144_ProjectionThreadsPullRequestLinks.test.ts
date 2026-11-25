import { assert, it } from "@effect/vitest";
import { ThreadId } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadRepositoryLive } from "../Layers/ProjectionThreads.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import migration from "./144_ProjectionThreadsPullRequestLinks.ts";

const pullRequest = {
  number: 7,
  title: "Keep links",
  url: "https://github.com/acme/app/pull/7",
  baseBranch: "main",
  headBranch: "feat/links",
  state: "open",
};

const insertThread = (sql: SqlClient.SqlClient, threadId: string, lastKnownPr: string | null) =>
  sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json,
    last_known_pr_json, created_at, updated_at)
  VALUES (${threadId}, 'project', 'Thread', '{"provider":"codex","model":"gpt-5-codex"}',
    ${lastKnownPr}, '2026-11-13T09:00:00.000Z', '2026-11-13T10:00:00.000Z')`;

const readLinks = (sql: SqlClient.SqlClient) =>
  sql<{ readonly threadId: string; readonly links: string | null; readonly pr: string | null }>`
    SELECT thread_id AS "threadId", pull_requests_json AS links, last_known_pr_json AS pr
    FROM projection_threads ORDER BY thread_id`;

it.effect("backfills one legacy link per valid PR, skips malformed rows, and replays safely", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 143 });
    yield* insertThread(sql, "a-object", JSON.stringify(pullRequest));
    yield* insertThread(sql, "b-none", null);
    yield* insertThread(sql, "c-malformed", "{not json");
    yield* insertThread(sql, "d-array", "[1,2]");
    yield* insertThread(sql, "e-string", '"text"');
    yield* runMigrations({ toMigrationInclusive: 144 });

    const rows = yield* readLinks(sql);
    assert.deepStrictEqual(JSON.parse(rows[0]!.links!), [
      { pullRequest, source: "legacy", linkedAt: "2026-11-13T10:00:00.000Z" },
    ]);
    assert.deepStrictEqual(
      rows.slice(1).map((row) => [row.threadId, row.links]),
      [
        ["b-none", null],
        ["c-malformed", null],
        ["d-array", null],
        ["e-string", null],
      ],
    );
    // Every PR slot is left exactly as it was.
    assert.deepStrictEqual(
      rows.map((row) => row.pr),
      [JSON.stringify(pullRequest), null, "{not json", "[1,2]", '"text"'],
    );

    // A lineage reconcile can replay the migration: links written since are kept.
    const linked = JSON.stringify([
      { pullRequest, source: "agent", linkedAt: "2026-11-13T11:00:00.000Z" },
    ]);
    yield* sql`UPDATE projection_threads SET pull_requests_json = ${linked} WHERE thread_id = 'a-object'`;
    yield* migration;
    assert.equal((yield* readLinks(sql))[0]!.links, linked);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("keeps links this build cannot decode through a whole-row upsert", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectionThreadRepository;
    yield* runMigrations({ toMigrationInclusive: 144 });
    yield* insertThread(sql, "future", JSON.stringify(pullRequest));
    const future = JSON.stringify([
      { pullRequest, source: "agent", linkedAt: "2026-11-13T11:00:00.000Z" },
      { pullRequest: { ...pullRequest, number: 8 }, source: "future-source", linkedAt: "x" },
    ]);
    yield* sql`UPDATE projection_threads SET pull_requests_json = ${future}`;

    const row = Option.getOrThrow(
      yield* repository.getById({ threadId: ThreadId.makeUnsafe("future") }),
    );
    // Undecodable lists read as "unknown" so callers fall back to the legacy slot.
    assert.isNull(row.pullRequests ?? null);
    yield* repository.upsert({ ...row, title: "Renamed" });

    const [stored] = yield* readLinks(sql);
    assert.equal(stored!.links, future);
  }).pipe(
    Effect.provide(
      ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
    ),
  ),
);
