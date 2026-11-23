import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as SchemaGetter from "effect/SchemaGetter";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import {
  type PersistenceDecodeError,
  type PersistenceSqlError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  toPersistenceSqlOrDecodeError,
} from "../Errors.ts";
import {
  ExternalHistoryBatchRecord,
  ExternalHistoryJobRecord,
  ExternalHistoryLinkRecord,
  ExternalHistoryMessageRecord,
  ExternalHistoryRepository,
  type ExternalHistoryRepositoryShape,
  ExternalHistorySourceRecord,
  FindSourceInput,
  GetBatchInput,
  GetJobInput,
  GetLinkByThreadInput,
  GetLinkInput,
  GetSourceInput,
  ListBySourceInput,
  ListMessagesInput,
  UpdateBatchStateInput,
} from "../Services/ExternalHistory.ts";

const SqliteBoolean = Schema.Number.pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value !== 0),
    encode: SchemaGetter.transform((value) => (value ? 1 : 0)),
  }),
);

const JsonColumn = <T, E, RD, RE>(inner: Schema.Codec<T, E, RD, RE>) =>
  Schema.NullOr(Schema.fromJsonString(inner));

const SourceDbRow = ExternalHistorySourceRecord.mapFields(
  Struct.assign({
    filters: JsonColumn(Schema.Json),
    enabled: SqliteBoolean,
    paused: SqliteBoolean,
  }),
);

const LinkDbRow = ExternalHistoryLinkRecord.mapFields(
  Struct.assign({
    nativeResumeDescriptor: JsonColumn(Schema.Json),
    upstreamMetadata: JsonColumn(Schema.Json),
    userOverrideFlags: JsonColumn(Schema.Json),
  }),
);

const JobDbRow = ExternalHistoryJobRecord.mapFields(
  Struct.assign({
    counters: JsonColumn(Schema.Json),
    checkpoint: JsonColumn(Schema.Json),
  }),
);

const BatchDbRow = ExternalHistoryBatchRecord.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Json),
  }),
);

const decodeSource = Schema.decodeUnknownEffect(ExternalHistorySourceRecord);
const decodeLink = Schema.decodeUnknownEffect(ExternalHistoryLinkRecord);
const decodeJob = Schema.decodeUnknownEffect(ExternalHistoryJobRecord);
const decodeBatch = Schema.decodeUnknownEffect(ExternalHistoryBatchRecord);
const decodeMessage = Schema.decodeUnknownEffect(ExternalHistoryMessageRecord);

const decodeEach =
  <A>(decode: (row: unknown) => Effect.Effect<A, Schema.SchemaError>, operation: string) =>
  (rows: ReadonlyArray<unknown>): Effect.Effect<ReadonlyArray<A>, PersistenceDecodeError> =>
    Effect.forEach(rows, decode, { concurrency: "unbounded" }).pipe(
      Effect.mapError(toPersistenceDecodeError(operation)),
    );

const decodeOptional =
  <A>(decode: (row: unknown) => Effect.Effect<A, Schema.SchemaError>, operation: string) =>
  (option: Option.Option<unknown>): Effect.Effect<Option.Option<A>, PersistenceDecodeError> =>
    Option.match(option, {
      onNone: () => Effect.succeed(Option.none<A>()),
      onSome: (row) =>
        decode(row).pipe(
          Effect.mapError(toPersistenceDecodeError(operation)),
          Effect.map(Option.some),
        ),
    });

const makeExternalHistoryRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // ---------- sources ----------

  const upsertSourceRow = SqlSchema.void({
    Request: ExternalHistorySourceRecord,
    execute: (source) =>
      sql`
        INSERT INTO external_history_sources (
          source_id, kind, scope_identity, filters_json, decoder_version,
          enabled, paused, credential_ref, scope_generation,
          last_discovery_success_at, last_error_code, created_at, updated_at
        ) VALUES (
          ${source.sourceId}, ${source.kind}, ${source.scopeIdentity},
          ${source.filters === null ? null : JSON.stringify(source.filters)},
          ${source.decoderVersion}, ${source.enabled ? 1 : 0}, ${source.paused ? 1 : 0},
          ${source.credentialRef}, ${source.scopeGeneration},
          ${source.lastDiscoverySuccessAt}, ${source.lastErrorCode},
          ${source.createdAt}, ${source.updatedAt}
        )
        ON CONFLICT (source_id) DO UPDATE SET
          kind = excluded.kind,
          scope_identity = excluded.scope_identity,
          filters_json = excluded.filters_json,
          decoder_version = excluded.decoder_version,
          enabled = excluded.enabled,
          paused = excluded.paused,
          credential_ref = excluded.credential_ref,
          scope_generation = excluded.scope_generation,
          last_discovery_success_at = excluded.last_discovery_success_at,
          last_error_code = excluded.last_error_code,
          updated_at = excluded.updated_at
      `,
  });

  const insertSourceIfAbsent = SqlSchema.void({
    Request: ExternalHistorySourceRecord,
    execute: (source) =>
      sql`
        INSERT OR IGNORE INTO external_history_sources (
          source_id, kind, scope_identity, filters_json, decoder_version,
          enabled, paused, credential_ref, scope_generation,
          last_discovery_success_at, last_error_code, created_at, updated_at
        ) VALUES (
          ${source.sourceId}, ${source.kind}, ${source.scopeIdentity},
          ${source.filters === null ? null : JSON.stringify(source.filters)},
          ${source.decoderVersion}, ${source.enabled ? 1 : 0}, ${source.paused ? 1 : 0},
          ${source.credentialRef}, ${source.scopeGeneration},
          ${source.lastDiscoverySuccessAt}, ${source.lastErrorCode},
          ${source.createdAt}, ${source.updatedAt}
        )
      `,
  });

  const SOURCE_COLUMNS = sql`
    source_id AS "sourceId",
    kind,
    scope_identity AS "scopeIdentity",
    filters_json AS "filters",
    decoder_version AS "decoderVersion",
    enabled,
    paused,
    credential_ref AS "credentialRef",
    scope_generation AS "scopeGeneration",
    last_discovery_success_at AS "lastDiscoverySuccessAt",
    last_error_code AS "lastErrorCode",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;

  const getSourceRow = SqlSchema.findOneOption({
    Request: GetSourceInput,
    Result: SourceDbRow,
    execute: ({ sourceId }) =>
      sql`SELECT ${SOURCE_COLUMNS} FROM external_history_sources WHERE source_id = ${sourceId}`,
  });

  const findSourceRow = SqlSchema.findOneOption({
    Request: FindSourceInput,
    Result: SourceDbRow,
    execute: ({ kind, scopeIdentity }) =>
      sql`
        SELECT ${SOURCE_COLUMNS} FROM external_history_sources
        WHERE kind = ${kind} AND scope_identity = ${scopeIdentity}
      `,
  });

  const listSourceRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SourceDbRow,
    execute: () =>
      sql`SELECT ${SOURCE_COLUMNS} FROM external_history_sources ORDER BY created_at ASC, source_id ASC`,
  });

  // ---------- links ----------

  const upsertLinkRow = SqlSchema.void({
    Request: ExternalHistoryLinkRecord,
    execute: (link) =>
      sql`
        INSERT INTO external_history_links (
          link_id, source_id, external_session_id, thread_id, source_revision,
          committed_message_cursor, history_status, native_resume_descriptor_json,
          upstream_metadata_json, user_override_flags_json, suppressed_at,
          created_at, updated_at
        ) VALUES (
          ${link.linkId}, ${link.sourceId}, ${link.externalSessionId}, ${link.threadId},
          ${link.sourceRevision}, ${link.committedMessageCursor}, ${link.historyStatus},
          ${link.nativeResumeDescriptor == null ? null : JSON.stringify(link.nativeResumeDescriptor)},
          ${link.upstreamMetadata == null ? null : JSON.stringify(link.upstreamMetadata)},
          ${link.userOverrideFlags == null ? null : JSON.stringify(link.userOverrideFlags)},
          ${link.suppressedAt}, ${link.createdAt}, ${link.updatedAt}
        )
        ON CONFLICT (source_id, external_session_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          source_revision = excluded.source_revision,
          committed_message_cursor = excluded.committed_message_cursor,
          history_status = excluded.history_status,
          native_resume_descriptor_json = excluded.native_resume_descriptor_json,
          upstream_metadata_json = excluded.upstream_metadata_json,
          user_override_flags_json = excluded.user_override_flags_json,
          suppressed_at = excluded.suppressed_at,
          updated_at = excluded.updated_at
      `,
  });

  const LINK_COLUMNS = sql`
    link_id AS "linkId",
    source_id AS "sourceId",
    external_session_id AS "externalSessionId",
    thread_id AS "threadId",
    source_revision AS "sourceRevision",
    committed_message_cursor AS "committedMessageCursor",
    history_status AS "historyStatus",
    native_resume_descriptor_json AS "nativeResumeDescriptor",
    upstream_metadata_json AS "upstreamMetadata",
    user_override_flags_json AS "userOverrideFlags",
    suppressed_at AS "suppressedAt",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;

  const getLinkRow = SqlSchema.findOneOption({
    Request: GetLinkInput,
    Result: LinkDbRow,
    execute: ({ sourceId, externalSessionId }) =>
      sql`
        SELECT ${LINK_COLUMNS} FROM external_history_links
        WHERE source_id = ${sourceId} AND external_session_id = ${externalSessionId}
      `,
  });

  const getLinkRowByThread = SqlSchema.findOneOption({
    Request: GetLinkByThreadInput,
    Result: LinkDbRow,
    execute: ({ threadId }) =>
      sql`SELECT ${LINK_COLUMNS} FROM external_history_links WHERE thread_id = ${threadId}`,
  });

  const listLinkRowsBySource = SqlSchema.findAll({
    Request: ListBySourceInput,
    Result: LinkDbRow,
    execute: ({ sourceId }) =>
      sql`
        SELECT ${LINK_COLUMNS} FROM external_history_links
        WHERE source_id = ${sourceId}
        ORDER BY created_at ASC, link_id ASC
      `,
  });

  // ---------- messages ----------

  const upsertMessageRow = SqlSchema.void({
    Request: ExternalHistoryMessageRecord,
    execute: (message) =>
      sql`
        INSERT INTO external_history_messages (
          link_id, upstream_message_id, synara_message_id, source_order,
          content_hash, source_revision, original_timestamp, visibility,
          created_at, updated_at
        ) VALUES (
          ${message.linkId}, ${message.upstreamMessageId}, ${message.synaraMessageId},
          ${message.sourceOrder}, ${message.contentHash}, ${message.sourceRevision},
          ${message.originalTimestamp}, ${message.visibility},
          ${message.createdAt}, ${message.updatedAt}
        )
        ON CONFLICT (link_id, upstream_message_id) DO UPDATE SET
          synara_message_id = excluded.synara_message_id,
          source_order = excluded.source_order,
          content_hash = excluded.content_hash,
          source_revision = excluded.source_revision,
          original_timestamp = excluded.original_timestamp,
          visibility = excluded.visibility,
          updated_at = excluded.updated_at
        WHERE
          external_history_messages.source_revision IS NULL
          OR excluded.source_revision IS NULL
          OR excluded.source_revision >= external_history_messages.source_revision
      `,
  });

  const listMessageRowsByLink = SqlSchema.findAll({
    Request: ListMessagesInput,
    Result: ExternalHistoryMessageRecord,
    execute: ({ linkId }) =>
      sql`
        SELECT
          link_id AS "linkId",
          upstream_message_id AS "upstreamMessageId",
          synara_message_id AS "synaraMessageId",
          source_order AS "sourceOrder",
          content_hash AS "contentHash",
          source_revision AS "sourceRevision",
          original_timestamp AS "originalTimestamp",
          visibility,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM external_history_messages
        WHERE link_id = ${linkId}
        ORDER BY source_order ASC, upstream_message_id ASC
      `,
  });

  // ---------- jobs ----------

  const upsertJobRow = SqlSchema.void({
    Request: ExternalHistoryJobRecord,
    execute: (job) =>
      sql`
        INSERT INTO external_history_jobs (
          job_id, source_id, scope_generation, scan_upper_bound, page_cursor,
          status, counters_json, retries, lease_owner, lease_expires_at,
          checkpoint_json, created_at, updated_at
        ) VALUES (
          ${job.jobId}, ${job.sourceId}, ${job.scopeGeneration}, ${job.scanUpperBound},
          ${job.pageCursor}, ${job.status},
          ${job.counters == null ? null : JSON.stringify(job.counters)}, ${job.retries},
          ${job.leaseOwner}, ${job.leaseExpiresAt},
          ${job.checkpoint == null ? null : JSON.stringify(job.checkpoint)},
          ${job.createdAt}, ${job.updatedAt}
        )
        ON CONFLICT (job_id) DO UPDATE SET
          source_id = excluded.source_id,
          scope_generation = excluded.scope_generation,
          scan_upper_bound = excluded.scan_upper_bound,
          page_cursor = excluded.page_cursor,
          status = excluded.status,
          counters_json = excluded.counters_json,
          retries = excluded.retries,
          lease_owner = excluded.lease_owner,
          lease_expires_at = excluded.lease_expires_at,
          checkpoint_json = excluded.checkpoint_json,
          updated_at = excluded.updated_at
      `,
  });

  const JOB_COLUMNS = sql`
    job_id AS "jobId",
    source_id AS "sourceId",
    scope_generation AS "scopeGeneration",
    scan_upper_bound AS "scanUpperBound",
    page_cursor AS "pageCursor",
    status,
    counters_json AS "counters",
    retries,
    lease_owner AS "leaseOwner",
    lease_expires_at AS "leaseExpiresAt",
    checkpoint_json AS "checkpoint",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;

  const getJobRow = SqlSchema.findOneOption({
    Request: GetJobInput,
    Result: JobDbRow,
    execute: ({ jobId }) =>
      sql`SELECT ${JOB_COLUMNS} FROM external_history_jobs WHERE job_id = ${jobId}`,
  });

  const listJobRowsBySource = SqlSchema.findAll({
    Request: ListBySourceInput,
    Result: JobDbRow,
    execute: ({ sourceId }) =>
      sql`
        SELECT ${JOB_COLUMNS} FROM external_history_jobs
        WHERE source_id = ${sourceId}
        ORDER BY created_at ASC, job_id ASC
      `,
  });

  // ---------- batches ----------

  const insertBatchRow = SqlSchema.void({
    Request: ExternalHistoryBatchRecord,
    execute: (batch) =>
      sql`
        INSERT OR IGNORE INTO external_history_batches (
          batch_id, job_id, link_id, payload_json, payload_hash, command_id,
          state, accepted_sequence, next_cursor, created_at, updated_at
        ) VALUES (
          ${batch.batchId}, ${batch.jobId}, ${batch.linkId},
          ${JSON.stringify(batch.payload)},
          ${batch.payloadHash}, ${batch.commandId}, ${batch.state},
          ${batch.acceptedSequence}, ${batch.nextCursor},
          ${batch.createdAt}, ${batch.updatedAt}
        )
      `,
  });

  const getBatchRow = SqlSchema.findOneOption({
    Request: GetBatchInput,
    Result: BatchDbRow,
    execute: ({ batchId }) =>
      sql`
        SELECT
          batch_id AS "batchId",
          job_id AS "jobId",
          link_id AS "linkId",
          payload_json AS "payload",
          payload_hash AS "payloadHash",
          command_id AS "commandId",
          state,
          accepted_sequence AS "acceptedSequence",
          next_cursor AS "nextCursor",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM external_history_batches
        WHERE batch_id = ${batchId}
      `,
  });

  const updateBatchStateRow = SqlSchema.void({
    Request: UpdateBatchStateInput,
    execute: ({ batchId, state, acceptedSequence, nextCursor, updatedAt }) =>
      sql`
        UPDATE external_history_batches
        SET state = ${state},
            accepted_sequence = ${acceptedSequence},
            next_cursor = ${nextCursor},
            updated_at = ${updatedAt}
        WHERE batch_id = ${batchId}
      `,
  });

  // ---------- public API ----------

  const upsertSource: ExternalHistoryRepositoryShape["upsertSource"] = (source) =>
    upsertSourceRow(source).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExternalHistoryRepository.upsertSource:query",
          "ExternalHistoryRepository.upsertSource:encodeRequest",
        ),
      ),
    );

  const getOrCreateSource: ExternalHistoryRepositoryShape["getOrCreateSource"] = (source) =>
    insertSourceIfAbsent(source).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExternalHistoryRepository.getOrCreateSource:insert",
          "ExternalHistoryRepository.getOrCreateSource:encodeRequest",
        ),
      ),
      Effect.andThen(() =>
        findSourceRow({ kind: source.kind, scopeIdentity: source.scopeIdentity }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ExternalHistoryRepository.getOrCreateSource:lookup",
              "ExternalHistoryRepository.getOrCreateSource:decodeRow",
            ),
          ),
          Effect.flatMap(
            (
              rowOption,
            ): Effect.Effect<
              ExternalHistorySourceRecord,
              PersistenceSqlError | PersistenceDecodeError
            > =>
              Option.isSome(rowOption)
                ? decodeSource(rowOption.value).pipe(
                    Effect.mapError(
                      toPersistenceDecodeError(
                        "ExternalHistoryRepository.getOrCreateSource:decode",
                      ),
                    ),
                  )
                : Effect.fail(
                    toPersistenceSqlError("ExternalHistoryRepository.getOrCreateSource:lookup")(
                      new Error("source row missing after insert"),
                    ),
                  ),
          ),
        ),
      ),
    );

  const getSource: ExternalHistoryRepositoryShape["getSource"] = (input) =>
    getSourceRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExternalHistoryRepository.getSource:query",
          "ExternalHistoryRepository.getSource:decodeRow",
        ),
      ),
      Effect.flatMap(
        decodeOptional(decodeSource, "ExternalHistoryRepository.getSource:rowToRecord"),
      ),
    );

  const findSource: ExternalHistoryRepositoryShape["findSource"] = (input) =>
    findSourceRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExternalHistoryRepository.findSource:query",
          "ExternalHistoryRepository.findSource:decodeRow",
        ),
      ),
      Effect.flatMap(
        decodeOptional(decodeSource, "ExternalHistoryRepository.findSource:rowToRecord"),
      ),
    );

  const listSources: ExternalHistoryRepositoryShape["listSources"] = () =>
    listSourceRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExternalHistoryRepository.listSources:query",
          "ExternalHistoryRepository.listSources:decodeRows",
        ),
      ),
      Effect.flatMap(decodeEach(decodeSource, "ExternalHistoryRepository.listSources:rowToRecord")),
    );

  const upsertLink: ExternalHistoryRepositoryShape["upsertLink"] = (link) =>
    upsertLinkRow(link).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExternalHistoryRepository.upsertLink:query",
          "ExternalHistoryRepository.upsertLink:encodeRequest",
        ),
      ),
    );

  const getLink: ExternalHistoryRepositoryShape["getLink"] = (input) =>
    getLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExternalHistoryRepository.getLink:query",
          "ExternalHistoryRepository.getLink:decodeRow",
        ),
      ),
      Effect.flatMap(decodeOptional(decodeLink, "ExternalHistoryRepository.getLink:rowToRecord")),
    );

  const getLinkByThreadId: ExternalHistoryRepositoryShape["getLinkByThreadId"] = (input) =>
    getLinkRowByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExternalHistoryRepository.getLinkByThreadId:query",
          "ExternalHistoryRepository.getLinkByThreadId:decodeRow",
        ),
      ),
      Effect.flatMap(
        decodeOptional(decodeLink, "ExternalHistoryRepository.getLinkByThreadId:rowToRecord"),
      ),
    );

  const listLinksBySource: ExternalHistoryRepositoryShape["listLinksBySource"] = (input) =>
    listLinkRowsBySource(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExternalHistoryRepository.listLinksBySource:query",
          "ExternalHistoryRepository.listLinksBySource:decodeRows",
        ),
      ),
      Effect.flatMap(
        decodeEach(decodeLink, "ExternalHistoryRepository.listLinksBySource:rowToRecord"),
      ),
    );

  const upsertMessages: ExternalHistoryRepositoryShape["upsertMessages"] = (messages) =>
    Effect.forEach(
      messages,
      (message) =>
        upsertMessageRow(message).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ExternalHistoryRepository.upsertMessages:query",
              "ExternalHistoryRepository.upsertMessages:encodeRequest",
            ),
          ),
          Effect.as(1),
        ),
      { concurrency: 1 },
    ).pipe(Effect.map((counts) => counts.reduce((sum, count) => sum + count, 0)));

  const listMessagesByLink: ExternalHistoryRepositoryShape["listMessagesByLink"] = (input) =>
    listMessageRowsByLink(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExternalHistoryRepository.listMessagesByLink:query",
          "ExternalHistoryRepository.listMessagesByLink:decodeRows",
        ),
      ),
      Effect.flatMap(
        decodeEach(decodeMessage, "ExternalHistoryRepository.listMessagesByLink:rowToRecord"),
      ),
    );

  const upsertJob: ExternalHistoryRepositoryShape["upsertJob"] = (job) =>
    upsertJobRow(job).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExternalHistoryRepository.upsertJob:query",
          "ExternalHistoryRepository.upsertJob:encodeRequest",
        ),
      ),
    );

  const getJob: ExternalHistoryRepositoryShape["getJob"] = (input) =>
    getJobRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExternalHistoryRepository.getJob:query",
          "ExternalHistoryRepository.getJob:decodeRow",
        ),
      ),
      Effect.flatMap(decodeOptional(decodeJob, "ExternalHistoryRepository.getJob:rowToRecord")),
    );

  const listJobsBySource: ExternalHistoryRepositoryShape["listJobsBySource"] = (input) =>
    listJobRowsBySource(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExternalHistoryRepository.listJobsBySource:query",
          "ExternalHistoryRepository.listJobsBySource:decodeRows",
        ),
      ),
      Effect.flatMap(
        decodeEach(decodeJob, "ExternalHistoryRepository.listJobsBySource:rowToRecord"),
      ),
    );

  const insertBatch: ExternalHistoryRepositoryShape["insertBatch"] = (batch) =>
    getBatchRow({ batchId: batch.batchId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExternalHistoryRepository.insertBatch:existsQuery",
          "ExternalHistoryRepository.insertBatch:existsDecode",
        ),
      ),
      Effect.flatMap(
        Option.match({
          // Deterministic batch ids make a retry of the same immutable payload
          // a no-op; a conflicting payload under a reused id surfaces as a
          // repository conflict rather than a silent skip.
          onSome: (existing) =>
            existing.payloadHash === batch.payloadHash
              ? Effect.succeed(false)
              : Effect.fail(
                  toPersistenceSqlError("ExternalHistoryRepository.insertBatch:conflict")(
                    new Error(`batch ${batch.batchId} already exists with a different payload`),
                  ),
                ),
          onNone: () =>
            insertBatchRow(batch).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ExternalHistoryRepository.insertBatch:query",
                  "ExternalHistoryRepository.insertBatch:encodeRequest",
                ),
              ),
              Effect.as(true),
            ),
        }),
      ),
    );

  const getBatch: ExternalHistoryRepositoryShape["getBatch"] = (input) =>
    getBatchRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExternalHistoryRepository.getBatch:query",
          "ExternalHistoryRepository.getBatch:decodeRow",
        ),
      ),
      Effect.flatMap(decodeOptional(decodeBatch, "ExternalHistoryRepository.getBatch:rowToRecord")),
    );

  const updateBatchState: ExternalHistoryRepositoryShape["updateBatchState"] = (input) =>
    updateBatchStateRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExternalHistoryRepository.updateBatchState:query",
          "ExternalHistoryRepository.updateBatchState:decodeRow",
        ),
      ),
    );

  return {
    upsertSource,
    getOrCreateSource,
    getSource,
    findSource,
    listSources,
    upsertLink,
    getLink,
    getLinkByThreadId,
    listLinksBySource,
    upsertMessages,
    listMessagesByLink,
    upsertJob,
    getJob,
    listJobsBySource,
    insertBatch,
    getBatch,
    updateBatchState,
  } satisfies ExternalHistoryRepositoryShape;
});

export const ExternalHistoryRepositoryLive = Layer.effect(
  ExternalHistoryRepository,
  makeExternalHistoryRepository,
);
