import {
  IsoDateTime,
  MIND_MEMORY_PROJECT_CAP,
  MIND_RECALL_CANDIDATE_MAX_ITEMS,
  MindJournalEntry,
  MindMemoryId,
  MindMemoryType,
  NonNegativeInt,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeCauseError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../Errors.ts";
import {
  ApplyMindConfirmInput,
  AppendMindJournalInput,
  CountMindMemoriesInput,
  DeleteMindMemoryInput,
  FindMindJournalOpInput,
  FindMindMemoryByTextHashInput,
  GetMindMemoryInput,
  GetMindReceiptInput,
  InsertMindMemoryInput,
  ListAllMindMemoriesInput,
  ListMindMemoriesInput,
  MindRepository,
  MindMemoryRow,
  type MindMemoryCandidate,
  type MindRepositoryError,
  type MindRepositoryShape,
  PruneMindReceiptsInput,
  PutMindReceiptInput,
  SearchMindCandidatesInput,
  SetMindMemoryPinnedInput,
  isFtsMatchExprQueryable,
} from "../Services/MindRepository.ts";

const MindMemoryDbRow = Schema.Struct({
  memoryId: MindMemoryId,
  projectId: ProjectId,
  text: Schema.String,
  type: MindMemoryType,
  textHash: Schema.String,
  peakWeight: Schema.Number,
  accessCount: NonNegativeInt,
  // SQLite stores booleans as 0/1 integers; converted in toMemory.
  pinned: Schema.Number,
  createdAt: IsoDateTime,
  lastAccessedAt: IsoDateTime,
  provenanceKind: Schema.Literals(["user", "agent"]),
  // Source columns carry no CHECK (providers and thread-id formats evolve),
  // so they decode as plain strings here. Domain validation happens in
  // `toMemory`, where a per-row failure is isolated instead of failing the
  // whole list read.
  sourceThreadId: Schema.NullOr(Schema.String),
  sourceProvider: Schema.NullOr(Schema.String),
});
type MindMemoryDbRow = typeof MindMemoryDbRow.Type;

// The FTS join returns the memory row columns flat, plus the bm25 rank.
const MindMemoryCandidateDbRow = MindMemoryDbRow.mapFields(Struct.assign({ bm25: Schema.Number }));

const MindJournalDbRow = Schema.Struct({
  projectId: ProjectId,
  memoryId: MindMemoryId,
  op: MindJournalEntry.fields.op,
  actor: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  turnId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
type MindJournalDbRow = typeof MindJournalDbRow.Type;

const MindReceiptDbRow = Schema.Struct({
  projectId: ProjectId,
  operationId: Schema.String,
  op: Schema.String,
  resultJson: Schema.String,
  createdAt: IsoDateTime,
});

const decodeMemoryRow = Schema.decodeUnknownEffect(MindMemoryRow);
const decodeJournalEntry = Schema.decodeUnknownEffect(MindJournalEntry);

/** Decodes the raw DB row into the domain row (pinned 0/1 → boolean, provenance reassembled). */
const toMemory = (row: MindMemoryDbRow) =>
  decodeMemoryRow({
    memoryId: row.memoryId,
    projectId: row.projectId,
    text: row.text,
    type: row.type,
    textHash: row.textHash,
    peakWeight: row.peakWeight,
    accessCount: row.accessCount,
    pinned: row.pinned === 1,
    createdAt: row.createdAt,
    lastAccessedAt: row.lastAccessedAt,
    // Rows written before the 105 backfill can carry agent kind with partial
    // sources. Degrade those to user provenance (same rule as the migration)
    // so one inconsistent row never fails the whole list.
    provenance:
      row.provenanceKind === "agent" && row.sourceThreadId !== null && row.sourceProvider !== null
        ? { kind: "agent", threadId: row.sourceThreadId, provider: row.sourceProvider }
        : { kind: "user" },
  }).pipe(Effect.mapError(toPersistenceDecodeError("MindRepository.memoryRowToDomain")));

const toMemoryOption = (
  row: Option.Option<MindMemoryDbRow>,
): Effect.Effect<Option.Option<MindMemoryRow>, MindRepositoryError> =>
  Option.match(row, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (memoryRow) => Effect.map(toMemory(memoryRow), Option.some),
  });

/**
 * One corrupt row must never fail a whole list read (legacy corruption,
 * manual DB edits). Decode each row independently and drop the failures; the
 * service layer reconciles the shown rows against the table count and logs
 * the skip with shown/total counts.
 */
const toMemorySafe = (row: MindMemoryDbRow): Effect.Effect<MindMemoryRow | undefined, never> =>
  toMemory(row).pipe(Effect.option, Effect.map(Option.getOrUndefined));

const toMemoryListSafe = (
  rows: ReadonlyArray<MindMemoryDbRow>,
): Effect.Effect<ReadonlyArray<MindMemoryRow>, never> =>
  Effect.forEach(rows, toMemorySafe, { concurrency: "unbounded" }).pipe(
    Effect.map((decoded) => decoded.filter((row) => row !== undefined)),
  );

const toCandidate = (row: typeof MindMemoryCandidateDbRow.Type) =>
  toMemory(row).pipe(Effect.map((memory): MindMemoryCandidate => ({ memory, bm25: row.bm25 })));

const toCandidateSafe = (
  row: typeof MindMemoryCandidateDbRow.Type,
): Effect.Effect<MindMemoryCandidate | undefined, never> =>
  toCandidate(row).pipe(Effect.option, Effect.map(Option.getOrUndefined));

const toJournalEntryOption = (
  row: Option.Option<MindJournalDbRow>,
): Effect.Effect<Option.Option<MindJournalEntry>, MindRepositoryError> =>
  Option.match(row, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (journalRow) => Effect.map(toJournalEntry(journalRow), Option.some),
  });

// Journal actors round-trip as 'agent:<provider>' | 'user:ui' (plan 05 §6.1).
const encodeJournalActor = (actor: MindJournalEntry["actor"]): string =>
  actor.kind === "agent" ? `agent:${actor.provider}` : "user:ui";

const decodeJournalActor = (actor: string): unknown => {
  if (actor === "user:ui") return { kind: "user" };
  if (actor.startsWith("agent:")) {
    return { kind: "agent", provider: actor.slice("agent:".length) };
  }
  return actor;
};

const toJournalEntry = (row: MindJournalDbRow) =>
  decodeJournalEntry({
    projectId: row.projectId,
    memoryId: row.memoryId,
    op: row.op,
    actor: decodeJournalActor(row.actor),
    threadId: row.threadId,
    turnId: row.turnId,
    createdAt: row.createdAt,
  }).pipe(Effect.mapError(toPersistenceDecodeError("MindRepository.journalRowToDomain")));

const makeMindRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertMemoryRow = SqlSchema.findOneOption({
    Request: InsertMindMemoryInput,
    Result: MindMemoryDbRow,
    execute: ({
      memoryId,
      projectId,
      text,
      type,
      textHash,
      peakWeight,
      accessCount,
      pinned,
      createdAt,
      lastAccessedAt,
      provenance,
    }) =>
      sql`
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
          ${memoryId},
          ${projectId},
          ${text},
          ${type},
          ${textHash},
          ${peakWeight},
          ${accessCount},
          ${pinned ? 1 : 0},
          ${createdAt},
          ${lastAccessedAt},
          ${provenance.kind},
          ${provenance.kind === "agent" ? provenance.threadId : null},
          ${provenance.kind === "agent" ? provenance.provider : null}
        )
        RETURNING
          id AS "memoryId",
          project_id AS "projectId",
          text,
          type,
          text_hash AS "textHash",
          peak_weight AS "peakWeight",
          access_count AS "accessCount",
          pinned,
          created_at AS "createdAt",
          last_accessed_at AS "lastAccessedAt",
          provenance_kind AS "provenanceKind",
          source_thread_id AS "sourceThreadId",
          source_provider AS "sourceProvider"
      `,
  });

  const findMemoryByTextHashRow = SqlSchema.findOneOption({
    Request: FindMindMemoryByTextHashInput,
    Result: MindMemoryDbRow,
    execute: ({ projectId, textHash }) =>
      sql`
        SELECT
          id AS "memoryId",
          project_id AS "projectId",
          text,
          type,
          text_hash AS "textHash",
          peak_weight AS "peakWeight",
          access_count AS "accessCount",
          pinned,
          created_at AS "createdAt",
          last_accessed_at AS "lastAccessedAt",
          provenance_kind AS "provenanceKind",
          source_thread_id AS "sourceThreadId",
          source_provider AS "sourceProvider"
        FROM mind_memories
        WHERE project_id = ${projectId}
          AND text_hash = ${textHash}
      `,
  });

  const getMemoryRow = SqlSchema.findOneOption({
    Request: GetMindMemoryInput,
    Result: MindMemoryDbRow,
    execute: ({ memoryId }) =>
      sql`
        SELECT
          id AS "memoryId",
          project_id AS "projectId",
          text,
          type,
          text_hash AS "textHash",
          peak_weight AS "peakWeight",
          access_count AS "accessCount",
          pinned,
          created_at AS "createdAt",
          last_accessed_at AS "lastAccessedAt",
          provenance_kind AS "provenanceKind",
          source_thread_id AS "sourceThreadId",
          source_provider AS "sourceProvider"
        FROM mind_memories
        WHERE id = ${memoryId}
      `,
  });

  const listMemoryRows = SqlSchema.findAll({
    Request: ListMindMemoriesInput,
    Result: MindMemoryDbRow,
    execute: ({ projectId, limit }) =>
      sql`
        SELECT
          id AS "memoryId",
          project_id AS "projectId",
          text,
          type,
          text_hash AS "textHash",
          peak_weight AS "peakWeight",
          access_count AS "accessCount",
          pinned,
          created_at AS "createdAt",
          last_accessed_at AS "lastAccessedAt",
          provenance_kind AS "provenanceKind",
          source_thread_id AS "sourceThreadId",
          source_provider AS "sourceProvider"
        FROM mind_memories
        WHERE project_id = ${projectId}
        ORDER BY pinned DESC, last_accessed_at DESC, id ASC
        LIMIT ${limit ?? MIND_MEMORY_PROJECT_CAP}
      `,
  });

  const searchCandidateRows = SqlSchema.findAll({
    Request: SearchMindCandidatesInput,
    Result: MindMemoryCandidateDbRow,
    execute: ({ projectId, matchExpr, limit }) =>
      sql`
        SELECT
          m.id AS "memoryId",
          m.project_id AS "projectId",
          m.text AS "text",
          m.type AS "type",
          m.text_hash AS "textHash",
          m.peak_weight AS "peakWeight",
          m.access_count AS "accessCount",
          m.pinned AS "pinned",
          m.created_at AS "createdAt",
          m.last_accessed_at AS "lastAccessedAt",
          m.provenance_kind AS "provenanceKind",
          m.source_thread_id AS "sourceThreadId",
          m.source_provider AS "sourceProvider",
          bm25(mind_memories_fts) AS "bm25"
        FROM mind_memories_fts
        JOIN mind_memories AS m ON m.rowid = mind_memories_fts.rowid
        WHERE mind_memories_fts MATCH ${matchExpr}
          AND m.project_id = ${projectId}
        ORDER BY bm25(mind_memories_fts) ASC, m.id ASC
        LIMIT ${limit ?? MIND_RECALL_CANDIDATE_MAX_ITEMS}
      `,
  });

  const applyConfirmRow = SqlSchema.findOneOption({
    Request: ApplyMindConfirmInput,
    Result: MindMemoryDbRow,
    execute: ({ memoryId, peakWeight, lastAccessedAt }) =>
      sql`
        UPDATE mind_memories
        SET peak_weight = ${peakWeight},
            access_count = access_count + 1,
            last_accessed_at = ${lastAccessedAt}
        WHERE id = ${memoryId}
        RETURNING
          id AS "memoryId",
          project_id AS "projectId",
          text,
          type,
          text_hash AS "textHash",
          peak_weight AS "peakWeight",
          access_count AS "accessCount",
          pinned,
          created_at AS "createdAt",
          last_accessed_at AS "lastAccessedAt",
          provenance_kind AS "provenanceKind",
          source_thread_id AS "sourceThreadId",
          source_provider AS "sourceProvider"
      `,
  });

  const setPinnedRow = SqlSchema.findOneOption({
    Request: SetMindMemoryPinnedInput,
    Result: MindMemoryDbRow,
    execute: ({ memoryId, pinned }) =>
      sql`
        UPDATE mind_memories
        SET pinned = ${pinned ? 1 : 0}
        WHERE id = ${memoryId}
        RETURNING
          id AS "memoryId",
          project_id AS "projectId",
          text,
          type,
          text_hash AS "textHash",
          peak_weight AS "peakWeight",
          access_count AS "accessCount",
          pinned,
          created_at AS "createdAt",
          last_accessed_at AS "lastAccessedAt",
          provenance_kind AS "provenanceKind",
          source_thread_id AS "sourceThreadId",
          source_provider AS "sourceProvider"
      `,
  });

  const deleteMemoryRow = SqlSchema.findAll({
    Request: DeleteMindMemoryInput,
    Result: Schema.Struct({ memoryId: MindMemoryId }),
    execute: ({ memoryId }) =>
      sql`
        DELETE FROM mind_memories
        WHERE id = ${memoryId}
        RETURNING id AS "memoryId"
      `,
  });

  const appendJournalRow = SqlSchema.void({
    Request: AppendMindJournalInput,
    execute: ({ projectId, memoryId, op, actor, threadId, turnId, createdAt }) =>
      sql`
        INSERT INTO mind_journal (
          project_id,
          memory_id,
          op,
          actor,
          thread_id,
          turn_id,
          created_at
        )
        VALUES (
          ${projectId},
          ${memoryId},
          ${op},
          ${encodeJournalActor(actor)},
          ${threadId},
          ${turnId},
          ${createdAt}
        )
      `,
  });

  const findJournalRow = SqlSchema.findOneOption({
    Request: FindMindJournalOpInput,
    Result: MindJournalDbRow,
    execute: ({ memoryId, op, turnId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          memory_id AS "memoryId",
          op,
          actor,
          thread_id AS "threadId",
          turn_id AS "turnId",
          created_at AS "createdAt"
        FROM mind_journal
        WHERE memory_id = ${memoryId}
          AND op = ${op}
          AND (
            (${turnId} IS NULL AND turn_id IS NULL)
            OR turn_id = ${turnId}
          )
        ORDER BY id ASC
        LIMIT 1
      `,
  });

  const countMemoryRows = SqlSchema.findAll({
    Request: CountMindMemoriesInput,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: ({ projectId }) =>
      sql`
        SELECT COUNT(*) AS "count"
        FROM mind_memories
        WHERE project_id = ${projectId}
      `,
  });

  const getReceiptRow = SqlSchema.findOneOption({
    Request: GetMindReceiptInput,
    Result: MindReceiptDbRow,
    execute: ({ projectId, operationId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          operation_id AS "operationId",
          op,
          result_json AS "resultJson",
          created_at AS "createdAt"
        FROM mind_operation_receipts
        WHERE project_id = ${projectId}
          AND operation_id = ${operationId}
      `,
  });

  const putReceiptRow = SqlSchema.findAll({
    Request: PutMindReceiptInput,
    Result: Schema.Struct({ operationId: Schema.String }),
    execute: ({ projectId, operationId, op, resultJson, createdAt }) =>
      sql`
        INSERT OR IGNORE INTO mind_operation_receipts (
          project_id,
          operation_id,
          op,
          result_json,
          created_at
        )
        VALUES (
          ${projectId},
          ${operationId},
          ${op},
          ${resultJson},
          ${createdAt}
        )
        RETURNING operation_id AS "operationId"
      `,
  });

  const insert: MindRepositoryShape["insert"] = (input) =>
    insertMemoryRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.insert:insert")),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              toPersistenceDecodeCauseError("MindRepository.insert:missingRow")(
                new Error("Mind memory was not found after insert."),
              ),
            ),
          onSome: toMemory,
        }),
      ),
    );

  const findByTextHash: MindRepositoryShape["findByTextHash"] = (input) =>
    findMemoryByTextHashRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.findByTextHash:query")),
      Effect.flatMap(toMemoryOption),
    );

  const getById: MindRepositoryShape["getById"] = (input) =>
    getMemoryRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.getById:query")),
      Effect.flatMap(toMemoryOption),
    );

  const listByProject: MindRepositoryShape["listByProject"] = (input) =>
    listMemoryRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.listByProject:query")),
      Effect.flatMap(toMemoryListSafe),
    );

  const listAllMemoryRows = SqlSchema.findAll({
    Request: ListAllMindMemoriesInput,
    Result: MindMemoryDbRow,
    execute: ({ limit }) =>
      sql`
        SELECT
          id AS "memoryId",
          project_id AS "projectId",
          text,
          type,
          text_hash AS "textHash",
          peak_weight AS "peakWeight",
          access_count AS "accessCount",
          pinned,
          created_at AS "createdAt",
          last_accessed_at AS "lastAccessedAt",
          provenance_kind AS "provenanceKind",
          source_thread_id AS "sourceThreadId",
          source_provider AS "sourceProvider"
        FROM mind_memories
        ORDER BY pinned DESC, last_accessed_at DESC, id ASC
        LIMIT ${limit}
      `,
  });

  // Bounded to one project-cap page: the global Mind view never reads the
  // whole table. Callers pair this with `countAll` for the true total.
  const listAll: MindRepositoryShape["listAll"] = (input) =>
    listAllMemoryRows({ limit: input?.limit ?? MIND_MEMORY_PROJECT_CAP }).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.listAll:query")),
      Effect.flatMap(toMemoryListSafe),
    );

  const countAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: () =>
      sql`
        SELECT COUNT(*) AS "count"
        FROM mind_memories
      `,
  });

  const countAll: MindRepositoryShape["countAll"] = () =>
    countAllRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.countAll:query")),
      Effect.map((rows) => rows[0]?.count ?? 0),
    );

  const searchCandidates: MindRepositoryShape["searchCandidates"] = (input) => {
    // No indexable token (empty, punctuation/quotes-only) is not valid FTS5
    // syntax for a useful search; no tokens means no candidates, never a throw.
    if (!isFtsMatchExprQueryable(input.matchExpr)) {
      return Effect.succeed([]);
    }
    return searchCandidateRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.searchCandidates:query")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, toCandidateSafe, { concurrency: "unbounded" }).pipe(
          Effect.map((candidates) => candidates.filter((candidate) => candidate !== undefined)),
        ),
      ),
    );
  };

  const applyConfirm: MindRepositoryShape["applyConfirm"] = (input) =>
    applyConfirmRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.applyConfirm:update")),
      Effect.flatMap(toMemoryOption),
    );

  const setPinned: MindRepositoryShape["setPinned"] = (input) =>
    setPinnedRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.setPinned:update")),
      Effect.flatMap(toMemoryOption),
    );

  const deleteById: MindRepositoryShape["deleteById"] = (input) =>
    deleteMemoryRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.deleteById:delete")),
      Effect.map((rows) => rows.length > 0),
    );

  const appendJournal: MindRepositoryShape["appendJournal"] = (input) =>
    appendJournalRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.appendJournal:insert")),
    );

  const findJournalOp: MindRepositoryShape["findJournalOp"] = (input) =>
    findJournalRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.findJournalOp:query")),
      Effect.flatMap(toJournalEntryOption),
    );

  const countByProject: MindRepositoryShape["countByProject"] = (input) =>
    countMemoryRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.countByProject:query")),
      Effect.map((rows) => rows[0]?.count ?? 0),
    );

  const getReceipt: MindRepositoryShape["getReceipt"] = (input) =>
    getReceiptRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.getReceipt:query")),
    );

  const putReceipt: MindRepositoryShape["putReceipt"] = (input) =>
    putReceiptRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.putReceipt:insert")),
      Effect.map((rows) => rows.length > 0),
    );

  const pruneReceiptRows = SqlSchema.findAll({
    Request: PruneMindReceiptsInput,
    Result: Schema.Struct({ operationId: Schema.String }),
    execute: ({ projectId, olderThanIso, limit }) =>
      sql`
        DELETE FROM mind_operation_receipts
        WHERE rowid IN (
          SELECT r.rowid
          FROM mind_operation_receipts AS r
          WHERE r.project_id = ${projectId}
            AND r.created_at < ${olderThanIso}
            AND EXISTS (
              SELECT 1
              FROM mind_journal AS j
              WHERE j.project_id = r.project_id
                AND j.memory_id = json_extract(r.result_json, '$.memoryId')
                AND j.op = r.op
            )
          ORDER BY r.created_at ASC
          LIMIT ${limit}
        )
        RETURNING operation_id AS "operationId"
      `,
  });

  const pruneReceipts: MindRepositoryShape["pruneReceipts"] = (input) =>
    pruneReceiptRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("MindRepository.pruneReceipts:delete")),
      Effect.map((rows) => rows.length),
    );

  return {
    insert,
    findByTextHash,
    getById,
    listByProject,
    listAll,
    countAll,
    searchCandidates,
    applyConfirm,
    setPinned,
    deleteById,
    appendJournal,
    findJournalOp,
    countByProject,
    getReceipt,
    putReceipt,
    pruneReceipts,
  } satisfies MindRepositoryShape;
});

export const MindRepositoryLive = Layer.effect(MindRepository, makeMindRepository);
