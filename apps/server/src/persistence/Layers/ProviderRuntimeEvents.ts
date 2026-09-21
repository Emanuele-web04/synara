import { NonNegativeInt, ProviderRuntimeEvent } from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PersistenceDecodeError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../Errors.ts";
import {
  PROVIDER_RUNTIME_EVENT_MAX_BYTES,
  PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED,
  ProviderRuntimeEventRepository,
  type PersistedProviderRuntimeEvent,
  type ProviderRuntimeEventRepositoryShape,
} from "../Services/ProviderRuntimeEvents.ts";

/** how far the cursor may advance between retention scans: the scan has no lower bound and re-probes the whole retained backlog per event — quadratic in turn length (measured 3ms/event at 16k); scanning per interval only delays deletes, and settling a turn still forces a scan; matched to PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED */
const PROVIDER_RUNTIME_EVENT_RETENTION_SCAN_INTERVAL = PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED;

const ProviderRuntimeEventJson = Schema.fromJsonString(ProviderRuntimeEvent);
const encodeEvent = Schema.encodeEffect(ProviderRuntimeEventJson);
const decodeEvent = Schema.decodeUnknownEffect(ProviderRuntimeEventJson);

const StoredRowSchema = Schema.Struct({
  sequence: NonNegativeInt,
  eventJson: Schema.String,
});
const decodeStoredRow = Schema.decodeUnknownEffect(StoredRowSchema);
const SequenceRowSchema = Schema.Struct({ sequence: NonNegativeInt });
const decodeSequenceRow = Schema.decodeUnknownEffect(SequenceRowSchema);

/** longest-prefix truncation that never splits a UTF-8 code point */
export const truncateUtf8ToBytes = (value: string, maxBytes: number): string => {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  let prefixEnd = maxBytes;
  while (prefixEnd > 0 && ((encoded[prefixEnd] ?? 0) & 0xc0) === 0x80) {
    prefixEnd -= 1;
  }
  return encoded.subarray(0, prefixEnd).toString("utf8");
};

/** per-string-leaf budget so one oversized field (a verbatim tool result) can't exhaust the journal budget */
const JOURNAL_STRING_LEAF_BUDGET_BYTES = 64 * 1024;

/** shrinks every string leaf, recursing records/arrays; non-string leaves kept — small or no safe truncation */
export const shrinkRuntimeEventStrings = (value: unknown): unknown => {
  if (typeof value === "string") {
    return truncateUtf8ToBytes(value, JOURNAL_STRING_LEAF_BUDGET_BYTES);
  }
  if (Array.isArray(value)) {
    return value.map(shrinkRuntimeEventStrings);
  }
  if (value !== null && typeof value === "object") {
    const shrunk: Record<string, unknown> = {};
    for (const [key, leaf] of Object.entries(value as Record<string, unknown>)) {
      shrunk[key] = shrinkRuntimeEventStrings(leaf);
    }
    return shrunk;
  }
  return value;
};

const encodePersistableEvent = (event: ProviderRuntimeEvent) =>
  Effect.gen(function* () {
    const eventJson = yield* encodeEvent(event).pipe(
      Effect.mapError(toPersistenceDecodeError("ProviderRuntimeEvent.append.encode")),
    );
    const originalBytes = Buffer.byteLength(eventJson, "utf8");
    if (originalBytes <= PROVIDER_RUNTIME_EVENT_MAX_BYTES) {
      return { event, eventJson };
    }

    // the raw payload is replaced by a forensics marker — its own copy of the tool output would re-blow the budget
    const compactedEvent = {
      ...event,
      payload: shrinkRuntimeEventStrings(event.payload),
      ...(event.raw !== undefined
        ? {
            raw: {
              source: event.raw.source,
              ...(event.raw.method !== undefined ? { method: event.raw.method } : {}),
              ...(event.raw.messageType !== undefined
                ? { messageType: event.raw.messageType }
                : {}),
              payload: {
                synaraTruncated: true,
                reason: "provider runtime event exceeded the durable journal size limit",
                originalBytes,
              },
            },
          }
        : {}),
    } as ProviderRuntimeEvent;
    const compactedJson = yield* encodeEvent(compactedEvent).pipe(
      Effect.mapError(toPersistenceDecodeError("ProviderRuntimeEvent.append.compact")),
    );
    if (Buffer.byteLength(compactedJson, "utf8") <= PROVIDER_RUNTIME_EVENT_MAX_BYTES) {
      return { event: compactedEvent, eventJson: compactedJson };
    }

    return yield* new PersistenceDecodeError({
      operation: "ProviderRuntimeEvent.append",
      issue: `Provider runtime event exceeds ${PROVIDER_RUNTIME_EVENT_MAX_BYTES} bytes after payload truncation and raw compaction.`,
    });
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const append: ProviderRuntimeEventRepositoryShape["append"] = (event) =>
    Effect.gen(function* () {
      const persistable = yield* encodePersistableEvent(event);
      const persistedEvent = persistable.event;
      const eventJson = persistable.eventJson;
      const appendResult = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // SQLite reserves the AUTOINCREMENT rowid before conflict handling — duplicates consume sequence; gaps are valid
            const inserted = yield* sql<Record<string, unknown>>`
            INSERT INTO provider_runtime_events (
              event_id, thread_id, turn_id, lifecycle_generation, event_type,
              event_json, persisted_at
            ) VALUES (
              ${event.eventId}, ${event.threadId}, ${event.turnId ?? null},
              ${event.lifecycleGeneration ?? null},
              ${event.type}, ${eventJson}, ${new Date().toISOString()}
            )
            ON CONFLICT(event_id) DO NOTHING
            RETURNING sequence
            `;
            if (inserted[0] !== undefined) {
              return { inserted: true as const, row: inserted[0] };
            }

            const existing = yield* sql<Record<string, unknown>>`
              SELECT sequence, event_json AS "eventJson"
              FROM provider_runtime_events
              WHERE event_id = ${event.eventId}
          `;
            return { inserted: false as const, row: existing[0] };
          }),
        )
        .pipe(Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.append")));
      const persisted = appendResult.inserted
        ? yield* decodeSequenceRow(appendResult.row).pipe(
            Effect.map((row) => ({ sequence: row.sequence, eventJson })),
            Effect.mapError(toPersistenceDecodeError("ProviderRuntimeEvent.append.row")),
          )
        : yield* decodeStoredRow(appendResult.row).pipe(
            Effect.mapError(toPersistenceDecodeError("ProviderRuntimeEvent.append.conflictRow")),
          );
      if (persisted.eventJson !== eventJson) {
        return yield* new PersistenceDecodeError({
          operation: "ProviderRuntimeEvent.append",
          issue: `Provider event '${event.eventId}' was reused with different content.`,
        });
      }
      return {
        sequence: persisted.sequence,
        event: persistedEvent,
      } satisfies PersistedProviderRuntimeEvent;
    });

  const getHighWaterSequence = sql<{ readonly highWaterSequence: number }>`
    SELECT COALESCE(MAX(sequence), 0) AS "highWaterSequence"
    FROM provider_runtime_events
  `.pipe(
    Effect.map((rows) => rows[0]?.highWaterSequence ?? 0),
    Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.getHighWaterSequence")),
  );

  const readAfter: ProviderRuntimeEventRepositoryShape["readAfter"] = (input) => {
    const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit)));
    return Effect.gen(function* () {
      const rows = yield* sql<Record<string, unknown>>`
        SELECT sequence, event_json AS "eventJson"
        FROM provider_runtime_events
        WHERE sequence > ${input.sequenceExclusive}
          AND sequence <= ${input.throughSequenceInclusive}
        ORDER BY sequence ASC
        LIMIT ${limit}
      `.pipe(Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.readAfter")));
      return yield* Effect.forEach(
        rows,
        (unknownRow) =>
          Effect.gen(function* () {
            const row = yield* decodeStoredRow(unknownRow).pipe(
              Effect.mapError(toPersistenceDecodeError("ProviderRuntimeEvent.readAfter.row")),
            );
            const event = yield* decodeEvent(row.eventJson).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  `ProviderRuntimeEvent.readAfter(sequence=${row.sequence})`,
                ),
              ),
            );
            return { sequence: row.sequence, event } satisfies PersistedProviderRuntimeEvent;
          }),
        { concurrency: 1 },
      );
    });
  };

  const getThreadCoverage: ProviderRuntimeEventRepositoryShape["getThreadCoverage"] = (threadId) =>
    sql<{
      readonly retainedCount: number;
      readonly oldestSequence: number | null;
      readonly highWaterSequence: number;
    }>`
      SELECT
        COUNT(*) AS "retainedCount",
        MIN(sequence) AS "oldestSequence",
        COALESCE(MAX(sequence), 0) AS "highWaterSequence"
      FROM provider_runtime_events
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map(
        (rows) => rows[0] ?? { retainedCount: 0, oldestSequence: null, highWaterSequence: 0 },
      ),
      Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.getThreadCoverage")),
    );

  const readThreadEvents: ProviderRuntimeEventRepositoryShape["readThreadEvents"] = (input) => {
    const beforeSequence = input.beforeSequenceExclusive ?? Number.MAX_SAFE_INTEGER;
    const turnFilter = input.turnId === undefined ? sql`` : sql`AND turn_id = ${input.turnId}`;
    const typeFilter =
      input.eventTypes === undefined || input.eventTypes.length === 0
        ? sql``
        : sql`AND event_type IN ${sql.in(input.eventTypes)}`;
    return Effect.gen(function* () {
      const rows = yield* sql<Record<string, unknown>>`
        SELECT sequence, event_json AS "eventJson"
        FROM provider_runtime_events
        WHERE thread_id = ${input.threadId}
          AND sequence <= ${input.throughSequenceInclusive}
          AND sequence < ${beforeSequence}
          ${turnFilter}
          ${typeFilter}
        ORDER BY sequence DESC
        LIMIT ${Math.max(1, Math.min(201, Math.floor(input.limit)))}
      `.pipe(Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.readThreadEvents")));
      return yield* Effect.forEach(
        rows,
        (unknownRow) =>
          Effect.gen(function* () {
            const row = yield* decodeStoredRow(unknownRow).pipe(
              Effect.mapError(
                toPersistenceDecodeError("ProviderRuntimeEvent.readThreadEvents.row"),
              ),
            );
            const event = yield* decodeEvent(row.eventJson).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  `ProviderRuntimeEvent.readThreadEvents(sequence=${row.sequence})`,
                ),
              ),
            );
            return { sequence: row.sequence, event } satisfies PersistedProviderRuntimeEvent;
          }),
        { concurrency: 1 },
      );
    });
  };

  const readAcceptedOpenTurnEvents: ProviderRuntimeEventRepositoryShape["readAcceptedOpenTurnEvents"] =
    (input) => {
      const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit)));
      return Effect.gen(function* () {
        const rows = yield* sql<Record<string, unknown>>`
          SELECT event.sequence, event.event_json AS "eventJson"
          FROM provider_runtime_events AS event
          INNER JOIN provider_runtime_open_turns AS open_turn
            ON open_turn.thread_id = event.thread_id
           AND open_turn.turn_id = event.turn_id
           AND event.sequence >= open_turn.first_sequence
          INNER JOIN provider_runtime_event_consumers AS consumer
            ON consumer.consumer_name = ${input.consumerName}
           AND event.sequence <= consumer.last_acked_sequence
          WHERE event.sequence > ${input.sequenceExclusive}
          ORDER BY event.sequence ASC
          LIMIT ${limit}
        `.pipe(
          Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.readAcceptedOpenTurnEvents")),
        );
        return yield* Effect.forEach(
          rows,
          (unknownRow) =>
            Effect.gen(function* () {
              const row = yield* decodeStoredRow(unknownRow).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("ProviderRuntimeEvent.readAcceptedOpenTurnEvents.row"),
                ),
              );
              const event = yield* decodeEvent(row.eventJson).pipe(
                Effect.mapError(
                  toPersistenceDecodeError(
                    `ProviderRuntimeEvent.readAcceptedOpenTurnEvents(sequence=${row.sequence})`,
                  ),
                ),
              );
              return { sequence: row.sequence, event } satisfies PersistedProviderRuntimeEvent;
            }),
          { concurrency: 1 },
        );
      });
    };

  // rows that can never produce output must not survive startup replay: settled turns, purged/deleted threads, archived threads whose turn isn't running; pruning is one-way so every criterion must describe a dead turn
  const pruneSettledOpenTurns: ProviderRuntimeEventRepositoryShape["pruneSettledOpenTurns"] = sql`
      DELETE FROM provider_runtime_open_turns
      WHERE EXISTS (
        SELECT 1
        FROM projection_turns AS turn
        WHERE turn.thread_id = provider_runtime_open_turns.thread_id
          AND turn.turn_id = provider_runtime_open_turns.turn_id
          AND turn.state IN ('interrupted', 'completed', 'error')
      )
      OR NOT EXISTS (
        SELECT 1
        FROM projection_threads AS thread
        WHERE thread.thread_id = provider_runtime_open_turns.thread_id
          AND thread.deleted_at IS NULL
      )
      OR (
        EXISTS (
          SELECT 1
          FROM projection_threads AS thread
          WHERE thread.thread_id = provider_runtime_open_turns.thread_id
            AND thread.archived_at IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM projection_turns AS turn
          WHERE turn.thread_id = provider_runtime_open_turns.thread_id
            AND turn.turn_id = provider_runtime_open_turns.turn_id
            AND turn.state NOT IN ('interrupted', 'completed', 'error')
        )
      )
    `.pipe(
    Effect.asVoid,
    Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.pruneSettledOpenTurns")),
  );

  const getConsumerCursor: ProviderRuntimeEventRepositoryShape["getConsumerCursor"] = (
    consumerName,
  ) =>
    sql<{ readonly lastAckedSequence: number }>`
        SELECT last_acked_sequence AS "lastAckedSequence"
        FROM provider_runtime_event_consumers
        WHERE consumer_name = ${consumerName}
      `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(
              new PersistenceDecodeError({
                operation: "ProviderRuntimeEvent.getConsumerCursor",
                issue: `Consumer '${consumerName}' is not registered.`,
              }),
            )
          : Effect.succeed(rows[0].lastAckedSequence),
      ),
      Effect.mapError((error) =>
        error instanceof PersistenceDecodeError
          ? error
          : toPersistenceSqlError("ProviderRuntimeEvent.getConsumerCursor")(error),
      ),
    );

  const hasPendingEventsForThreads: ProviderRuntimeEventRepositoryShape["hasPendingEventsForThreads"] =
    (input) => {
      if (input.threadIds.length === 0) return Effect.succeed(false);
      return Effect.gen(function* () {
        const cursor = yield* getConsumerCursor(input.consumerName);
        const rows = yield* sql<{ readonly present: number }>`
          SELECT 1 AS present
          FROM provider_runtime_events
          WHERE sequence > ${cursor}
            AND thread_id IN ${sql.in(input.threadIds)}
          LIMIT 1
        `.pipe(
          Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.hasPendingEventsForThreads")),
        );
        return rows.length > 0;
      });
    };

  type AckedEventRow = {
    readonly sequence: number;
    readonly eventType: string;
    readonly threadId: string;
    readonly turnId: string | null;
  };

  const isTerminalTurnEventType = (eventType: string) =>
    eventType === "turn.completed" || eventType === "turn.aborted";
  const isThreadTerminalEventType = (eventType: string) =>
    eventType === "session.exited" || eventType === "runtime.error";

  const recordAckedOpenTurn = (event: AckedEventRow, updatedAt: string) =>
    Effect.gen(function* () {
      const isTerminalTurnEvent = isTerminalTurnEventType(event.eventType);
      const isThreadTerminalEvent = isThreadTerminalEventType(event.eventType);
      if (event.turnId !== null && !isTerminalTurnEvent && !isThreadTerminalEvent) {
        yield* sql`
          INSERT INTO provider_runtime_open_turns (
            thread_id, turn_id, first_sequence, updated_at
          ) VALUES (
            ${event.threadId}, ${event.turnId}, ${event.sequence}, ${updatedAt}
          )
          ON CONFLICT (thread_id, turn_id) DO UPDATE SET
            first_sequence = MIN(
              provider_runtime_open_turns.first_sequence,
              excluded.first_sequence
            ),
            updated_at = excluded.updated_at
        `;
      } else if (event.turnId !== null) {
        yield* sql`
          DELETE FROM provider_runtime_open_turns
          WHERE thread_id = ${event.threadId} AND turn_id = ${event.turnId}
        `;
      } else if (isThreadTerminalEvent) {
        yield* sql`
          DELETE FROM provider_runtime_open_turns
          WHERE thread_id = ${event.threadId}
        `;
      } else if (isTerminalTurnEvent) {
        yield* sql`
          DELETE FROM provider_runtime_open_turns
          WHERE thread_id = ${event.threadId}
            AND 1 = (
              SELECT COUNT(*) FROM provider_runtime_open_turns
              WHERE thread_id = ${event.threadId}
            )
        `;
      }
      return isTerminalTurnEvent || isThreadTerminalEvent;
    });

  // pending rows sit above the cursor; open-turn rows stay replayable until terminal output; other history bounded to a diagnostic tail
  const sweepAcceptedHistoryThrough = (throughSequence: number) => sql`
    DELETE FROM provider_runtime_events AS event
    WHERE event.sequence <= ${throughSequence}
      AND NOT EXISTS (
        SELECT 1
        FROM provider_runtime_open_turns AS open_turn
        WHERE open_turn.thread_id = event.thread_id
          AND open_turn.turn_id = event.turn_id
          AND event.sequence >= open_turn.first_sequence
      )
      AND event.sequence NOT IN (
        SELECT sequence
        FROM provider_runtime_events
        WHERE sequence <= ${throughSequence}
        ORDER BY sequence DESC
        LIMIT ${PROVIDER_RUNTIME_EVENT_RETAIN_ACCEPTED}
      )
  `;

  // process-local on purpose — a "do not rescan yet" hint, never durability; restart resets to 0, the safe direction (pruning sooner)
  let lastRetentionScanSequence = 0;

  const rememberRetentionScan = (retentionScanSequence: number | null) =>
    // only a committed scan may move the hint — a rollback leaves it so the next advance rescans
    Effect.sync(() => {
      if (retentionScanSequence !== null) {
        lastRetentionScanSequence = Math.max(lastRetentionScanSequence, retentionScanSequence);
      }
    });

  const readConsumerCursorForUpdate = (consumerName: string) =>
    sql<{ readonly lastAckedSequence: number }>`
      SELECT last_acked_sequence AS "lastAckedSequence"
      FROM provider_runtime_event_consumers
      WHERE consumer_name = ${consumerName}
    `.pipe(Effect.map((rows) => rows[0]?.lastAckedSequence));

  const moveConsumerCursor = (input: {
    readonly consumerName: string;
    readonly fromSequence: number;
    readonly toSequence: number;
    readonly updatedAt: string;
  }) =>
    sql<{ readonly sequence: number }>`
      UPDATE provider_runtime_event_consumers
      SET last_acked_sequence = ${input.toSequence}, updated_at = ${input.updatedAt}
      WHERE consumer_name = ${input.consumerName}
        AND last_acked_sequence = ${input.fromSequence}
      RETURNING last_acked_sequence AS sequence
    `.pipe(Effect.map((rows) => rows.length === 1));

  const advanceConsumerCursor: ProviderRuntimeEventRepositoryShape["advanceConsumerCursor"] = (
    input,
  ) => {
    let retentionScanSequence: number | null = null;
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const cursor = yield* readConsumerCursorForUpdate(input.consumerName);
          if (cursor === undefined) return false;
          if (cursor >= input.eventSequence) return true;

          // sequence gaps after conflicting inserts mean contiguity = the exact next stored row, not cursor + 1
          const nextRows = yield* sql<{ readonly sequence: number | null }>`
            SELECT MIN(sequence) AS sequence
            FROM provider_runtime_events
            WHERE sequence > ${cursor}
          `;
          if (nextRows[0]?.sequence !== input.eventSequence) return false;

          const eventRows = yield* sql<AckedEventRow>`
            SELECT sequence, event_type AS "eventType", thread_id AS "threadId", turn_id AS "turnId"
            FROM provider_runtime_events
            WHERE sequence = ${input.eventSequence}
          `;
          const event = eventRows[0];
          if (!event) return false;

          const advanced = yield* moveConsumerCursor({
            consumerName: input.consumerName,
            fromSequence: cursor,
            toSequence: input.eventSequence,
            updatedAt: input.updatedAt,
          });
          if (!advanced) return false;

          const settlesOpenTurns = yield* recordAckedOpenTurn(event, input.updatedAt);

          // nothing below the cursor becomes deletable while a turn only grows — scan when a turn settled or enough events piled up
          if (
            !settlesOpenTurns &&
            input.eventSequence - lastRetentionScanSequence <
              PROVIDER_RUNTIME_EVENT_RETENTION_SCAN_INTERVAL
          ) {
            return true;
          }
          retentionScanSequence = input.eventSequence;
          yield* sweepAcceptedHistoryThrough(input.eventSequence);
          return true;
        }),
      )
      .pipe(
        Effect.tap(() => rememberRetentionScan(retentionScanSequence)),
        Effect.mapError(toPersistenceSqlError("ProviderRuntimeEvent.advanceConsumerCursor")),
      );
  };

  // one transaction moves the cursor through (cursor, throughSequence] applying the same per-row bookkeeping — rows between are re-read here so it never depends on caller memory
  const advanceConsumerCursorThrough: ProviderRuntimeEventRepositoryShape["advanceConsumerCursorThrough"] =
    (input) => {
      let retentionScanSequence: number | null = null;
      return sql
        .withTransaction(
          Effect.gen(function* () {
            const cursor = yield* readConsumerCursorForUpdate(input.consumerName);
            if (cursor === undefined) return false;
            if (cursor >= input.throughSequence) return true;

            const events = yield* sql<AckedEventRow>`
              SELECT sequence, event_type AS "eventType", thread_id AS "threadId", turn_id AS "turnId"
              FROM provider_runtime_events
              WHERE sequence > ${cursor} AND sequence <= ${input.throughSequence}
              ORDER BY sequence ASC
            `;
            // the target must be a stored row — a miss means the journal changed underneath the caller
            if (
              events.length === 0 ||
              events[events.length - 1]!.sequence !== input.throughSequence
            ) {
              return false;
            }

            const advanced = yield* moveConsumerCursor({
              consumerName: input.consumerName,
              fromSequence: cursor,
              toSequence: input.throughSequence,
              updatedAt: input.updatedAt,
            });
            if (!advanced) return false;

            let settlesOpenTurns = false;
            for (const event of events) {
              if (yield* recordAckedOpenTurn(event, input.updatedAt)) settlesOpenTurns = true;
            }

            if (
              !settlesOpenTurns &&
              input.throughSequence - lastRetentionScanSequence <
                PROVIDER_RUNTIME_EVENT_RETENTION_SCAN_INTERVAL
            ) {
              return true;
            }
            retentionScanSequence = input.throughSequence;
            yield* sweepAcceptedHistoryThrough(input.throughSequence);
            return true;
          }),
        )
        .pipe(
          Effect.tap(() => rememberRetentionScan(retentionScanSequence)),
          Effect.mapError(
            toPersistenceSqlError("ProviderRuntimeEvent.advanceConsumerCursorThrough"),
          ),
        );
    };

  return {
    append,
    getHighWaterSequence,
    readAfter,
    getThreadCoverage,
    readThreadEvents,
    readAcceptedOpenTurnEvents,
    pruneSettledOpenTurns,
    getConsumerCursor,
    hasPendingEventsForThreads,
    advanceConsumerCursor,
    advanceConsumerCursorThrough,
  } satisfies ProviderRuntimeEventRepositoryShape;
});

export const ProviderRuntimeEventRepositoryLive = Layer.effect(
  ProviderRuntimeEventRepository,
  make,
);
