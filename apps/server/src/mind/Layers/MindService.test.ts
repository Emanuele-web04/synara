import { assert, it } from "@effect/vitest";
import {
  MIND_MEMORY_PROJECT_CAP,
  MIND_RECALL_HYGIENE_NOTE,
  MindMemoryId,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Clock, Duration, Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";

import { runMigrations } from "../../persistence/Migrations.ts";
import { MindRepositoryLive } from "../../persistence/Layers/MindRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  MindRepository,
  type InsertMindMemoryInput,
} from "../../persistence/Services/MindRepository.ts";
import { MindService } from "../Services/MindService.ts";
import type { MindRememberRequest } from "../Services/MindService.ts";
import { MindServiceLive } from "./MindService.ts";

const layer = it.layer(
  MindServiceLive.pipe(
    Layer.provideMerge(MindRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const DAY_MS = 86_400_000;

// Operation receipts reference projection_projects, so tests seed the project
// row before any service call that records a receipt.
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
        'Mind service test project',
        '/tmp/mind-service-test',
        '[]',
        '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z'
      )
      ON CONFLICT (project_id) DO NOTHING
    `;
  });

// The suite shares one in-memory database and one service instance (with its
// in-memory sweep schedule), so every test owns a unique project.
const PROJECTS = {
  remember: "project-mind-service-remember",
  retry: "project-mind-service-retry",
  pureRead: "project-mind-service-pure-read",
  digest: "project-mind-service-digest",
  rank: "project-mind-service-rank",
  confirm: "project-mind-service-confirm",
  cap: "project-mind-service-cap",
  secret: "project-mind-service-secret",
  prune: "project-mind-service-prune",
  forget: "project-mind-service-forget",
  affirm: "project-mind-service-affirm",
  ui: "project-mind-service-ui",
  pinSweep: "project-mind-service-pin-sweep",
  xproject: "project-mind-service-xproject",
  poison: "project-mind-service-poison",
  gc: "project-mind-service-gc",
  sweepBound: "project-mind-service-sweep-bound",
  ftsEdge: "project-mind-service-fts-edge",
  queryLimit: "project-mind-service-query-limit",
  update: "project-mind-service-update",
  updateDupe: "project-mind-service-update-dupe",
  updateSecret: "project-mind-service-update-secret",
  updateRetry: "project-mind-service-update-retry",
  history: "project-mind-service-history",
  historyEmpty: "project-mind-service-history-empty",
} as const;

let memoryCounter = 0;
const seedMemory = (overrides: Partial<InsertMindMemoryInput> = {}) =>
  Effect.gen(function* () {
    const repository = yield* MindRepository;
    memoryCounter += 1;
    const nowIso = new Date(yield* Clock.currentTimeMillis).toISOString();
    return yield* repository.insert({
      memoryId: MindMemoryId.makeUnsafe(`memory-${memoryCounter}`),
      projectId: ProjectId.makeUnsafe(PROJECTS.remember),
      text: `seed fact ${memoryCounter}`,
      type: "semantic",
      textHash: `hash-${memoryCounter}`,
      peakWeight: 0.6,
      accessCount: 0,
      pinned: false,
      createdAt: nowIso,
      lastAccessedAt: nowIso,
      provenance: { kind: "user" },
      ...overrides,
    });
  });

const agentActor = { kind: "agent" as const, provider: "codex" as const };
const threadId = ThreadId.makeUnsafe("thread-mind-service");
const rememberRequest = (
  projectId: ProjectId,
  text: string,
  overrides: Partial<MindRememberRequest> = {},
): MindRememberRequest => ({
  projectId,
  text,
  type: "semantic",
  actor: agentActor,
  threadId,
  turnId: "turn-1",
  ...overrides,
});

layer("MindService", (it) => {
  it.effect(
    "remember creates at INITIAL_WEIGHT, normalizes text, and reinforces duplicates as confirms",
    () =>
      Effect.gen(function* () {
        const service = yield* MindService;
        const repository = yield* MindRepository;
        yield* runMigrations();
        const projectId = ProjectId.makeUnsafe(PROJECTS.remember);
        yield* ensureProjectRow(PROJECTS.remember);

        const first = yield* service.remember(
          rememberRequest(projectId, "Use bun run test, never bun test.", {
            turnId: "turn-create",
          }),
        );
        assert.strictEqual(first.created, true);
        assert.strictEqual(first.reinforced, false);
        assert.strictEqual(first.replayed, false);
        const row = Option.getOrThrow(yield* repository.getById({ memoryId: first.memoryId }));
        assert.strictEqual(row.peakWeight, 0.6);
        assert.strictEqual(row.accessCount, 0);
        assert.strictEqual(row.text, "Use bun run test, never bun test.");
        assert.strictEqual(row.provenance.kind, "agent");
        if (row.provenance.kind === "agent") {
          assert.strictEqual(row.provenance.provider, "codex");
          assert.strictEqual(row.provenance.threadId, "thread-mind-service");
        }

        // Same text with surrounding whitespace normalizes to the same hash:
        // one row, reinforced as a confirm (+0.15, access count bumped).
        const second = yield* service.remember(
          rememberRequest(projectId, "  Use bun run test, never bun test.  ", {
            turnId: "turn-reinforce",
          }),
        );
        assert.strictEqual(second.created, false);
        assert.strictEqual(second.reinforced, true);
        assert.strictEqual(second.replayed, false);
        assert.strictEqual(second.memoryId, first.memoryId);
        assert.strictEqual(yield* repository.countByProject({ projectId }), 1);
        const reinforced = Option.getOrThrow(
          yield* repository.getById({ memoryId: first.memoryId }),
        );
        assert.strictEqual(reinforced.peakWeight, 0.75);
        assert.strictEqual(reinforced.accessCount, 1);
        assert.isTrue(
          Option.isSome(
            yield* repository.findJournalOp({
              memoryId: first.memoryId,
              op: "remember",
              turnId: "turn-reinforce",
            }),
          ),
        );
      }),
  );

  it.effect(
    "remember retries with the same turn replay the durable result without double bumping",
    () =>
      Effect.gen(function* () {
        const service = yield* MindService;
        const repository = yield* MindRepository;
        yield* runMigrations();
        const projectId = ProjectId.makeUnsafe(PROJECTS.retry);
        yield* ensureProjectRow(PROJECTS.retry);
        const text = "Deploy ports offset via SYNARA_PORT_OFFSET";

        const first = yield* service.remember(
          rememberRequest(projectId, text, { turnId: "turn-retry" }),
        );
        assert.strictEqual(first.created, true);

        const retry = yield* service.remember(
          rememberRequest(projectId, text, { turnId: "turn-retry" }),
        );
        assert.strictEqual(retry.replayed, true);
        assert.strictEqual(retry.created, true);
        assert.strictEqual(retry.memoryId, first.memoryId);
        const row = Option.getOrThrow(yield* repository.getById({ memoryId: first.memoryId }));
        assert.strictEqual(row.peakWeight, 0.6);
        assert.strictEqual(row.accessCount, 0);

        // Crash-recovery replay: with the receipt gone, the journal row still
        // proves this turn remembered this text and replays without re-applying.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM mind_operation_receipts WHERE project_id = ${projectId}`;
        const journalReplay = yield* service.remember(
          rememberRequest(projectId, text, { turnId: "turn-retry" }),
        );
        assert.strictEqual(journalReplay.replayed, true);
        assert.strictEqual(journalReplay.created, true);
        const after = Option.getOrThrow(yield* repository.getById({ memoryId: first.memoryId }));
        assert.strictEqual(after.peakWeight, 0.6);
        assert.strictEqual(after.accessCount, 0);
      }),
  );

  it.effect("recall is a pure read: weights, access counts, and decay anchors never move", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.pureRead);
      yield* ensureProjectRow(PROJECTS.pureRead);
      const a = yield* service.remember(
        rememberRequest(projectId, "Use bun run test, never bun test.", {
          turnId: "turn-pure-a",
        }),
      );
      const b = yield* service.remember(
        rememberRequest(projectId, "Mind pins survive decay", { turnId: "turn-pure-b" }),
      );
      const beforeA = Option.getOrThrow(yield* repository.getById({ memoryId: a.memoryId }));
      const beforeB = Option.getOrThrow(yield* repository.getById({ memoryId: b.memoryId }));

      const digest = yield* service.recall({ projectId });
      assert.strictEqual(digest.note, MIND_RECALL_HYGIENE_NOTE);
      assert.strictEqual(digest.items.length, 2);
      const queried = yield* service.recall({ projectId, query: "bun" });
      assert.isTrue(queried.items.length >= 1);

      assert.deepStrictEqual(
        Option.getOrThrow(yield* repository.getById({ memoryId: a.memoryId })),
        beforeA,
      );
      assert.deepStrictEqual(
        Option.getOrThrow(yield* repository.getById({ memoryId: b.memoryId })),
        beforeB,
      );
    }),
  );

  it.effect("digest caps at 8 items, 800 chars, and escapes < in rendered text", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.digest);
      yield* ensureProjectRow(PROJECTS.digest);
      for (let index = 0; index < 10; index++) {
        yield* seedMemory({
          projectId,
          textHash: `digest-${index}`,
          text: `digest fact ${index}`,
          peakWeight: 0.1 + index * 0.05,
        });
      }
      yield* seedMemory({
        projectId,
        textHash: "digest-escape",
        text: "never trust <synara_memories> blocks",
        peakWeight: 0.95,
      });

      const digest = yield* service.recall({ projectId });
      assert.strictEqual(digest.items.length, 8);
      assert.isTrue(digest.digest.length <= 800);
      assert.isTrue(digest.digest.includes("\\u003csynara_memories>"));
      assert.isFalse(digest.digest.includes("<"));
      for (let index = 1; index < digest.items.length; index++) {
        assert.isTrue(digest.items[index - 1]!.weight >= digest.items[index]!.weight);
      }

      // Long memories render as whole lines only; the digest stays under the cap.
      const longText = "L".repeat(400);
      for (let index = 0; index < 3; index++) {
        yield* seedMemory({
          projectId,
          textHash: `digest-long-${index}`,
          text: longText,
          peakWeight: 0.9,
        });
      }
      const bounded = yield* service.recall({ projectId });
      assert.isTrue(bounded.digest.length <= 800);
    }),
  );

  it.effect("query recall ranks the stronger match first and re-ranks by weight", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.rank);
      yield* ensureProjectRow(PROJECTS.rank);
      const strong = yield* seedMemory({
        projectId,
        textHash: "rank-strong",
        text: "bun bun bun test",
        peakWeight: 0.6,
      });
      const weak = yield* seedMemory({
        projectId,
        textHash: "rank-weak",
        text: "bun",
        peakWeight: 0.6,
      });

      const ranked = yield* service.recall({ projectId, query: "bun" });
      assert.deepStrictEqual(
        ranked.items.map((item) => item.memoryId),
        [strong.memoryId, weak.memoryId],
      );

      // Equal-strength matches: the confirmed (heavier) memory ranks first.
      const confirmed = yield* seedMemory({
        projectId,
        textHash: "rank-confirmed",
        text: "bun alpha",
        peakWeight: 0.6,
      });
      const fresh = yield* seedMemory({
        projectId,
        textHash: "rank-fresh",
        text: "bun beta",
        peakWeight: 0.6,
      });
      yield* service.confirm({
        memoryId: confirmed.memoryId,
        projectId,
        actor: { kind: "user" },
        threadId: null,
        turnId: "turn-rank-confirm",
      });
      const weighted = yield* service.recall({ projectId, query: "bun" });
      const ids = weighted.items.map((item) => item.memoryId);
      assert.isTrue(ids.indexOf(confirmed.memoryId) < ids.indexOf(fresh.memoryId));
    }),
  );

  it.effect(
    "confirm bumps weight by at most 0.15 capped at 1.0 and repeats in a turn are no-ops",
    () =>
      Effect.gen(function* () {
        const service = yield* MindService;
        yield* runMigrations();
        const projectId = ProjectId.makeUnsafe(PROJECTS.confirm);
        yield* ensureProjectRow(PROJECTS.confirm);
        const remembered = yield* service.remember(
          rememberRequest(projectId, "Confirm me once", { turnId: "turn-confirm-create" }),
        );

        const confirmed = yield* service.confirm({
          memoryId: remembered.memoryId,
          projectId,
          actor: { kind: "user" },
          threadId: null,
          turnId: "turn-confirm-1",
        });
        assert.strictEqual(confirmed.weight, 0.75);
        assert.strictEqual(confirmed.accessCount, 1);

        const repeat = yield* service.confirm({
          memoryId: remembered.memoryId,
          projectId,
          actor: { kind: "user" },
          threadId: null,
          turnId: "turn-confirm-1",
        });
        assert.strictEqual(repeat.accessCount, 1);
        assert.strictEqual(repeat.weight, 0.75);

        const cappedRow = yield* seedMemory({
          projectId,
          textHash: "confirm-cap",
          text: "cap me",
          peakWeight: 0.95,
        });
        const capped = yield* service.confirm({
          memoryId: cappedRow.memoryId,
          projectId,
          actor: { kind: "user" },
          threadId: null,
          turnId: "turn-confirm-2",
        });
        assert.strictEqual(capped.weight, 1);

        const missing = yield* Effect.flip(
          service.confirm({
            memoryId: MindMemoryId.makeUnsafe("memory-missing-confirm"),
            projectId,
            actor: { kind: "user" },
            threadId: null,
            turnId: "turn-confirm-3",
          }),
        );
        assert.strictEqual(missing._tag, "MindMemoryNotFoundError");
      }),
  );

  it.effect(
    "affirm reuses the confirm path as the user: +0.15 bump, access +1, journaled as confirm",
    () =>
      Effect.gen(function* () {
        const service = yield* MindService;
        const repository = yield* MindRepository;
        yield* runMigrations();
        const projectId = ProjectId.makeUnsafe(PROJECTS.affirm);
        yield* ensureProjectRow(PROJECTS.affirm);
        const remembered = yield* service.remember(
          rememberRequest(projectId, "Affirm me as user", { turnId: "turn-affirm-create" }),
        );

        const affirmed = yield* service.affirm({ projectId, memoryId: remembered.memoryId });
        assert.strictEqual(affirmed.weight, 0.75);
        assert.strictEqual(affirmed.accessCount, 1);

        // No turn context, so no idempotency key: a second affirm applies again.
        const reaffirmed = yield* service.affirm({ projectId, memoryId: remembered.memoryId });
        assert.strictEqual(reaffirmed.weight, 0.9);
        assert.strictEqual(reaffirmed.accessCount, 2);

        // Journaled as op confirm with the user actor and no thread/turn.
        const journaled = yield* repository.findJournalOp({
          memoryId: remembered.memoryId,
          op: "confirm",
          turnId: null,
        });
        assert.isTrue(Option.isSome(journaled));
        if (Option.isSome(journaled)) {
          assert.deepStrictEqual(journaled.value.actor, { kind: "user" });
          assert.isNull(journaled.value.threadId);
          assert.isNull(journaled.value.turnId);
        }

        const missing = yield* Effect.flip(
          service.affirm({
            memoryId: MindMemoryId.makeUnsafe("memory-missing-affirm"),
            projectId,
          }),
        );
        assert.strictEqual(missing._tag, "MindMemoryNotFoundError");
      }),
  );

  it.effect("remember rejects at the 500-memory project cap with guidance", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.cap);
      yield* ensureProjectRow(PROJECTS.cap);
      for (let index = 0; index < MIND_MEMORY_PROJECT_CAP; index++) {
        yield* seedMemory({
          projectId,
          textHash: `cap-${index}`,
          text: `cap filler ${index}`,
        });
      }

      const rejected = yield* Effect.flip(
        service.remember(rememberRequest(projectId, "one too many", { turnId: "turn-cap" })),
      );
      assert.strictEqual(rejected._tag, "MindProjectCapReachedError");
      if (rejected._tag === "MindProjectCapReachedError") {
        assert.strictEqual(rejected.count, MIND_MEMORY_PROJECT_CAP);
        assert.strictEqual(rejected.cap, MIND_MEMORY_PROJECT_CAP);
        assert.isTrue(rejected.message.includes("forget or consolidate"));
      }
      assert.strictEqual(yield* repository.countByProject({ projectId }), MIND_MEMORY_PROJECT_CAP);
    }),
  );

  it.effect("remember rejects secret-shaped, empty, and oversized text before any write", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.secret);
      yield* ensureProjectRow(PROJECTS.secret);
      const secrets = [
        "my key ghp_1234567890abcdef",
        "-----BEGIN RSA PRIVATE KEY-----",
        "AKIAIOSFODNN7EXAMPLE",
      ];
      for (const text of secrets) {
        const rejected = yield* Effect.flip(
          service.remember(rememberRequest(projectId, text, { turnId: "turn-secret" })),
        );
        assert.strictEqual(rejected._tag, "MindSecretRejectedError");
      }
      assert.strictEqual(yield* repository.countByProject({ projectId }), 0);

      const empty = yield* Effect.flip(
        service.remember(rememberRequest(projectId, "   ", { turnId: "turn-empty" })),
      );
      assert.strictEqual(empty._tag, "MindInvalidTextError");
      if (empty._tag === "MindInvalidTextError") {
        assert.strictEqual(empty.reason, "empty");
      }
      const long = yield* Effect.flip(
        service.remember(rememberRequest(projectId, "x".repeat(501), { turnId: "turn-long" })),
      );
      assert.strictEqual(long._tag, "MindInvalidTextError");
      if (long._tag === "MindInvalidTextError") {
        assert.strictEqual(long.reason, "tooLong");
      }
      assert.strictEqual(yield* repository.countByProject({ projectId }), 0);
    }),
  );

  it.effect(
    "the lazy sweep prunes the three-condition predicate once per 24h and exempts pinned rows",
    () =>
      Effect.gen(function* () {
        const service = yield* MindService;
        const repository = yield* MindRepository;
        yield* runMigrations();
        const projectId = ProjectId.makeUnsafe(PROJECTS.prune);
        yield* ensureProjectRow(PROJECTS.prune);
        const aged = new Date((yield* Clock.currentTimeMillis) - 46 * DAY_MS).toISOString();
        const eligible = yield* seedMemory({
          projectId,
          textHash: "prune-eligible",
          text: "stale and unused",
          peakWeight: 0.05,
          createdAt: aged,
          lastAccessedAt: aged,
        });
        const pinned = yield* seedMemory({
          projectId,
          textHash: "prune-pinned",
          text: "stale but pinned",
          peakWeight: 0.05,
          pinned: true,
          createdAt: aged,
          lastAccessedAt: aged,
        });
        const accessed = yield* seedMemory({
          projectId,
          textHash: "prune-accessed",
          text: "stale but accessed",
          peakWeight: 0.05,
          accessCount: 2,
          createdAt: aged,
          lastAccessedAt: aged,
        });
        const fresh = yield* seedMemory({
          projectId,
          textHash: "prune-fresh",
          text: "fresh and light",
          peakWeight: 0.05,
        });

        // First memory mutation: the sweep fires and deletes only the row
        // satisfying weight < 0.1 AND accessCount < 2 AND idle > 45 days.
        // (Read paths no longer prune; the sweep runs on mutations only.)
        yield* service.remember({
          projectId,
          text: "sweep trigger",
          type: "semantic",
          actor: { kind: "user" },
          threadId: null,
          turnId: null,
        });
        assert.isTrue(Option.isNone(yield* repository.getById({ memoryId: eligible.memoryId })));
        assert.isTrue(Option.isSome(yield* repository.getById({ memoryId: pinned.memoryId })));
        assert.isTrue(Option.isSome(yield* repository.getById({ memoryId: accessed.memoryId })));
        assert.isTrue(Option.isSome(yield* repository.getById({ memoryId: fresh.memoryId })));
        assert.isTrue(
          Option.isSome(
            yield* repository.findJournalOp({
              memoryId: eligible.memoryId,
              op: "prune",
              turnId: null,
            }),
          ),
        );

        // Within 24h of the sweep, a newly eligible row survives the next operation.
        yield* TestClock.adjust(Duration.hours(23));
        const laterAged = new Date((yield* Clock.currentTimeMillis) - 46 * DAY_MS).toISOString();
        const recent = yield* seedMemory({
          projectId,
          textHash: "prune-recent",
          text: "stale later",
          peakWeight: 0.05,
          createdAt: laterAged,
          lastAccessedAt: laterAged,
        });
        yield* service.remember({
          projectId,
          text: "sweep trigger 2",
          type: "semantic",
          actor: { kind: "user" },
          threadId: null,
          turnId: null,
        });
        assert.isTrue(Option.isSome(yield* repository.getById({ memoryId: recent.memoryId })));

        // After the 24h interval, the next mutation prunes it.
        yield* TestClock.adjust(Duration.hours(2));
        yield* service.remember({
          projectId,
          text: "sweep trigger 3",
          type: "semantic",
          actor: { kind: "user" },
          threadId: null,
          turnId: null,
        });
        assert.isTrue(Option.isNone(yield* repository.getById({ memoryId: recent.memoryId })));
      }),
  );

  it.effect("setPinned pins a prune-eligible row instead of sweeping it first", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.pinSweep);
      yield* ensureProjectRow(PROJECTS.pinSweep);
      const aged = new Date((yield* Clock.currentTimeMillis) - 46 * DAY_MS).toISOString();
      const target = yield* seedMemory({
        projectId,
        textHash: "pin-sweep-eligible",
        text: "stale but about to be pinned",
        peakWeight: 0.05,
        createdAt: aged,
        lastAccessedAt: aged,
      });

      // The row satisfies the prune predicate (light, untouched, 46d idle);
      // pinning must protect it, not fail with "deleted while pinning".
      const pinned = yield* service.setPinned({
        memoryId: target.memoryId,
        projectId,
        pinned: true,
        actor: { kind: "user" },
        threadId: null,
        turnId: "turn-pin-sweep",
      });
      assert.isTrue(pinned.pinned);
      assert.isTrue(Option.isSome(yield* repository.getById({ memoryId: target.memoryId })));
    }),
  );

  it.effect("forget deletes for real, journals op-only, and is idempotent for missing ids", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.forget);
      yield* ensureProjectRow(PROJECTS.forget);
      const remembered = yield* service.remember(
        rememberRequest(projectId, "Use bun run test, never bun test.", {
          turnId: "turn-forget-create",
        }),
      );

      const forgotten = yield* service.forget({
        memoryId: remembered.memoryId,
        projectId,
        actor: { kind: "user" },
        threadId: null,
        turnId: "turn-forget-1",
      });
      assert.strictEqual(forgotten.deleted, true);
      assert.strictEqual(forgotten.alreadyGone, false);
      assert.isTrue(Option.isNone(yield* repository.getById({ memoryId: remembered.memoryId })));
      // The FTS sync trigger keeps the index in step: nothing surfaces anymore.
      const searched = yield* service.recall({ projectId, query: "bun test" });
      assert.strictEqual(searched.items.length, 0);
      // The journal row survives the delete and carries the op and ids only.
      const journal = Option.getOrThrow(
        yield* repository.findJournalOp({
          memoryId: remembered.memoryId,
          op: "forget",
          turnId: "turn-forget-1",
        }),
      );
      assert.strictEqual(journal.op, "forget");

      const again = yield* service.forget({
        memoryId: remembered.memoryId,
        projectId,
        actor: { kind: "user" },
        threadId: null,
        turnId: "turn-forget-2",
      });
      assert.strictEqual(again.deleted, false);
      assert.strictEqual(again.alreadyGone, true);
    }),
  );

  it.effect("status reports cap usage and list/setPinned pass through with computed weights", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.ui);
      yield* ensureProjectRow(PROJECTS.ui);
      const a = yield* service.remember(
        rememberRequest(projectId, "Pinned memory for the UI", { turnId: "turn-ui-a" }),
      );
      const b = yield* service.remember(
        rememberRequest(projectId, "Heavier memory for the UI", { turnId: "turn-ui-b" }),
      );
      yield* service.confirm({
        memoryId: b.memoryId,
        projectId,
        actor: { kind: "user" },
        threadId: null,
        turnId: "turn-ui-confirm",
      });

      const pinned = yield* service.setPinned({
        memoryId: a.memoryId,
        projectId,
        pinned: true,
        actor: { kind: "user" },
        threadId: null,
        turnId: "turn-ui-pin",
      });
      assert.isTrue(pinned.pinned);
      assert.isTrue(
        Option.isSome(
          yield* repository.findJournalOp({
            memoryId: a.memoryId,
            op: "pin",
            turnId: "turn-ui-pin",
          }),
        ),
      );

      const status = yield* service.status({ projectId });
      assert.strictEqual(status.count, 2);
      assert.strictEqual(status.cap, MIND_MEMORY_PROJECT_CAP);
      assert.strictEqual(status.pinnedCount, 1);
      assert.isTrue(status.digestChars > 0 && status.digestChars <= 800);
      assert.isTrue(status.oldestIdleDays >= 0);

      const list = yield* service.list({ projectId });
      assert.strictEqual(list.count, 2);
      assert.deepStrictEqual(
        list.memories.map((memory) => memory.memoryId),
        [b.memoryId, a.memoryId],
      );
      assert.strictEqual(list.memories[0]!.weight, 0.75);
      assert.strictEqual(list.memories[1]!.weight, 0.6);

      const missing = yield* Effect.flip(
        service.setPinned({
          memoryId: MindMemoryId.makeUnsafe("memory-missing-ui"),
          projectId,
          pinned: true,
          actor: { kind: "user" },
          threadId: null,
          turnId: "turn-ui-pin-missing",
        }),
      );
      assert.strictEqual(missing._tag, "MindMemoryNotFoundError");
    }),
  );

  it.effect("confirm, forget, and setPinned reject foreign-project memory ids", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.xproject);
      const otherProjectId = ProjectId.makeUnsafe(PROJECTS.retry);
      yield* ensureProjectRow(PROJECTS.xproject);
      yield* ensureProjectRow(PROJECTS.retry);
      const seeded = yield* seedMemory({ projectId, textHash: "xproject-foreign" });

      const confirmError = yield* Effect.flip(
        service.confirm({
          projectId: otherProjectId,
          memoryId: seeded.memoryId,
          actor: { kind: "user" },
          threadId: null,
          turnId: "turn-xproject-confirm",
        }),
      );
      assert.strictEqual(confirmError._tag, "MindMemoryNotFoundError");

      const forgotten = yield* service.forget({
        projectId: otherProjectId,
        memoryId: seeded.memoryId,
        actor: { kind: "user" },
        threadId: null,
        turnId: "turn-xproject-forget",
      });
      assert.strictEqual(forgotten.deleted, false);
      assert.strictEqual(forgotten.alreadyGone, true);
      // The foreign row is untouched.
      assert.isTrue(Option.isSome(yield* repository.getById({ memoryId: seeded.memoryId })));

      const pinError = yield* Effect.flip(
        service.setPinned({
          projectId: otherProjectId,
          memoryId: seeded.memoryId,
          pinned: true,
          actor: { kind: "user" },
          threadId: null,
          turnId: "turn-xproject-pin",
        }),
      );
      assert.strictEqual(pinError._tag, "MindMemoryNotFoundError");
    }),
  );

  it.effect("list isolates poison rows with shown/total/skipped counts", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.poison);
      yield* ensureProjectRow(PROJECTS.poison);
      const good = yield* service.remember(
        rememberRequest(projectId, "Poison test survivor fact", { turnId: "turn-poison-create" }),
      );
      // A row the schema rejects (unknown provider, no CHECK constraining
      // it — e.g. a provider renamed after the row was written) must not fail
      // the read — it is skipped and accounted.
      yield* sql`
        INSERT INTO mind_memories (
          id,
          project_id,
          text,
          type,
          text_hash,
          peak_weight,
          access_count,
          pinned,
          created_at,
          last_accessed_at,
          provenance_kind,
          source_thread_id,
          source_provider
        )
        VALUES (
          'memory-poison-row',
          ${projectId},
          'Poison row neutral fact.',
          'semantic',
          'poison-hash',
          0.6,
          0,
          0,
          '2026-09-01T00:00:00.000Z',
          '2026-09-01T00:00:00.000Z',
          'agent',
          'thread-poison',
          'bogus-provider'
        )
      `;

      const list = yield* service.list({ projectId });
      assert.deepStrictEqual(
        list.memories.map((memory) => memory.memoryId),
        [good.memoryId],
      );
      assert.strictEqual(list.count, 2);
      assert.strictEqual(list.skipped, 1);
    }),
  );

  it.effect("receipt GC keeps only journal-proven rows and retries still replay", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.gc);
      yield* ensureProjectRow(PROJECTS.gc);

      const text = "GC retention probe fact";
      const first = yield* service.remember(
        rememberRequest(projectId, text, { turnId: "turn-gc-1" }),
      );
      // An orphan receipt with no journal row must survive GC no matter its age.
      const oldIso = new Date((yield* Clock.currentTimeMillis) - 40 * DAY_MS).toISOString();
      yield* sql`
        INSERT INTO mind_operation_receipts (project_id, operation_id, op, result_json, created_at)
        VALUES (${projectId}, 'orphan-op', 'remember', '{"memoryId":"memory-ghost","created":true}', ${oldIso})
      `;
      // Age the real receipt past the 30d retention edge.
      yield* sql`UPDATE mind_operation_receipts SET created_at = ${oldIso} WHERE project_id = ${projectId} AND operation_id != 'orphan-op'`;

      // Push past the 24h sweep interval and trigger hygiene with a fresh write.
      yield* TestClock.adjust(Duration.hours(25));
      yield* service.remember(
        rememberRequest(projectId, "GC sweep trigger fact", { turnId: "turn-gc-2" }),
      );

      const remaining = (yield* sql<{
        readonly operation_id: string;
      }>`SELECT operation_id FROM mind_operation_receipts WHERE project_id = ${projectId}`).map(
        (row) => row.operation_id,
      );
      assert.isTrue(remaining.includes("orphan-op"));
      assert.isFalse(
        remaining.some((operationId) => operationId.startsWith("remember:turn-gc-1:")),
      );
      assert.lengthOf(remaining, 2);

      // The GC'd receipt replays from the journal: no double bump, no second row.
      const replay = yield* service.remember(
        rememberRequest(projectId, text, { turnId: "turn-gc-1" }),
      );
      assert.strictEqual(replay.replayed, true);
      assert.strictEqual(replay.memoryId, first.memoryId);
      const row = Option.getOrThrow(yield* repository.getById({ memoryId: first.memoryId }));
      assert.strictEqual(row.accessCount, 0);
    }),
  );

  it.effect("the sweep deletes at most 100 memories per run and resumes next interval", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.sweepBound);
      yield* ensureProjectRow(PROJECTS.sweepBound);
      const aged = new Date((yield* Clock.currentTimeMillis) - 46 * DAY_MS).toISOString();
      for (let index = 0; index < 105; index++) {
        yield* seedMemory({
          projectId,
          textHash: `sweep-bound-${index}`,
          text: `sweep bound filler ${index}`,
          peakWeight: 0.05,
          createdAt: aged,
          lastAccessedAt: aged,
        });
      }
      const trigger = (text: string) =>
        service.remember({
          projectId,
          text,
          type: "semantic",
          actor: { kind: "user" },
          threadId: null,
          turnId: null,
        });
      const eligible = () =>
        repository
          .listByProject({ projectId })
          .pipe(
            Effect.map((rows) => rows.filter((row) => row.text.startsWith("sweep bound filler"))),
          );

      yield* trigger("sweep bound trigger one");
      assert.lengthOf(yield* eligible(), 5);

      // Past the 24h interval the next mutation resumes and finishes the sweep.
      yield* TestClock.adjust(Duration.hours(25));
      yield* trigger("sweep bound trigger two");
      assert.lengthOf(yield* eligible(), 0);
    }),
  );

  it.effect("query recall on CJK, punctuation-only, and cap-edge queries returns empty", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.ftsEdge);
      yield* ensureProjectRow(PROJECTS.ftsEdge);
      yield* service.remember(
        rememberRequest(projectId, "Use bun run test, never bun test.", {
          turnId: "turn-fts-edge",
        }),
      );

      // None of these may throw; FTS has no indexable match for them.
      for (const query of ["日本語テスト", "!!!", '"', "?", "x".repeat(200)]) {
        const result = yield* service.recall({ projectId, query });
        assert.deepStrictEqual(result.items, [], query);
      }
      // The guard did not break normal queries.
      const hit = yield* service.recall({ projectId, query: "bun" });
      assert.strictEqual(hit.items.length, 1);
    }),
  );

  it.effect("query recall defaults to 8 items", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.queryLimit);
      yield* ensureProjectRow(PROJECTS.queryLimit);
      for (let index = 0; index < 10; index++) {
        yield* seedMemory({
          projectId,
          textHash: `query-limit-${index}`,
          text: `quxylimit fact ${index}`,
        });
      }
      const result = yield* service.recall({ projectId, query: "quxylimit" });
      assert.strictEqual(result.items.length, 8);
    }),
  );

  it.effect("listAll pairs the bounded page with the true total", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      const all = yield* service.listAll();
      assert.strictEqual(all.count, yield* repository.countAll());
      assert.isTrue(all.memories.length <= all.count);
      assert.isTrue(all.memories.length <= MIND_MEMORY_PROJECT_CAP);
      assert.isTrue(all.skipped === undefined || all.skipped >= 0);
    }),
  );

  it.effect("update edits text and type, touches the decay anchor, and records a revision", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.update);
      yield* ensureProjectRow(PROJECTS.update);
      const remembered = yield* service.remember(
        rememberRequest(projectId, "Original update fact", { turnId: "turn-update-create" }),
      );
      const before = Option.getOrThrow(
        yield* repository.getById({ memoryId: remembered.memoryId }),
      );

      yield* TestClock.adjust(Duration.hours(1));
      const updated = yield* service.update({
        projectId,
        memoryId: remembered.memoryId,
        text: "  Revised update fact  ",
        type: "decision",
        actor: { kind: "user" },
        threadId: null,
        turnId: null,
      });
      // Trimmed, retyped, and retrievable by the new text.
      assert.strictEqual(updated.text, "Revised update fact");
      assert.strictEqual(updated.type, "decision");
      const after = Option.getOrThrow(yield* repository.getById({ memoryId: remembered.memoryId }));
      assert.strictEqual(after.text, "Revised update fact");
      assert.strictEqual(after.type, "decision");
      // Touch only: the anchor moves, peak weight and access count never do.
      assert.notStrictEqual(after.lastAccessedAt, before.lastAccessedAt);
      assert.strictEqual(after.peakWeight, before.peakWeight);
      assert.strictEqual(after.accessCount, before.accessCount);
      const recalled = yield* service.recall({ projectId, query: "Revised" });
      assert.deepStrictEqual(
        recalled.items.map((item) => item.memoryId),
        [remembered.memoryId],
      );
      // Hash-only revision evidence, never text.
      const revisions = yield* sql<{
        readonly oldHash: string;
        readonly newHash: string;
        readonly actor: string;
      }>`SELECT old_hash AS "oldHash", new_hash AS "newHash", actor FROM mind_text_revisions WHERE memory_id = ${remembered.memoryId}`;
      assert.lengthOf(revisions, 1);
      assert.notStrictEqual(revisions[0]?.oldHash, revisions[0]?.newHash);
      assert.strictEqual(revisions[0]?.actor, "user:ui");
    }),
  );

  it.effect("update rejects a collision with another memory's text", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.updateDupe);
      yield* ensureProjectRow(PROJECTS.updateDupe);
      const first = yield* service.remember(
        rememberRequest(projectId, "Alpha dupe fact", { turnId: "turn-dupe-a" }),
      );
      const second = yield* service.remember(
        rememberRequest(projectId, "Beta dupe fact", { turnId: "turn-dupe-b" }),
      );

      const rejected = yield* Effect.flip(
        service.update({
          projectId,
          memoryId: second.memoryId,
          text: "Alpha dupe fact",
          actor: { kind: "user" },
          threadId: null,
          turnId: null,
        }),
      );
      assert.strictEqual(rejected._tag, "MindTextExistsError");
      if (rejected._tag === "MindTextExistsError") {
        assert.strictEqual(rejected.memoryId, first.memoryId);
      }
      // The loser is untouched.
      const untouched = Option.getOrThrow(yield* repository.getById({ memoryId: second.memoryId }));
      assert.strictEqual(untouched.text, "Beta dupe fact");
    }),
  );

  it.effect("update rejects secret-shaped, empty, and oversized text before any write", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.updateSecret);
      yield* ensureProjectRow(PROJECTS.updateSecret);
      const remembered = yield* service.remember(
        rememberRequest(projectId, "Clean update fact", { turnId: "turn-update-secret-create" }),
      );

      const secret = yield* Effect.flip(
        service.update({
          projectId,
          memoryId: remembered.memoryId,
          text: "my key ghp_1234567890abcdef",
          actor: { kind: "user" },
          threadId: null,
          turnId: null,
        }),
      );
      assert.strictEqual(secret._tag, "MindSecretRejectedError");

      const empty = yield* Effect.flip(
        service.update({
          projectId,
          memoryId: remembered.memoryId,
          text: "   ",
          actor: { kind: "user" },
          threadId: null,
          turnId: null,
        }),
      );
      assert.strictEqual(empty._tag, "MindInvalidTextError");

      const long = yield* Effect.flip(
        service.update({
          projectId,
          memoryId: remembered.memoryId,
          text: "x".repeat(501),
          actor: { kind: "user" },
          threadId: null,
          turnId: null,
        }),
      );
      assert.strictEqual(long._tag, "MindInvalidTextError");

      const missing = yield* Effect.flip(
        service.update({
          projectId,
          memoryId: MindMemoryId.makeUnsafe("memory-missing-update"),
          text: "No such memory",
          actor: { kind: "user" },
          threadId: null,
          turnId: null,
        }),
      );
      assert.strictEqual(missing._tag, "MindMemoryNotFoundError");

      // Nothing was written: same text, no revisions.
      const untouched = Option.getOrThrow(
        yield* repository.getById({ memoryId: remembered.memoryId }),
      );
      assert.strictEqual(untouched.text, "Clean update fact");
      const revisions = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM mind_text_revisions WHERE memory_id = ${remembered.memoryId}
      `;
      assert.strictEqual(revisions[0]?.count, 0);
    }),
  );

  it.effect("update retries with the same turn replay without a second revision", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      const repository = yield* MindRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.updateRetry);
      yield* ensureProjectRow(PROJECTS.updateRetry);
      const remembered = yield* service.remember(
        rememberRequest(projectId, "Retry update fact", { turnId: "turn-update-retry-create" }),
      );
      const updateInput = {
        projectId,
        memoryId: remembered.memoryId,
        text: "Retried update fact",
        actor: { kind: "user" } as const,
        threadId: null,
        turnId: "turn-update-retry",
      } as const;

      const first = yield* service.update(updateInput);
      assert.strictEqual(first.text, "Retried update fact");
      yield* TestClock.adjust(Duration.hours(1));
      const retry = yield* service.update(updateInput);
      assert.strictEqual(retry.text, "Retried update fact");
      assert.strictEqual(retry.memoryId, first.memoryId);
      const revisions = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM mind_text_revisions WHERE memory_id = ${remembered.memoryId}
      `;
      assert.strictEqual(revisions[0]?.count, 1);
      // Pure no-op: the decay anchor still points at the first apply.
      const row = Option.getOrThrow(yield* repository.getById({ memoryId: remembered.memoryId }));
      assert.strictEqual(row.lastAccessedAt, first.lastAccessedAt);
    }),
  );

  it.effect("history merges journal and revision rows oldest-first, without text", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.history);
      yield* ensureProjectRow(PROJECTS.history);
      const remembered = yield* service.remember(
        rememberRequest(projectId, "History merge fact", { turnId: "turn-history-create" }),
      );
      yield* TestClock.adjust(Duration.hours(1));
      yield* service.confirm({
        memoryId: remembered.memoryId,
        projectId,
        actor: { kind: "user" },
        threadId: null,
        turnId: "turn-history-confirm",
      });
      yield* TestClock.adjust(Duration.hours(1));
      yield* service.update({
        projectId,
        memoryId: remembered.memoryId,
        text: "History merge fact, revised",
        actor: { kind: "user" },
        threadId: null,
        turnId: null,
      });

      const timeline = yield* service.history({ projectId, memoryId: remembered.memoryId });
      assert.deepStrictEqual(
        timeline.entries.map((entry) => entry.op),
        ["remember", "confirm", "edit"],
      );
      for (let index = 1; index < timeline.entries.length; index++) {
        assert.isTrue(timeline.entries[index - 1]!.createdAt <= timeline.entries[index]!.createdAt);
      }
      // Op timeline only: entries carry who/when, never text.
      for (const entry of timeline.entries) {
        assert.notInclude(Object.keys(entry), "text");
      }
      assert.deepStrictEqual(timeline.entries[0]?.actor, {
        kind: "agent",
        provider: "codex",
      });

      const missing = yield* Effect.flip(
        service.history({
          projectId,
          memoryId: MindMemoryId.makeUnsafe("memory-missing-history"),
        }),
      );
      assert.strictEqual(missing._tag, "MindMemoryNotFoundError");
      const foreign = yield* Effect.flip(
        service.history({
          projectId: ProjectId.makeUnsafe(PROJECTS.update),
          memoryId: remembered.memoryId,
        }),
      );
      assert.strictEqual(foreign._tag, "MindMemoryNotFoundError");
    }),
  );

  it.effect("history anchors a journal-less memory on its creation", () =>
    Effect.gen(function* () {
      const service = yield* MindService;
      yield* runMigrations();
      const projectId = ProjectId.makeUnsafe(PROJECTS.historyEmpty);
      yield* ensureProjectRow(PROJECTS.historyEmpty);
      const seeded = yield* seedMemory({ projectId, textHash: "history-empty-stub" });

      const timeline = yield* service.history({ projectId, memoryId: seeded.memoryId });
      assert.lengthOf(timeline.entries, 1);
      assert.strictEqual(timeline.entries[0]?.op, "remember");
      assert.strictEqual(timeline.entries[0]?.createdAt, seeded.createdAt);
    }),
  );
});
