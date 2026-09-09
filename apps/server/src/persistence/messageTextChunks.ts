import type { OrchestrationEvent } from "@synara/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "./Errors.ts";

type MessageEvent = Extract<OrchestrationEvent, { readonly type: "thread.message-sent" }>;

/** JSON keeps lone UTF-16 surrogates intact until adjacent chunks are joined in JS. */
export const selectMessageTextChunks = (
  sql: SqlClient.SqlClient,
  table: string,
  segment = false,
) => sql`
  (SELECT json_group_array(json(chunks.text_json) ORDER BY chunks.event_sequence)
   FROM message_text_chunks AS chunks
   WHERE chunks.thread_id = ${sql.literal(table)}.thread_id
     AND chunks.message_id = ${sql.literal(table)}.message_id
     ${segment ? sql`AND chunks.segment_sequence = ${sql.literal(table)}.sequence` : sql``}) AS "textChunks"
`;

export const selectSegmentEndedAt = (sql: SqlClient.SqlClient, table: string) => sql`
  COALESCE((SELECT chunks.updated_at FROM message_text_chunks AS chunks
    WHERE chunks.thread_id = ${sql.literal(table)}.thread_id
      AND chunks.message_id = ${sql.literal(table)}.message_id
      AND chunks.segment_sequence = ${sql.literal(table)}.sequence
    ORDER BY chunks.event_sequence DESC LIMIT 1), ${sql.literal(table)}.ended_at) AS "endedAt"
`;

export const joinMessageTextChunks = (row: {
  readonly text: string;
  readonly encodedText?: string | null | undefined;
  readonly textChunks?: ReadonlyArray<string> | undefined;
}) => (row.encodedText ?? row.text) + (row.textChunks?.join("") ?? "");

// SQLite TEXT is UTF-8; only unmatched UTF-16 code units need a JSON fallback.
export const encodeMessageTextFallback = (text: string): string | null =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)
    ? JSON.stringify(text)
    : null;

/** All mutations participate in the caller's projection/event transaction. */
export function makeMessageTextChunks(sql: SqlClient.SqlClient) {
  const hasApplied = (event: MessageEvent) =>
    sql`
    SELECT 1 FROM projection_thread_messages
    WHERE thread_id = ${event.payload.threadId} AND message_id = ${event.payload.messageId}
      AND text_event_sequence >= ${event.sequence}
  `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toPersistenceSqlError("MessageTextChunks.hasApplied")),
    );

  const append = (event: MessageEvent) =>
    Effect.gen(function* () {
      const p = event.payload;
      if (yield* hasApplied(event)) return;
      // A resumed/imported body must leave the frequently updated metadata row.
      // Its prefix belongs to the full message, not to a newly opened segment.
      yield* sql`
      INSERT INTO message_text_chunks (thread_id, message_id, event_sequence, segment_sequence, text_json, updated_at)
      SELECT thread_id, message_id, -1, NULL, COALESCE(text_json, json_quote(text)), updated_at
      FROM projection_thread_messages
      WHERE thread_id = ${p.threadId} AND message_id = ${p.messageId} AND (text <> '' OR text_json IS NOT NULL)
      ON CONFLICT (thread_id, message_id, event_sequence) DO NOTHING
    `;
      yield* sql`
      INSERT INTO projection_thread_messages
        (thread_id, message_id, turn_id, role, text, attachments_json, skills_json, mentions_json,
         dispatch_mode, dispatch_origin, is_streaming, source, sequence, created_at, updated_at, text_event_sequence)
      VALUES (${p.threadId}, ${p.messageId}, ${p.turnId ?? null}, ${p.role}, '',
        ${p.attachments !== undefined ? JSON.stringify(p.attachments) : null},
        ${p.skills !== undefined ? JSON.stringify(p.skills) : null},
        ${p.mentions !== undefined ? JSON.stringify(p.mentions) : null},
        ${p.dispatchMode ?? null}, ${p.dispatchOrigin ?? null}, 1, ${p.source}, ${event.sequence}, ${p.createdAt}, ${p.updatedAt}, ${event.sequence})
      ON CONFLICT (thread_id, message_id) DO UPDATE SET
        turn_id = COALESCE(projection_thread_messages.turn_id, excluded.turn_id), role = excluded.role,
        text = '', text_json = NULL, attachments_json = COALESCE(excluded.attachments_json, projection_thread_messages.attachments_json),
        skills_json = COALESCE(excluded.skills_json, projection_thread_messages.skills_json),
        mentions_json = COALESCE(excluded.mentions_json, projection_thread_messages.mentions_json),
        dispatch_mode = COALESCE(excluded.dispatch_mode, projection_thread_messages.dispatch_mode),
        dispatch_origin = COALESCE(excluded.dispatch_origin, projection_thread_messages.dispatch_origin),
        is_streaming = 1, source = excluded.source,
        sequence = COALESCE(projection_thread_messages.sequence, excluded.sequence),
        updated_at = excluded.updated_at, text_event_sequence = excluded.text_event_sequence
    `;
      const current = yield* sql<{ sequence: number | null }>`
      SELECT MAX(sequence) AS sequence FROM message_text_segments WHERE thread_id = ${p.threadId} AND message_id = ${p.messageId}
    `;
      const sequence =
        p.segmentStartedAt || current[0]?.sequence == null
          ? (p.segmentSequence ?? event.sequence)
          : current[0].sequence;
      if (p.segmentStartedAt || current[0]?.sequence == null) {
        // A repeated boundary replaces that segment's displayed text, while its
        // previous chunks still contribute to the complete message body.
        yield* sql`UPDATE message_text_chunks SET segment_sequence = NULL WHERE thread_id = ${p.threadId} AND message_id = ${p.messageId} AND segment_sequence = ${sequence}`;
        yield* sql`
        INSERT INTO message_text_segments (thread_id, message_id, sequence, started_at, ended_at, text)
        VALUES (${p.threadId}, ${p.messageId}, ${sequence}, ${p.segmentStartedAt ?? p.createdAt}, ${p.updatedAt}, '')
        ON CONFLICT (thread_id, message_id, sequence) DO UPDATE SET text = '', text_json = NULL, started_at = excluded.started_at, ended_at = excluded.ended_at
      `;
      }
      yield* sql`
      INSERT INTO message_text_chunks (thread_id, message_id, event_sequence, segment_sequence, text_json, updated_at)
      VALUES (${p.threadId}, ${p.messageId}, ${event.sequence}, ${sequence}, ${JSON.stringify(p.text)}, ${p.updatedAt})
    `;
    }).pipe(Effect.mapError(toPersistenceSqlError("MessageTextChunks.append")));

  const settle = (event: MessageEvent) =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM message_text_chunks WHERE thread_id = ${event.payload.threadId} AND message_id = ${event.payload.messageId}`;
      yield* sql`UPDATE projection_thread_messages SET text_event_sequence = ${event.sequence} WHERE thread_id = ${event.payload.threadId} AND message_id = ${event.payload.messageId}`;
    }).pipe(Effect.mapError(toPersistenceSqlError("MessageTextChunks.settle")));

  return { append, hasApplied, settle };
}
