import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { columnExists } from "./schemaHelpers";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "auth_pairing_links", "purpose"))) {
    yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN purpose TEXT NOT NULL DEFAULT 'local-session'`;
  }
  if (!(yield* columnExists(sql, "auth_pairing_links", "remote_metadata"))) {
    yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN remote_metadata TEXT`;
  }
  if (!(yield* columnExists(sql, "auth_pairing_links", "pending_device_jkt"))) {
    yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN pending_device_jkt TEXT`;
  }
  if (!(yield* columnExists(sql, "auth_pairing_links", "pending_device_key"))) {
    yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN pending_device_key TEXT`;
  }
  if (!(yield* columnExists(sql, "auth_pairing_links", "pending_device_label"))) {
    yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN pending_device_label TEXT`;
  }
  yield* sql`CREATE TABLE IF NOT EXISTS remote_device_trust (
    environment_id TEXT NOT NULL,
    root_fingerprint TEXT NOT NULL,
    device_jkt TEXT NOT NULL,
    device_public_key TEXT NOT NULL,
    account_authority TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    label TEXT NOT NULL,
    generation INTEGER NOT NULL,
    approved_at TEXT NOT NULL,
    approved_invite_id TEXT NOT NULL,
    revoked_at TEXT,
    PRIMARY KEY (environment_id, root_fingerprint, device_jkt)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS remote_access_state (
    environment_id TEXT NOT NULL,
    root_fingerprint TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (environment_id, root_fingerprint)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS remote_host_trust (
    controller_environment_id TEXT NOT NULL,
    account_authority TEXT NOT NULL,
    user_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    root_certificate TEXT NOT NULL,
    root_fingerprint TEXT NOT NULL,
    host_id TEXT NOT NULL,
    label TEXT NOT NULL,
    paired_at TEXT,
    revoked_at TEXT,
    PRIMARY KEY (controller_environment_id, account_authority, user_id, organization_id, environment_id)
  )`;
});
