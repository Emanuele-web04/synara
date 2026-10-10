import { OrchestrationEvent, ThreadId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import removeTranscriptMarkers from "./101_RemoveTranscriptMarkers.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const occurredAt = "2026-09-01T12:00:00.000Z";
const updatedAt = "2026-09-01T12:01:00.000Z";

layer("101_RemoveTranscriptMarkers", (it) => {
  it.effect("upgrades marker history without losing events, pins, notes or replay continuity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 100 });
      const pins = JSON.stringify([{ messageId: "message-1", done: false }]);
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, created_at, updated_at,
          thread_markers_json, pinned_messages_json, notes
        ) VALUES ('thread-1', 'project-1', 'Keep this conversation', ${occurredAt}, ${updatedAt},
          '[{"id":"marker-1","selectedText":"old highlight"}]', ${pins}, 'Keep my notes')
      `;
      const oldEvents = [
        [
          "thread.marker-added",
          { marker: { id: "marker-1", selectedText: "old highlight" }, updatedAt },
        ],
        ["thread.marker-removed", { markerId: "marker-1" }],
        ["thread.marker-done-set", { markerId: "marker-1", done: true, updatedAt }],
        ["thread.marker-label-set", { markerId: "marker-1", label: "Old label", updatedAt }],
        [
          "thread.meta-updated",
          { title: "Keep this title", threadMarkers: [], notes: "Keep my notes", updatedAt },
        ],
        [
          "thread.meta-updated",
          { notes: "Literal threadMarkers and thread.marker-added stay in user text", updatedAt },
        ],
      ] as const;
      for (const [index, [type, payload]] of oldEvents.entries()) {
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, command_id, actor_kind, payload_json, metadata_json
          ) VALUES (${`event-${index}`}, 'thread', 'thread-1', ${index + 1}, ${type},
            ${occurredAt}, ${`command-${index}`}, 'user',
            ${JSON.stringify({ threadId: "thread-1", ...payload })}, '{}')
        `;
      }
      const identities =
        yield* sql`SELECT sequence, event_id, stream_version, command_id FROM orchestration_events ORDER BY sequence`;

      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT sequence, event_id, stream_version, command_id FROM orchestration_events ORDER BY sequence`,
        identities,
      );
      const columns = yield* sql<{
        name: string;
      }>`SELECT name FROM pragma_table_info('projection_threads')`;
      assert.isFalse(columns.some((column) => column.name === "thread_markers_json"));
      assert.deepStrictEqual(
        yield* sql`SELECT title, pinned_messages_json, notes FROM projection_threads`,
        [{ title: "Keep this conversation", pinned_messages_json: pins, notes: "Keep my notes" }],
      );
      const events = yield* sql<{
        sequence: number;
        eventId: string;
        streamVersion: number;
        type: string;
        commandId: string;
        payloadJson: string;
      }>`
        SELECT sequence, event_id AS "eventId", stream_version AS "streamVersion",
          event_type AS type, command_id AS "commandId", payload_json AS "payloadJson"
        FROM orchestration_events ORDER BY sequence
      `;
      for (const [index, event] of events.entries()) {
        const decoded = yield* Schema.decodeUnknownEffect(OrchestrationEvent)({
          ...event,
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt,
          causationEventId: null,
          correlationId: null,
          actorKind: "user",
          payload: JSON.parse(event.payloadJson),
          metadata: {},
        });
        assert.strictEqual(decoded.type, "thread.meta-updated");
        if (index < 4) {
          assert.deepStrictEqual(decoded.payload, {
            threadId: ThreadId.makeUnsafe("thread-1"),
            updatedAt: index === 1 ? occurredAt : updatedAt,
          });
        }
      }
      assert.deepStrictEqual(JSON.parse(events[4]!.payloadJson), {
        threadId: "thread-1",
        title: "Keep this title",
        notes: "Keep my notes",
        updatedAt,
      });
      assert.deepStrictEqual(JSON.parse(events[5]!.payloadJson), {
        threadId: "thread-1",
        ...oldEvents[5][1],
      });
      // Lineage recovery can rerun migrations: this removal must also be idempotent.
      yield* removeTranscriptMarkers;
      assert.deepStrictEqual(
        yield* sql`SELECT sequence, event_id, stream_version, command_id FROM orchestration_events ORDER BY sequence`,
        identities,
      );
    }),
  );
});
