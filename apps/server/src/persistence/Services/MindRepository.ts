import {
  IsoDateTime,
  MIND_MEMORY_PROJECT_CAP,
  MIND_RECALL_CANDIDATE_MAX_ITEMS,
  MindJournalEntry,
  MindJournalOp,
  MindMemory,
  MindMemoryId,
  MindMemoryType,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type MindRepositoryError = PersistenceSqlError | PersistenceDecodeError;

/** Per-run bound for the receipt retention sweep (see `pruneReceipts`). */
export const MIND_RECEIPT_PRUNE_MAX_ITEMS = 500;

/**
 * A stored mind memory: the persisted row (peak weight, decay anchor,
 * provenance) before any server-computed effective weight is derived from it.
 */
export const MindMemoryRow = Schema.Struct({
  memoryId: MindMemoryId,
  projectId: ProjectId,
  text: MindMemory.fields.text,
  type: MindMemoryType,
  textHash: Schema.String,
  peakWeight: MindMemory.fields.weight,
  accessCount: NonNegativeInt,
  pinned: Schema.Boolean,
  createdAt: IsoDateTime,
  lastAccessedAt: IsoDateTime,
  provenance: MindMemory.fields.provenance,
});
export type MindMemoryRow = typeof MindMemoryRow.Type;

/** An FTS candidate: the stored memory plus its raw (negative, lower-is-better) bm25 rank. */
export interface MindMemoryCandidate {
  readonly memory: MindMemoryRow;
  readonly bm25: number;
}

/** A durable operation receipt for retry idempotency (mind_operation_receipts row). */
export const MindReceiptRow = Schema.Struct({
  projectId: ProjectId,
  operationId: TrimmedNonEmptyString,
  op: Schema.String,
  resultJson: Schema.String,
  createdAt: IsoDateTime,
});
export type MindReceiptRow = typeof MindReceiptRow.Type;

export const InsertMindMemoryInput = MindMemoryRow;
export type InsertMindMemoryInput = typeof InsertMindMemoryInput.Type;

export const FindMindMemoryByTextHashInput = Schema.Struct({
  projectId: ProjectId,
  textHash: Schema.String,
});
export type FindMindMemoryByTextHashInput = typeof FindMindMemoryByTextHashInput.Type;

export const GetMindMemoryInput = Schema.Struct({
  memoryId: MindMemoryId,
});
export type GetMindMemoryInput = typeof GetMindMemoryInput.Type;

export const ListMindMemoriesInput = Schema.Struct({
  projectId: ProjectId,
  // The list surface is bounded by the per-project cap: no unbounded reads.
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MIND_MEMORY_PROJECT_CAP })),
  ).pipe(Schema.withDecodingDefault(() => MIND_MEMORY_PROJECT_CAP)),
});
export type ListMindMemoriesInput = typeof ListMindMemoriesInput.Type;

export const SearchMindCandidatesInput = Schema.Struct({
  projectId: ProjectId,
  /** Prebuilt FTS5 MATCH expression; build it with {@link buildMindFtsMatchExpr}. */
  matchExpr: Schema.String,
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MIND_RECALL_CANDIDATE_MAX_ITEMS })),
  ).pipe(Schema.withDecodingDefault(() => MIND_RECALL_CANDIDATE_MAX_ITEMS)),
});
export type SearchMindCandidatesInput = typeof SearchMindCandidatesInput.Type;

export const ListAllMindMemoriesInput = Schema.Struct({
  // The global Mind view is one cap-sized page; the true total comes from
  // `countAll` so callers can label truncation honestly.
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MIND_MEMORY_PROJECT_CAP })),
  ).pipe(Schema.withDecodingDefault(() => MIND_MEMORY_PROJECT_CAP)),
});
export type ListAllMindMemoriesInput = typeof ListAllMindMemoriesInput.Type;

export const PruneMindReceiptsInput = Schema.Struct({
  projectId: ProjectId,
  /** Receipts created strictly before this instant are retention-eligible. */
  olderThanIso: IsoDateTime,
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MIND_RECEIPT_PRUNE_MAX_ITEMS })),
  ).pipe(Schema.withDecodingDefault(() => MIND_RECEIPT_PRUNE_MAX_ITEMS)),
});
export type PruneMindReceiptsInput = typeof PruneMindReceiptsInput.Type;

export const ApplyMindConfirmInput = Schema.Struct({
  memoryId: MindMemoryId,
  peakWeight: MindMemory.fields.weight,
  lastAccessedAt: IsoDateTime,
});
export type ApplyMindConfirmInput = typeof ApplyMindConfirmInput.Type;

export const SetMindMemoryPinnedInput = Schema.Struct({
  memoryId: MindMemoryId,
  pinned: Schema.Boolean,
});
export type SetMindMemoryPinnedInput = typeof SetMindMemoryPinnedInput.Type;

/**
 * Inline edit: new text/hash plus the resolved type (callers keep the old
 * type when no change was requested), and the fresh decay anchor. Peak
 * weight and access count are never touched by an edit.
 */
export const ApplyMindUpdateInput = Schema.Struct({
  memoryId: MindMemoryId,
  text: MindMemory.fields.text,
  type: MindMemoryType,
  textHash: Schema.String,
  lastAccessedAt: IsoDateTime,
});
export type ApplyMindUpdateInput = typeof ApplyMindUpdateInput.Type;

/** One text-revision row: hash evidence of an edit, never memory text. */
export const MindTextRevisionRow = Schema.Struct({
  memoryId: MindMemoryId,
  oldHash: Schema.String,
  newHash: Schema.String,
  actor: MindJournalEntry.fields.actor,
  createdAt: IsoDateTime,
});
export type MindTextRevisionRow = typeof MindTextRevisionRow.Type;

export const InsertMindRevisionInput = MindTextRevisionRow;
export type InsertMindRevisionInput = typeof InsertMindRevisionInput.Type;

export const ListMindJournalForMemoryInput = Schema.Struct({
  memoryId: MindMemoryId,
});
export type ListMindJournalForMemoryInput = typeof ListMindJournalForMemoryInput.Type;

export const ListMindRevisionsInput = Schema.Struct({
  memoryId: MindMemoryId,
});
export type ListMindRevisionsInput = typeof ListMindRevisionsInput.Type;

export const DeleteMindMemoryInput = Schema.Struct({
  memoryId: MindMemoryId,
});
export type DeleteMindMemoryInput = typeof DeleteMindMemoryInput.Type;

export const AppendMindJournalInput = Schema.Struct({
  projectId: ProjectId,
  memoryId: MindMemoryId,
  op: MindJournalOp,
  actor: MindJournalEntry.fields.actor,
  threadId: Schema.NullOr(ThreadId),
  turnId: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type AppendMindJournalInput = typeof AppendMindJournalInput.Type;

export const FindMindJournalOpInput = Schema.Struct({
  memoryId: MindMemoryId,
  op: MindJournalOp,
  turnId: Schema.NullOr(TrimmedNonEmptyString),
});
export type FindMindJournalOpInput = typeof FindMindJournalOpInput.Type;

export const CountMindMemoriesInput = Schema.Struct({
  projectId: ProjectId,
});
export type CountMindMemoriesInput = typeof CountMindMemoriesInput.Type;

export const GetMindReceiptInput = Schema.Struct({
  projectId: ProjectId,
  operationId: TrimmedNonEmptyString,
});
export type GetMindReceiptInput = typeof GetMindReceiptInput.Type;

export const PutMindReceiptInput = MindReceiptRow;
export type PutMindReceiptInput = typeof PutMindReceiptInput.Type;

/**
 * Builds a safe FTS5 MATCH expression from raw user text: every whitespace
 * token is double-quoted (internal quotes doubled so they stay literal) and
 * turned into a prefix query with a trailing `*`. Quoting neutralizes FTS5
 * operator syntax (`AND`, `OR`, `NOT`, `NEAR(...)`, column filters), so user
 * text can never inject match operators.
 */
export const buildMindFtsMatchExpr = (query: string): string =>
  query
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replace(/"/g, '""')}"*`)
    .join(" ");

/**
 * Read guard for FTS5 candidate search: an expression with no letter or digit
 * (punctuation/quotes/whitespace only) can never match an indexed token, so
 * the caller returns [] without paying for an FTS parse. Letter- or
 * digit-bearing expressions — including CJK, which unicode61 accepts — still
 * query; FTS returns no rows for those, never throws.
 */
export const isFtsMatchExprQueryable = (matchExpr: string): boolean =>
  /[\p{L}\p{N}]/u.test(matchExpr);

export interface MindRepositoryShape {
  /**
   * Inserts a new memory row. The `UNIQUE (project_id, text_hash)` constraint
   * is honored, not bypassed: a duplicate insert fails, so dedupe surfaces as
   * a reinforce of the existing row (never a second row).
   */
  readonly insert: (
    input: InsertMindMemoryInput,
  ) => Effect.Effect<MindMemoryRow, MindRepositoryError>;
  readonly findByTextHash: (
    input: FindMindMemoryByTextHashInput,
  ) => Effect.Effect<Option.Option<MindMemoryRow>, MindRepositoryError>;
  readonly getById: (
    input: GetMindMemoryInput,
  ) => Effect.Effect<Option.Option<MindMemoryRow>, MindRepositoryError>;
  /**
   * Lists a project's memories pinned-first, then most recently accessed.
   * Callers re-rank by effective weight; this order is the deterministic base.
   * Poison rows (undecodable, e.g. legacy corruption) are skipped, never
   * fatal: callers reconcile `countByProject` against the shown rows.
   */
  readonly listByProject: (
    input: ListMindMemoriesInput,
  ) => Effect.Effect<ReadonlyArray<MindMemoryRow>, MindRepositoryError>;
  /**
   * Every memory across all projects, newest-access first. Backs the global
   * Mind list: memories whose project rows left the projection stay reachable.
   * Bounded to one project-cap page (see `ListAllMindMemoriesInput`); the true
   * total comes from `countAll`. Poison rows are skipped, never fatal.
   */
  readonly listAll: (
    input?: ListAllMindMemoriesInput,
  ) => Effect.Effect<ReadonlyArray<MindMemoryRow>, MindRepositoryError>;
  /** True total across all projects — the denominator for the bounded `listAll` page. */
  readonly countAll: () => Effect.Effect<number, MindRepositoryError>;
  /**
   * FTS5 candidate fetch: joins `mind_memories` against `mind_memories_fts`
   * and returns rows with their raw bm25 rank (best first). The match
   * expression must come from {@link buildMindFtsMatchExpr}; it is always a
   * bound parameter, never concatenated SQL.
   */
  readonly searchCandidates: (
    input: SearchMindCandidatesInput,
  ) => Effect.Effect<ReadonlyArray<MindMemoryCandidate>, MindRepositoryError>;
  /**
   * Reinforces a memory: sets the confirmed peak weight, resets the decay
   * anchor, and bumps the access count. Returns none if the memory is gone.
   */
  readonly applyConfirm: (
    input: ApplyMindConfirmInput,
  ) => Effect.Effect<Option.Option<MindMemoryRow>, MindRepositoryError>;
  readonly setPinned: (
    input: SetMindMemoryPinnedInput,
  ) => Effect.Effect<Option.Option<MindMemoryRow>, MindRepositoryError>;
  /**
   * Inline edit: sets text/type/hash, resets the decay anchor, leaves peak
   * weight and access count alone. Returns none if the memory is gone.
   */
  readonly applyUpdate: (
    input: ApplyMindUpdateInput,
  ) => Effect.Effect<Option.Option<MindMemoryRow>, MindRepositoryError>;
  /** Records hash-only revision evidence for an edit (never memory text). */
  readonly insertRevision: (
    input: InsertMindRevisionInput,
  ) => Effect.Effect<void, MindRepositoryError>;
  /** Every journal row for one memory, oldest first (op timeline, no text). */
  readonly listJournalForMemory: (
    input: ListMindJournalForMemoryInput,
  ) => Effect.Effect<ReadonlyArray<MindJournalEntry>, MindRepositoryError>;
  /** Every revision row for one memory, oldest first. */
  readonly listRevisions: (
    input: ListMindRevisionsInput,
  ) => Effect.Effect<ReadonlyArray<MindTextRevisionRow>, MindRepositoryError>;
  /** Deletes a memory row (FTS sync trigger keeps the index in step). True when a row was deleted. */
  readonly deleteById: (
    input: DeleteMindMemoryInput,
  ) => Effect.Effect<boolean, MindRepositoryError>;
  /** Appends an op-only journal row. Journal rows never carry memory text. */
  readonly appendJournal: (
    input: AppendMindJournalInput,
  ) => Effect.Effect<void, MindRepositoryError>;
  /** Idempotency lookup: the journal row for `(memoryId, op, turnId)`, if any. */
  readonly findJournalOp: (
    input: FindMindJournalOpInput,
  ) => Effect.Effect<Option.Option<MindJournalEntry>, MindRepositoryError>;
  readonly countByProject: (
    input: CountMindMemoriesInput,
  ) => Effect.Effect<number, MindRepositoryError>;
  readonly getReceipt: (
    input: GetMindReceiptInput,
  ) => Effect.Effect<Option.Option<MindReceiptRow>, MindRepositoryError>;
  /**
   * Records an operation receipt. Returns true when this call created the row;
   * false means the `(project_id, operation_id)` receipt already existed and
   * the caller should replay the recorded result instead of re-applying.
   */
  readonly putReceipt: (input: PutMindReceiptInput) => Effect.Effect<boolean, MindRepositoryError>;
  /**
   * Retention sweep for operation receipts: deletes up to `limit` receipts
   * older than `olderThanIso`, but only when a journal row for the same
   * `(project, memory, op)` exists — the journal is the replay fallback, so a
   * retry after GC still replays instead of re-applying. Returns the deleted
   * count. Receipts without a proving journal row are always kept.
   */
  readonly pruneReceipts: (
    input: PruneMindReceiptsInput,
  ) => Effect.Effect<number, MindRepositoryError>;
}

export class MindRepository extends ServiceMap.Service<MindRepository, MindRepositoryShape>()(
  "synara/persistence/Services/MindRepository",
) {}
