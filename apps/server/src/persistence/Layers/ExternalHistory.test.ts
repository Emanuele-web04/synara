import { ThreadId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ExternalHistoryRepository,
  type ExternalHistoryBatchRecord,
  type ExternalHistoryJobRecord,
  type ExternalHistoryLinkRecord,
  type ExternalHistoryMessageRecord,
  type ExternalHistorySourceRecord,
} from "../Services/ExternalHistory.ts";
import { ExternalHistoryRepositoryLive } from "./ExternalHistory.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const clearAll = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM external_history_messages`;
  yield* sql`DELETE FROM external_history_batches`;
  yield* sql`DELETE FROM external_history_jobs`;
  yield* sql`DELETE FROM external_history_links`;
  yield* sql`DELETE FROM external_history_sources`;
});

const layer = it.layer(
  ExternalHistoryRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const NOW = "2026-11-23T12:00:00.000Z";
const LATER = "2026-11-23T12:05:00.000Z";

const source = (
  overrides: Partial<ExternalHistorySourceRecord> = {},
): ExternalHistorySourceRecord => ({
  sourceId: "src-1",
  kind: "devin-local",
  scopeIdentity: "host-1|store-1",
  filters: null,
  decoderVersion: "3000.14.30833",
  enabled: true,
  paused: false,
  credentialRef: null,
  scopeGeneration: 0,
  lastDiscoverySuccessAt: null,
  lastErrorCode: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const link = (overrides: Partial<ExternalHistoryLinkRecord> = {}): ExternalHistoryLinkRecord => ({
  linkId: "link-1",
  sourceId: "src-1",
  externalSessionId: "piquant-gouda",
  threadId: null,
  sourceRevision: null,
  committedMessageCursor: null,
  historyStatus: "pending",
  nativeResumeDescriptor: null,
  upstreamMetadata: null,
  userOverrideFlags: null,
  suppressedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const message = (
  overrides: Partial<ExternalHistoryMessageRecord> = {},
): ExternalHistoryMessageRecord => ({
  linkId: "link-1",
  upstreamMessageId: "m-1",
  synaraMessageId: null,
  sourceOrder: 0,
  contentHash: "hash-a",
  sourceRevision: "rev-1",
  originalTimestamp: NOW,
  visibility: "visible",
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const job = (overrides: Partial<ExternalHistoryJobRecord> = {}): ExternalHistoryJobRecord => ({
  jobId: "job-1",
  sourceId: "src-1",
  scopeGeneration: 0,
  scanUpperBound: null,
  pageCursor: null,
  status: "queued",
  counters: null,
  retries: 0,
  leaseOwner: null,
  leaseExpiresAt: null,
  checkpoint: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const batch = (
  overrides: Partial<ExternalHistoryBatchRecord> = {},
): ExternalHistoryBatchRecord => ({
  batchId: "batch-1",
  jobId: "job-1",
  linkId: null,
  payload: { messages: [{ upstreamMessageId: "m-1" }] },
  payloadHash: "hash-1",
  commandId: "cmd-1",
  state: "persisted",
  acceptedSequence: null,
  nextCursor: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

layer("ExternalHistoryRepository", (it) => {
  it.effect("reuses the canonical source for a repeated (kind, scopeIdentity)", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalHistoryRepository;
      yield* clearAll;

      const first = yield* repository.getOrCreateSource(source());
      const second = yield* repository.getOrCreateSource(
        source({ sourceId: "src-different", updatedAt: LATER }),
      );

      // UNIQUE(kind, scope_identity) keeps one identity: the second call must
      // not insert src-different and returns the original canonical row.
      assert.strictEqual(second.sourceId, "src-1");
      assert.strictEqual(first.sourceId, second.sourceId);
      assert.strictEqual((yield* repository.listSources()).length, 1);
    }),
  );

  it.effect("upserts links keyed on (sourceId, externalSessionId) and resolves by thread", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalHistoryRepository;
      yield* clearAll;
      yield* repository.upsertSource(source());

      const threadId = ThreadId.makeUnsafe("thread-1");
      yield* repository.upsertLink(link());
      yield* repository.upsertLink(
        link({ linkId: "link-renamed", threadId, historyStatus: "complete", updatedAt: LATER }),
      );

      const byExternal = yield* repository.getLink({
        sourceId: "src-1",
        externalSessionId: "piquant-gouda",
      });
      assert.isTrue(Option.isSome(byExternal));
      assert.strictEqual(Option.getOrThrow(byExternal).historyStatus, "complete");
      // linkId is the canonical identity messages hang off: an upsert keyed on
      // (sourceId, externalSessionId) never rewrites it.
      assert.strictEqual(Option.getOrThrow(byExternal).linkId, "link-1");

      const byThread = yield* repository.getLinkByThreadId({ threadId });
      assert.isTrue(Option.isSome(byThread));
      assert.strictEqual(Option.getOrThrow(byThread).externalSessionId, "piquant-gouda");

      assert.strictEqual((yield* repository.listLinksBySource({ sourceId: "src-1" })).length, 1);
    }),
  );

  it.effect("keeps older message revisions from overwriting newer ones", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalHistoryRepository;
      yield* clearAll;
      yield* repository.upsertSource(source());
      yield* repository.upsertLink(link());

      yield* repository.upsertMessages([message()]);
      // Same id, older revision: ignored by the revision guard.
      yield* repository.upsertMessages([
        message({ contentHash: "hash-stale", sourceRevision: "rev-0", updatedAt: LATER }),
      ]);
      // Same id, newer revision: replaces visible fields.
      yield* repository.upsertMessages([
        message({ contentHash: "hash-b", sourceRevision: "rev-2", updatedAt: LATER }),
      ]);
      yield* repository.upsertMessages([message({ upstreamMessageId: "m-2", sourceOrder: 1 })]);

      const messages = yield* repository.listMessagesByLink({ linkId: "link-1" });
      assert.strictEqual(messages.length, 2);
      assert.strictEqual(messages[0]!.upstreamMessageId, "m-1");
      assert.strictEqual(messages[0]!.contentHash, "hash-b");
      assert.strictEqual(messages[0]!.sourceRevision, "rev-2");
      assert.strictEqual(messages[1]!.upstreamMessageId, "m-2");
    }),
  );

  it.effect("deduplicates batch inserts and rejects a reused id with different payload", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalHistoryRepository;
      yield* clearAll;
      yield* repository.upsertSource(source());
      yield* repository.upsertJob(job());

      assert.isTrue(yield* repository.insertBatch(batch()));
      // Same batch id + same payload: idempotent no-op.
      assert.isFalse(yield* repository.insertBatch(batch()));
      // Same batch id + different payload: explicit conflict.
      const conflict = yield* repository
        .insertBatch(batch({ payload: { messages: [] }, payloadHash: "hash-2" }))
        .pipe(Effect.flip);
      assert.strictEqual(conflict._tag, "PersistenceSqlError");

      const stored = yield* repository.getBatch({ batchId: "batch-1" });
      assert.isTrue(Option.isSome(stored));
      assert.strictEqual(Option.getOrThrow(stored).commandId, "cmd-1");

      yield* repository.updateBatchState({
        batchId: "batch-1",
        state: "accepted",
        acceptedSequence: 42,
        nextCursor: "cursor-2",
        updatedAt: LATER,
      });
      const updated = yield* repository.getBatch({ batchId: "batch-1" });
      assert.strictEqual(Option.getOrThrow(updated).state, "accepted");
      assert.strictEqual(Option.getOrThrow(updated).acceptedSequence, 42);
      assert.strictEqual(Option.getOrThrow(updated).nextCursor, "cursor-2");
    }),
  );

  it.effect("persists jobs with lease and checkpoint bookkeeping", () =>
    Effect.gen(function* () {
      const repository = yield* ExternalHistoryRepository;
      yield* clearAll;
      yield* repository.upsertSource(source());

      yield* repository.upsertJob(
        job({ status: "importing", leaseOwner: "worker-1", leaseExpiresAt: LATER }),
      );
      // Full-row upsert: fields omitted by the caller are overwritten.
      yield* repository.upsertJob(
        job({
          status: "complete",
          pageCursor: "done",
          checkpoint: { page: 3 },
          leaseOwner: "worker-1",
          leaseExpiresAt: LATER,
          updatedAt: LATER,
        }),
      );

      const stored = yield* repository.getJob({ jobId: "job-1" });
      assert.isTrue(Option.isSome(stored));
      assert.strictEqual(Option.getOrThrow(stored).status, "complete");
      assert.deepStrictEqual(Option.getOrThrow(stored).checkpoint, { page: 3 });
      assert.strictEqual(Option.getOrThrow(stored).leaseOwner, "worker-1");
      assert.strictEqual((yield* repository.listJobsBySource({ sourceId: "src-1" })).length, 1);
    }),
  );
});
