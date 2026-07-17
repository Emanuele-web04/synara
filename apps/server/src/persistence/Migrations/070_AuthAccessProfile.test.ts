import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("070_AuthAccessProfile", (it) => {
  it.effect("defaults legacy rows to full and enforces the profile invariant", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-07-18T00:00:00.000Z";
      const expiresAt = "2026-08-18T00:00:00.000Z";

      yield* runMigrations({ toMigrationInclusive: 69 });
      yield* sql`
        INSERT INTO auth_pairing_links (
          id, credential, method, role, subject, created_at, expires_at
        ) VALUES (
          'legacy-pairing', 'LEGACYPAIRING', 'one-time-token', 'client',
          'legacy', ${now}, ${expiresAt}
        )
      `;
      yield* sql`
        INSERT INTO auth_sessions (
          session_id, subject, role, method, client_device_type, issued_at, expires_at
        ) VALUES (
          '11111111-1111-4111-8111-111111111111', 'legacy', 'client',
          'browser-session-cookie', 'unknown', ${now}, ${expiresAt}
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 70 });

      const pairingRows = yield* sql<{ readonly access_profile: string }>`
        SELECT access_profile FROM auth_pairing_links WHERE id = 'legacy-pairing'
      `;
      const sessionRows = yield* sql<{ readonly access_profile: string }>`
        SELECT access_profile FROM auth_sessions
        WHERE session_id = '11111111-1111-4111-8111-111111111111'
      `;
      assert.strictEqual(pairingRows[0]?.access_profile, "full");
      assert.strictEqual(sessionRows[0]?.access_profile, "full");

      yield* sql`
        UPDATE auth_pairing_links SET access_profile = 'companion' WHERE id = 'legacy-pairing'
      `;
      yield* sql`
        UPDATE auth_sessions SET access_profile = 'companion'
        WHERE session_id = '11111111-1111-4111-8111-111111111111'
      `;

      const invalidPairing = yield* sql`
        UPDATE auth_pairing_links SET access_profile = 'administrator'
        WHERE id = 'legacy-pairing'
      `.pipe(Effect.exit);
      const invalidSession = yield* sql`
        UPDATE auth_sessions SET access_profile = 'administrator'
        WHERE session_id = '11111111-1111-4111-8111-111111111111'
      `.pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(invalidPairing));
      assert.isTrue(Exit.isFailure(invalidSession));

      const schemaObjects = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE name IN (
          'idx_auth_pairing_links_access_profile',
          'idx_auth_sessions_access_profile',
          'auth_pairing_links_access_profile_insert_guard',
          'auth_pairing_links_access_profile_update_guard',
          'auth_sessions_access_profile_insert_guard',
          'auth_sessions_access_profile_update_guard'
        )
      `;
      assert.strictEqual(schemaObjects.length, 6);
    }),
  );
});
