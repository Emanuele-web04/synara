import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE orchestration_command_receipts
    ADD COLUMN fingerprint_version INTEGER
    CHECK (fingerprint_version IS NULL OR fingerprint_version > 0)
  `;
  yield* sql`
    ALTER TABLE orchestration_command_receipts
    ADD COLUMN command_fingerprint TEXT
    CHECK (
      command_fingerprint IS NULL OR (
        length(command_fingerprint) = 64 AND
        command_fingerprint NOT GLOB '*[^0-9a-f]*'
      )
    )
  `;

  yield* sql`
    CREATE TRIGGER orchestration_command_receipts_fingerprint_insert_guard
    BEFORE INSERT ON orchestration_command_receipts
    WHEN (NEW.fingerprint_version IS NULL) <> (NEW.command_fingerprint IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'command receipt fingerprint fields must both be null or both be set');
    END
  `;
  yield* sql`
    CREATE TRIGGER orchestration_command_receipts_fingerprint_update_guard
    BEFORE UPDATE OF fingerprint_version, command_fingerprint
    ON orchestration_command_receipts
    WHEN (NEW.fingerprint_version IS NULL) <> (NEW.command_fingerprint IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'command receipt fingerprint fields must both be null or both be set');
    END
  `;
});
