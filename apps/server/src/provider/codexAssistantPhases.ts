import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { PROVIDER_RUNTIME_INGESTION_CONSUMER } from "../persistence/Services/ProviderRuntimeEvents";

/** Codex item completions preserve the optional native phase in their journal data. */
export function readCodexAssistantPhases(
  sql: SqlClient.SqlClient,
  threadId: string,
  turnId: string,
) {
  return sql<{ messageId: string; phase: "commentary" | "partial_answer" | "final_answer" }>`
    SELECT 'assistant:' || json_extract(event_json, '$.itemId') AS "messageId",
      json_extract(event_json, '$.payload.data.item.phase') AS phase
    FROM provider_runtime_events
    WHERE thread_id = ${threadId} AND turn_id = ${turnId} AND event_type = 'item.completed'
      AND json_extract(event_json, '$.provider') = 'codex'
      AND json_extract(event_json, '$.parentTurnId') IS NULL
      AND json_extract(event_json, '$.payload.itemType') = 'assistant_message'
      AND json_type(event_json, '$.itemId') = 'text'
      AND json_extract(event_json, '$.payload.data.item.phase') IN ('commentary', 'partial_answer', 'final_answer')
      AND sequence <= COALESCE((SELECT last_acked_sequence FROM provider_runtime_event_consumers
        WHERE consumer_name = ${PROVIDER_RUNTIME_INGESTION_CONSUMER}), 0)
    ORDER BY sequence DESC LIMIT 64
  `.pipe(
    Effect.map((rows) => ({
      hasPhases: rows.length > 0,
      finalMessageId: rows.find((row) => row.phase === "final_answer")?.messageId,
    })),
  );
}
