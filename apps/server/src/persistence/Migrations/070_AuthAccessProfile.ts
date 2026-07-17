import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "auth_pairing_links", "access_profile"))) {
    yield* sql`
      ALTER TABLE auth_pairing_links
      ADD COLUMN access_profile TEXT NOT NULL DEFAULT 'full'
    `;
  }

  if (!(yield* columnExists(sql, "auth_sessions", "access_profile"))) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN access_profile TEXT NOT NULL DEFAULT 'full'
    `;
  }

  yield* sql`
    UPDATE auth_pairing_links
    SET access_profile = 'full'
    WHERE access_profile IS NULL OR access_profile NOT IN ('full', 'companion')
  `;

  yield* sql`
    UPDATE auth_sessions
    SET access_profile = 'full'
    WHERE access_profile IS NULL OR access_profile NOT IN ('full', 'companion')
  `;

  // SQLite cannot add a CHECK constraint to an existing column without
  // rebuilding both auth tables. Equivalent insert/update guards keep this
  // additive migration safe for existing databases while enforcing the same
  // invariant for every future write, including writes outside repositories.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS auth_pairing_links_access_profile_insert_guard
    BEFORE INSERT ON auth_pairing_links
    WHEN NEW.access_profile NOT IN ('full', 'companion')
    BEGIN
      SELECT RAISE(ABORT, 'invalid auth_pairing_links access_profile');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS auth_pairing_links_access_profile_update_guard
    BEFORE UPDATE OF access_profile ON auth_pairing_links
    WHEN NEW.access_profile NOT IN ('full', 'companion')
    BEGIN
      SELECT RAISE(ABORT, 'invalid auth_pairing_links access_profile');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS auth_sessions_access_profile_insert_guard
    BEFORE INSERT ON auth_sessions
    WHEN NEW.access_profile NOT IN ('full', 'companion')
    BEGIN
      SELECT RAISE(ABORT, 'invalid auth_sessions access_profile');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS auth_sessions_access_profile_update_guard
    BEFORE UPDATE OF access_profile ON auth_sessions
    WHEN NEW.access_profile NOT IN ('full', 'companion')
    BEGIN
      SELECT RAISE(ABORT, 'invalid auth_sessions access_profile');
    END
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_pairing_links_access_profile
    ON auth_pairing_links(access_profile, revoked_at, consumed_at, expires_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_access_profile
    ON auth_sessions(access_profile, revoked_at, expires_at)
  `;
});
