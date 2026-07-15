import { CommandId, ProjectId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepository } from "../Services/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationCommandReceiptRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationCommandReceiptRepository", (it) => {
  it.effect("preserves the first immutable result when a command ID is inserted again", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* OrchestrationCommandReceiptRepository;
      yield* sql`DELETE FROM orchestration_command_receipts`;

      const receipt = {
        commandId: CommandId.makeUnsafe("command-receipt-immutable"),
        aggregateKind: "project" as const,
        aggregateId: ProjectId.makeUnsafe("project-receipt-immutable"),
        acceptedAt: "2026-07-14T00:00:00.000Z",
        resultSequence: 41,
        status: "accepted" as const,
        error: null,
        fingerprintVersion: 1,
        commandFingerprint: "a".repeat(64),
      };

      assert.isTrue(yield* repository.insert(receipt));
      assert.isFalse(
        yield* repository.insert({
          ...receipt,
          resultSequence: 99,
          commandFingerprint: "b".repeat(64),
        }),
      );

      const stored = yield* repository.getByCommandId({ commandId: receipt.commandId });
      assert.isTrue(Option.isSome(stored));
      assert.strictEqual(Option.getOrThrow(stored).resultSequence, 41);
      assert.strictEqual(Option.getOrThrow(stored).commandFingerprint, "a".repeat(64));
    }),
  );

  it.effect("keeps pre-fingerprint rows readable only as explicit legacy receipts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* OrchestrationCommandReceiptRepository;
      yield* sql`DELETE FROM orchestration_command_receipts`;
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at,
          result_sequence, status, error, fingerprint_version, command_fingerprint
        ) VALUES (
          'legacy-command-receipt', 'project', 'legacy-project',
          '2026-07-14T00:00:00.000Z', 7, 'accepted', NULL, NULL, NULL
        )
      `;

      const stored = yield* repository.getByCommandId({
        commandId: CommandId.makeUnsafe("legacy-command-receipt"),
      });
      assert.isTrue(Option.isSome(stored));
      assert.isNull(Option.getOrThrow(stored).fingerprintVersion);
      assert.isNull(Option.getOrThrow(stored).commandFingerprint);
    }),
  );
});
