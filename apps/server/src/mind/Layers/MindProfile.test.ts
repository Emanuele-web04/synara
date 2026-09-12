import { assert, it } from "@effect/vitest";
import { MIND_RECALL_HYGIENE_NOTE, ProjectId } from "@synara/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import { MindRepositoryLive } from "../../persistence/Layers/MindRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MindRepository } from "../../persistence/Services/MindRepository.ts";
import { MindService } from "../Services/MindService.ts";
import { MindServiceLive } from "./MindService.ts";

const layer = it.layer(
  MindServiceLive.pipe(
    Layer.provideMerge(MindRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

// Operation receipts and profiles reference projection_projects, so tests seed
// the project row before any service call (mirrors MindService.test.ts).
const ensureProjectRow = (projectId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id,
        title,
        workspace_root,
        scripts_json,
        created_at,
        updated_at
      )
      VALUES (
        ${projectId},
        'Mind profile test project',
        '/tmp/mind-profile-test',
        '[]',
        '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z'
      )
      ON CONFLICT (project_id) DO NOTHING
    `;
  });

// The suite shares one in-memory database, so every test owns a unique project.
const PROJECTS = {
  roundTrip: "project-mind-profile-round-trip",
  optGate: "project-mind-profile-opt-gate",
  emptyOptOut: "project-mind-profile-empty-opt-out",
  secret: "project-mind-profile-secret",
  revisions: "project-mind-profile-revisions",
  excluded: "project-mind-profile-excluded",
} as const;

layer("MindProfile", (it) => {
  it.effect("profileGet returns null before any save, then round-trips set/get", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.roundTrip);
      yield* ensureProjectRow(PROJECTS.roundTrip);

      assert.isNull(yield* service.profileGet({ projectId }));

      const saved = yield* service.profileSet({
        projectId,
        text: "  Uses bun, prefers small diffs.  ",
        optedIn: true,
      });
      assert.strictEqual(saved.text, "Uses bun, prefers small diffs.");
      assert.strictEqual(saved.optedIn, true);

      const loaded = yield* service.profileGet({ projectId });
      assert.deepStrictEqual(loaded, saved);

      const status = yield* service.status({ projectId });
      assert.strictEqual(status.profileOptedIn, true);
    }),
  );

  it.effect("the recall digest carries the framed profile block only while opted in", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.optGate);
      yield* ensureProjectRow(PROJECTS.optGate);

      // No profile yet: plain digest, hygiene note intact, no profile frame.
      const bare = yield* service.recall({ projectId });
      assert.strictEqual(bare.note, MIND_RECALL_HYGIENE_NOTE);
      assert.isFalse(bare.digest.includes("Profile:"));

      yield* service.profileSet({ projectId, text: "Deploys on Fridays.", optedIn: true });
      yield* service.remember({
        projectId,
        text: "Friday deploys need a buddy.",
        type: "decision",
        actor: { kind: "user" },
        threadId: null,
        turnId: null,
      });
      const included = yield* service.recall({ projectId });
      assert.strictEqual(included.note, MIND_RECALL_HYGIENE_NOTE);
      assert.isTrue(included.digest.endsWith("\nProfile:\n- Deploys on Fridays."));
      assert.isTrue(included.digest.length <= 800);
      const queried = yield* service.recall({ projectId, query: "nomatchqueryxyz" });
      assert.isTrue(queried.digest.includes("Profile:\n- Deploys on Fridays."));

      // Opting out keeps the last text but drops the digest block.
      const optedOut = yield* service.profileSet({ projectId, text: "   ", optedIn: false });
      assert.strictEqual(optedOut.text, "Deploys on Fridays.");
      assert.strictEqual(optedOut.optedIn, false);
      const excluded = yield* service.recall({ projectId });
      assert.isFalse(excluded.digest.includes("Profile:"));
      assert.isFalse(excluded.digest.includes("Deploys on Fridays."));
      const status = yield* service.status({ projectId });
      assert.strictEqual(status.profileOptedIn, false);
    }),
  );

  it.effect("opting out with no prior profile is rejected as empty", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.emptyOptOut);
      yield* ensureProjectRow(PROJECTS.emptyOptOut);

      const empty = yield* Effect.flip(
        service.profileSet({ projectId, text: "   ", optedIn: false }),
      );
      assert.strictEqual(empty._tag, "MindInvalidTextError");
      assert.isNull(yield* service.profileGet({ projectId }));

      const long = yield* Effect.flip(
        service.profileSet({ projectId, text: "x".repeat(501), optedIn: true }),
      );
      assert.strictEqual(long._tag, "MindInvalidTextError");
    }),
  );

  it.effect("profileSet rejects secret-shaped text without writing", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.secret);
      yield* ensureProjectRow(PROJECTS.secret);

      const rejected = yield* Effect.flip(
        service.profileSet({ projectId, text: "deploy api_key: abcdefghij", optedIn: true }),
      );
      assert.strictEqual(rejected._tag, "MindSecretRejectedError");
      assert.isNull(yield* service.profileGet({ projectId }));
      assert.deepStrictEqual(yield* repository.listProfileRevisions({ projectId }), []);
    }),
  );

  it.effect("a text change records hash-only revision evidence, an opt-only flip does not", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.revisions);
      yield* ensureProjectRow(PROJECTS.revisions);

      yield* service.profileSet({ projectId, text: "first profile", optedIn: true });
      yield* service.profileSet({ projectId, text: "first profile", optedIn: false });
      const afterFlip = yield* repository.listProfileRevisions({ projectId });
      assert.lengthOf(afterFlip, 1);
      assert.strictEqual(afterFlip[0]?.actor.kind, "user");

      yield* service.profileSet({ projectId, text: "second profile", optedIn: false });
      const afterEdit = yield* repository.listProfileRevisions({ projectId });
      assert.lengthOf(afterEdit, 2);

      // Revision rows carry hashes only — never profile text.
      const sql = yield* SqlClient.SqlClient;
      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('mind_profile_revisions')
      `;
      assert.notInclude(
        columns.map(({ name }) => name),
        "text",
      );
    }),
  );

  it.effect("profiles stay out of the memory list, count, cap, and journal", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.excluded);
      yield* ensureProjectRow(PROJECTS.excluded);

      yield* service.profileSet({ projectId, text: "only a profile", optedIn: true });

      const list = yield* service.list({ projectId });
      assert.deepStrictEqual(list.memories, []);
      assert.strictEqual(list.count, 0);
      const all = yield* service.listAll();
      assert.isFalse(all.memories.some((memory) => memory.text === "only a profile"));
      const status = yield* service.status({ projectId });
      assert.strictEqual(status.count, 0);

      // The profile write itself journals nothing: the journal count is
      // unchanged by a second save on this project.
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM mind_journal
      `;
      yield* service.profileSet({ projectId, text: "only a profile", optedIn: false });
      const after = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM mind_journal
      `;
      assert.deepStrictEqual(after, before);
    }),
  );
});
