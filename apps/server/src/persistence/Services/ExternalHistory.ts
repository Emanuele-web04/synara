/**
 * ExternalHistoryRepository - Durable ledger for external provider history.
 *
 * Owns the five tables created by migration 145: configured sources, canonical
 * session links, per-upstream-message records, discovery/import jobs, and
 * immutable normalized batches. Source and link identity are stable across
 * credential rotation and rescans; batches carry deterministic command ids so
 * crash-retry replays are deduplicated by the engine receipt mechanism.
 *
 * @module ExternalHistoryRepository
 */
import {
  ExternalHistoryBatchState,
  ExternalHistoryJobStatus,
  ExternalHistoryLinkStatus,
  ExternalHistorySourceKind,
  IsoDateTime,
  ThreadId,
} from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type ExternalHistoryRepositoryError = PersistenceSqlError | PersistenceDecodeError;

// ===============================
// Record schemas
// ===============================

export const ExternalHistorySourceRecord = Schema.Struct({
  sourceId: Schema.String,
  kind: ExternalHistorySourceKind,
  scopeIdentity: Schema.String,
  filters: Schema.NullOr(Schema.Json),
  decoderVersion: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
  paused: Schema.Boolean,
  credentialRef: Schema.NullOr(Schema.String),
  scopeGeneration: Schema.Number,
  lastDiscoverySuccessAt: Schema.NullOr(IsoDateTime),
  lastErrorCode: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ExternalHistorySourceRecord = typeof ExternalHistorySourceRecord.Type;

export const ExternalHistoryLinkRecord = Schema.Struct({
  linkId: Schema.String,
  sourceId: Schema.String,
  externalSessionId: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  sourceRevision: Schema.NullOr(Schema.String),
  committedMessageCursor: Schema.NullOr(Schema.String),
  historyStatus: ExternalHistoryLinkStatus,
  nativeResumeDescriptor: Schema.NullOr(Schema.Json),
  upstreamMetadata: Schema.NullOr(Schema.Json),
  userOverrideFlags: Schema.NullOr(Schema.Json),
  suppressedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ExternalHistoryLinkRecord = typeof ExternalHistoryLinkRecord.Type;

export const ExternalHistoryMessageRecord = Schema.Struct({
  linkId: Schema.String,
  upstreamMessageId: Schema.String,
  synaraMessageId: Schema.NullOr(Schema.String),
  sourceOrder: Schema.Number,
  contentHash: Schema.NullOr(Schema.String),
  sourceRevision: Schema.NullOr(Schema.String),
  originalTimestamp: Schema.NullOr(IsoDateTime),
  visibility: Schema.Literals(["visible", "retracted"]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ExternalHistoryMessageRecord = typeof ExternalHistoryMessageRecord.Type;

export const ExternalHistoryJobRecord = Schema.Struct({
  jobId: Schema.String,
  sourceId: Schema.String,
  scopeGeneration: Schema.Number,
  scanUpperBound: Schema.NullOr(IsoDateTime),
  pageCursor: Schema.NullOr(Schema.String),
  status: ExternalHistoryJobStatus,
  counters: Schema.NullOr(Schema.Json),
  retries: Schema.Number,
  leaseOwner: Schema.NullOr(Schema.String),
  leaseExpiresAt: Schema.NullOr(IsoDateTime),
  checkpoint: Schema.NullOr(Schema.Json),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ExternalHistoryJobRecord = typeof ExternalHistoryJobRecord.Type;

export const ExternalHistoryBatchRecord = Schema.Struct({
  batchId: Schema.String,
  jobId: Schema.NullOr(Schema.String),
  linkId: Schema.NullOr(Schema.String),
  payload: Schema.Json,
  payloadHash: Schema.String,
  commandId: Schema.String,
  state: ExternalHistoryBatchState,
  acceptedSequence: Schema.NullOr(Schema.Number),
  nextCursor: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ExternalHistoryBatchRecord = typeof ExternalHistoryBatchRecord.Type;

// ===============================
// Input schemas
// ===============================

export const GetSourceInput = Schema.Struct({ sourceId: Schema.String });
export type GetSourceInput = typeof GetSourceInput.Type;
export const FindSourceInput = Schema.Struct({
  kind: ExternalHistorySourceKind,
  scopeIdentity: Schema.String,
});
export type FindSourceInput = typeof FindSourceInput.Type;
export const GetLinkInput = Schema.Struct({
  sourceId: Schema.String,
  externalSessionId: Schema.String,
});
export type GetLinkInput = typeof GetLinkInput.Type;
export const GetLinkByThreadInput = Schema.Struct({ threadId: ThreadId });
export type GetLinkByThreadInput = typeof GetLinkByThreadInput.Type;
export const ListBySourceInput = Schema.Struct({ sourceId: Schema.String });
export type ListBySourceInput = typeof ListBySourceInput.Type;
export const GetJobInput = Schema.Struct({ jobId: Schema.String });
export type GetJobInput = typeof GetJobInput.Type;
export const GetBatchInput = Schema.Struct({ batchId: Schema.String });
export type GetBatchInput = typeof GetBatchInput.Type;
export const ListMessagesInput = Schema.Struct({ linkId: Schema.String });
export type ListMessagesInput = typeof ListMessagesInput.Type;

export const UpdateBatchStateInput = Schema.Struct({
  batchId: Schema.String,
  state: ExternalHistoryBatchState,
  acceptedSequence: Schema.NullOr(Schema.Number),
  nextCursor: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type UpdateBatchStateInput = typeof UpdateBatchStateInput.Type;

// ===============================
// Service shape
// ===============================

export interface ExternalHistoryRepositoryShape {
  /** Insert or replace a source row. */
  readonly upsertSource: (
    source: ExternalHistorySourceRecord,
  ) => Effect.Effect<void, ExternalHistoryRepositoryError>;

  /**
   * Insert a source only when (kind, scopeIdentity) is new; returns the stored
   * row so reconnects reuse the canonical sourceId.
   */
  readonly getOrCreateSource: (
    source: ExternalHistorySourceRecord,
  ) => Effect.Effect<ExternalHistorySourceRecord, ExternalHistoryRepositoryError>;

  readonly getSource: (
    input: GetSourceInput,
  ) => Effect.Effect<Option.Option<ExternalHistorySourceRecord>, ExternalHistoryRepositoryError>;

  readonly findSource: (
    input: FindSourceInput,
  ) => Effect.Effect<Option.Option<ExternalHistorySourceRecord>, ExternalHistoryRepositoryError>;

  readonly listSources: () => Effect.Effect<
    ReadonlyArray<ExternalHistorySourceRecord>,
    ExternalHistoryRepositoryError
  >;

  readonly upsertLink: (
    link: ExternalHistoryLinkRecord,
  ) => Effect.Effect<void, ExternalHistoryRepositoryError>;

  readonly getLink: (
    input: GetLinkInput,
  ) => Effect.Effect<Option.Option<ExternalHistoryLinkRecord>, ExternalHistoryRepositoryError>;

  readonly getLinkByThreadId: (
    input: GetLinkByThreadInput,
  ) => Effect.Effect<Option.Option<ExternalHistoryLinkRecord>, ExternalHistoryRepositoryError>;

  readonly listLinksBySource: (
    input: ListBySourceInput,
  ) => Effect.Effect<ReadonlyArray<ExternalHistoryLinkRecord>, ExternalHistoryRepositoryError>;

  /**
   * Insert message records idempotently: existing (linkId, upstreamMessageId)
   * rows are replaced only by newer source revisions or equal revisions with
   * changed visible fields. Returns the number of rows written.
   */
  readonly upsertMessages: (
    messages: ReadonlyArray<ExternalHistoryMessageRecord>,
  ) => Effect.Effect<number, ExternalHistoryRepositoryError>;

  readonly listMessagesByLink: (
    input: ListMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ExternalHistoryMessageRecord>, ExternalHistoryRepositoryError>;

  readonly upsertJob: (
    job: ExternalHistoryJobRecord,
  ) => Effect.Effect<void, ExternalHistoryRepositoryError>;

  readonly getJob: (
    input: GetJobInput,
  ) => Effect.Effect<Option.Option<ExternalHistoryJobRecord>, ExternalHistoryRepositoryError>;

  readonly listJobsBySource: (
    input: ListBySourceInput,
  ) => Effect.Effect<ReadonlyArray<ExternalHistoryJobRecord>, ExternalHistoryRepositoryError>;

  /**
   * Insert an immutable batch; returns false when a batch with the same
   * batchId already exists (deterministic retry dedup).
   */
  readonly insertBatch: (
    batch: ExternalHistoryBatchRecord,
  ) => Effect.Effect<boolean, ExternalHistoryRepositoryError>;

  readonly getBatch: (
    input: GetBatchInput,
  ) => Effect.Effect<Option.Option<ExternalHistoryBatchRecord>, ExternalHistoryRepositoryError>;

  /** Update only the mutable bookkeeping fields of a batch. */
  readonly updateBatchState: (
    input: UpdateBatchStateInput,
  ) => Effect.Effect<void, ExternalHistoryRepositoryError>;
}

export class ExternalHistoryRepository extends ServiceMap.Service<
  ExternalHistoryRepository,
  ExternalHistoryRepositoryShape
>()("synara/persistence/Services/ExternalHistory/ExternalHistoryRepository") {}
