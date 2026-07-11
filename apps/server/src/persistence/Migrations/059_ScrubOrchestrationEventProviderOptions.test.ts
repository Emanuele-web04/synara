// FILE: 059_ScrubOrchestrationEventProviderOptions.test.ts
// Purpose: Verifies historical event credentials are scrubbed idempotently and remain replayable.
// Layer: Persistence migration test.

import { assert, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ScrubOrchestrationEventProviderOptions from "./059_ScrubOrchestrationEventProviderOptions.ts";

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

layer("059_ScrubOrchestrationEventProviderOptions", (it) => {
  it.effect("scrubs all provider-option event shapes after a partial application", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const eventStore = yield* OrchestrationEventStore;
      const now = "2026-07-11T10:00:00.000Z";
      const events = [
        {
          eventId: "evt-historical-turn-queued",
          eventType: "thread.turn-queued",
          payload: {
            threadId: "thread-historical-provider-options",
            messageId: "message-historical-queued",
            modelSelection: { instanceId: "kilo_work", model: "kilo/auto" },
            providerOptions: {
              kilo: {
                binaryPath: "/usr/local/bin/kilo",
                serverUrl: "https://kilo.example.test",
                serverPassword: "kilo-secret",
                environment: { KILO_TOKEN: "kilo-env-secret" },
              },
            },
            dispatchMode: "queue",
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now,
          },
        },
        {
          eventId: "evt-historical-turn-start",
          eventType: "thread.turn-start-requested",
          payload: {
            threadId: "thread-historical-provider-options",
            messageId: "message-historical-start",
            modelSelection: { instanceId: "opencode_work", model: "openai/gpt-5" },
            providerOptions: {
              codex: {
                homePath: "/tmp/codex-work",
                environment: { CODEX_API_KEY: "codex-secret" },
              },
              opencode: {
                serverUrl: "https://opencode.example.test",
                serverPassword: "opencode-secret",
                environment: { OPENCODE_TOKEN: "opencode-env-secret" },
              },
            },
            dispatchMode: "queue",
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: now,
          },
        },
        {
          eventId: "evt-historical-edit-resend",
          eventType: "thread.message-edit-resend-requested",
          payload: {
            threadId: "thread-historical-provider-options",
            messageId: "message-historical-edit",
            text: "Retry safely",
            modelSelection: { instanceId: "opencode_work", model: "openai/gpt-5" },
            // Simulates a partially scrubbed row: the password is already gone,
            // while an environment secret still needs removal.
            providerOptions: {
              opencode: {
                serverUrl: "https://opencode.example.test",
                environment: { OPENCODE_TOKEN: "remaining-secret" },
              },
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now,
          },
        },
      ] as const;

      yield* runMigrations({ toMigrationInclusive: 58 });
      for (const [streamVersion, event] of events.entries()) {
        yield* sql`
          INSERT INTO orchestration_events (
            event_id,
            aggregate_kind,
            stream_id,
            stream_version,
            event_type,
            occurred_at,
            command_id,
            causation_event_id,
            correlation_id,
            actor_kind,
            payload_json,
            metadata_json
          )
          VALUES (
            ${event.eventId},
            'thread',
            'thread-historical-provider-options',
            ${streamVersion},
            ${event.eventType},
            ${now},
            ${`cmd-${streamVersion}`},
            NULL,
            ${`cmd-${streamVersion}`},
            'client',
            ${JSON.stringify(event.payload)},
            '{}'
          )
        `;
      }

      // Simulate an interrupted upgrade, then let the registered migration run
      // the same idempotent update a second time.
      yield* ScrubOrchestrationEventProviderOptions;
      yield* runMigrations();

      const rows = yield* sql<{
        readonly eventType: string;
        readonly payloadJson: string;
      }>`
        SELECT event_type AS "eventType", payload_json AS "payloadJson"
        FROM orchestration_events
        ORDER BY stream_version ASC
      `;
      assert.lengthOf(rows, 3);
      for (const row of rows) {
        assert.notInclude(row.payloadJson, "secret");
      }

      const queuedPayload = JSON.parse(rows[0]?.payloadJson ?? "{}") as {
        readonly providerOptions?: unknown;
      };
      assert.deepStrictEqual(queuedPayload.providerOptions, {
        kilo: {
          binaryPath: "/usr/local/bin/kilo",
          serverUrl: "https://kilo.example.test",
        },
      });
      const startedPayload = JSON.parse(rows[1]?.payloadJson ?? "{}") as {
        readonly providerOptions?: unknown;
      };
      assert.deepStrictEqual(startedPayload.providerOptions, {
        codex: { homePath: "/tmp/codex-work" },
        opencode: { serverUrl: "https://opencode.example.test" },
      });

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.lengthOf(replayed, 3);
      assert.deepStrictEqual(
        replayed.map((event) =>
          event.type === "thread.turn-queued" ||
          event.type === "thread.turn-start-requested" ||
          event.type === "thread.message-edit-resend-requested"
            ? event.payload.providerOptions
            : undefined,
        ),
        [
          {
            kilo: {
              binaryPath: "/usr/local/bin/kilo",
              serverUrl: "https://kilo.example.test",
            },
          },
          {
            codex: { homePath: "/tmp/codex-work" },
            opencode: { serverUrl: "https://opencode.example.test" },
          },
          { opencode: { serverUrl: "https://opencode.example.test" } },
        ],
      );
    }),
  );
});
