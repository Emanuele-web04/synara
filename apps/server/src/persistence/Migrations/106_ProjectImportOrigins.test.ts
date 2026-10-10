import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@synara/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../NodeSqliteClient";
import { makeProjectImportRepository } from "../projectImportRepository";
import migration from "./106_ProjectImportOrigins";

it.layer(NodeSqliteClient.layerMemory())("project import origins", (it) => {
  it.effect("retains the first target and completion across retries and repeated migration", () =>
    Effect.gen(function* () {
      yield* migration;
      const repository = yield* makeProjectImportRepository;
      const origin = {
        sourceKey: "origin",
        provider: "codex" as const,
        sourceHome: "/codex",
        externalId: "native",
        projectId: ProjectId.makeUnsafe("project"),
        threadId: ThreadId.makeUnsafe("thread"),
        status: "pending" as const,
        createdAt: "2026-09-16T00:00:00.000Z",
      };
      yield* repository.reserve(origin);
      yield* repository.reserve({ ...origin, threadId: ThreadId.makeUnsafe("duplicate") });
      assert.deepEqual(yield* repository.find("origin"), origin);
      yield* repository.complete("origin");
      yield* migration;
      assert.deepEqual(yield* repository.list(), [{ ...origin, status: "completed" }]);
      const sql = yield* SqlClient.SqlClient;
      const duplicate = yield* Effect.result(sql`
      INSERT INTO project_import_origins VALUES ('other', 'codex', '/codex', 'native', 'p', 't', 'pending', 'date')
    `);
      assert.equal(duplicate._tag, "Failure");

      const replacement = {
        ...origin,
        projectId: ProjectId.makeUnsafe("replacement-project"),
        threadId: ThreadId.makeUnsafe("replacement-thread"),
        createdAt: "2026-09-17T00:00:00.000Z",
      };
      assert.deepEqual(yield* repository.reserve(replacement, origin.threadId), replacement);
      // a stale recovery attempt must not overwrite the replacement reservation
      assert.equal(yield* repository.reserve(origin, origin.threadId), undefined);
      assert.deepEqual(yield* repository.find("origin"), replacement);
      yield* repository.complete("origin");
      assert.deepEqual(yield* repository.list(), [{ ...replacement, status: "completed" }]);
    }),
  );
});
