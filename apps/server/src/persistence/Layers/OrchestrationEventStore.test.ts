import { CommandId, EventId, ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("stores json columns as strings and replays decoded events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      const appended = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-store-roundtrip"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-roundtrip"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-store-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-store-roundtrip"),
        metadata: {
          adapterKey: "codex",
        },
        payload: {
          projectId: ProjectId.makeUnsafe("project-roundtrip"),
          title: "Roundtrip Project",
          workspaceRoot: "/tmp/project-roundtrip",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const storedRows = yield* sql<{
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(storedRows.length, 1);
      assert.equal(typeof storedRows[0]?.payloadJson, "string");
      assert.equal(typeof storedRows[0]?.metadataJson, "string");

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      assert.equal(replayed[0]?.metadata.adapterKey, "codex");
    }),
  );

  it.effect("normalizes imported T3 Code model-selection shapes during replay", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-05-05T14:39:18.000Z";

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
        VALUES
        (
          ${EventId.makeUnsafe("evt-import-project-created")},
          ${"project"},
          ${ProjectId.makeUnsafe("project-imported")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.makeUnsafe("cmd-import-project-created")},
          ${null},
          ${null},
          ${"server"},
          ${JSON.stringify({
            projectId: "project-imported",
            title: "Imported Project",
            workspaceRoot: "/tmp/imported",
            defaultModelSelection: {
              instanceId: "codex",
              model: "imported-project-model",
            },
            scripts: [],
            createdAt: now,
            updatedAt: now,
          })},
          ${"{}"}
        ),
        (
          ${EventId.makeUnsafe("evt-import-thread-created")},
          ${"thread"},
          ${ThreadId.makeUnsafe("thread-imported")},
          ${0},
          ${"thread.created"},
          ${now},
          ${CommandId.makeUnsafe("cmd-import-thread-created")},
          ${null},
          ${null},
          ${"server"},
          ${JSON.stringify({
            threadId: "thread-imported",
            projectId: "project-imported",
            title: "Imported Thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.5",
              options: [{ id: "reasoningEffort", value: "medium" }],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          })},
          ${"{}"}
        ),
        (
          ${EventId.makeUnsafe("evt-import-turn-start")},
          ${"thread"},
          ${ThreadId.makeUnsafe("thread-imported")},
          ${1},
          ${"thread.turn-start-requested"},
          ${now},
          ${CommandId.makeUnsafe("cmd-import-turn-start")},
          ${null},
          ${null},
          ${"server"},
          ${JSON.stringify({
            threadId: "thread-imported",
            messageId: "message-imported",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.5",
              options: [{ id: "reasoningEffort", value: "medium" }],
            },
            dispatchMode: "queue",
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now,
          })},
          ${"{}"}
        )
      `;

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      const projectCreated = replayed.find(
        (event) => event.eventId === EventId.makeUnsafe("evt-import-project-created"),
      );
      const threadCreated = replayed.find(
        (event) => event.eventId === EventId.makeUnsafe("evt-import-thread-created"),
      );
      const turnStartRequested = replayed.find(
        (event) => event.eventId === EventId.makeUnsafe("evt-import-turn-start"),
      );

      assert.deepStrictEqual(
        projectCreated?.type === "project.created"
          ? projectCreated.payload.defaultModelSelection
          : null,
        {
          provider: "codex",
          model: "imported-project-model",
        },
      );
      assert.deepStrictEqual(
        threadCreated?.type === "thread.created" ? threadCreated.payload.modelSelection : null,
        {
          provider: "codex",
          model: "gpt-5.5",
          options: {
            reasoningEffort: "medium",
          },
        },
      );
      assert.deepStrictEqual(
        turnStartRequested?.type === "thread.turn-start-requested"
          ? turnStartRequested.payload.modelSelection
          : null,
        {
          provider: "codex",
          model: "gpt-5.5",
          options: {
            reasoningEffort: "medium",
          },
        },
      );
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored json is invalid", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

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
          ${EventId.makeUnsafe("evt-store-invalid-json")},
          ${"project"},
          ${ProjectId.makeUnsafe("project-invalid-json")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.makeUnsafe("cmd-store-invalid-json")},
          ${null},
          ${null},
          ${"server"},
          ${"{"},
          ${"{}"}
        )
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(0, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(Schema.is(PersistenceDecodeError)(replayResult.failure));
        assert.ok(
          replayResult.failure.operation.includes(
            "OrchestrationEventStore.readFromSequence:decodeRows",
          ),
        );
      }
    }),
  );
});
