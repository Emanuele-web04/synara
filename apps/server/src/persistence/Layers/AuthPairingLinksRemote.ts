import { RemotePairingDevice, RemoteTrustScope } from "@synara/contracts";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../Errors";
import type {
  RemotePairingRecord,
  RemotePairingRepositoryShape,
} from "../Services/AuthPairingLinks";

interface Row {
  id: string;
  credential: string;
  remote_metadata: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  pending_device_jkt: string | null;
  pending_device_key: string | null;
  pending_device_label: string | null;
}

function scopeMatches(raw: string, expected: RemoteTrustScope): boolean {
  const actual = Schema.decodeUnknownSync(RemoteTrustScope)(JSON.parse(raw));
  return (
    actual.environmentId === expected.environmentId &&
    actual.rootFingerprint === expected.rootFingerprint &&
    actual.accountAuthority === expected.accountAuthority &&
    actual.userId === expected.userId &&
    actual.organizationId === expected.organizationId
  );
}

function decode(row: Row): RemotePairingRecord {
  return {
    id: row.id,
    credentialHash: row.credential,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
    pendingDevice:
      row.pending_device_jkt === null
        ? null
        : Schema.decodeUnknownSync(RemotePairingDevice)({
            deviceJkt: row.pending_device_jkt,
            publicKey: JSON.parse(row.pending_device_key ?? "null"),
            label: row.pending_device_label,
          }),
  };
}

/** Extends the existing pairing repository; legacy bootstrap never sees this purpose. */
export function makeRemotePairingQueries(sql: SqlClient): RemotePairingRepositoryShape {
  const query = (scope: RemoteTrustScope, id?: string) =>
    Effect.gen(function* () {
      const rows =
        yield* sql<Row>`SELECT * FROM auth_pairing_links WHERE purpose = 'remote-device' AND (${id ?? null} IS NULL OR id = ${id ?? null})`;
      return yield* Effect.try({
        try: () => rows.filter((row) => scopeMatches(row.remote_metadata, scope)).map(decode),
        catch: (cause) => cause,
      });
    }).pipe(Effect.mapError(toPersistenceSqlError("AuthPairingLinks.remote.read")));
  const get: RemotePairingRepositoryShape["get"] = (scope, id) =>
    query(scope, id).pipe(Effect.map((rows) => rows[0]));
  const create: RemotePairingRepositoryShape["create"] = (input) =>
    sql`
    INSERT INTO auth_pairing_links (id, credential, method, role, subject, created_at, expires_at, purpose, remote_metadata)
    VALUES (${input.id}, ${input.credentialHash}, 'one-time-token', 'client', 'remote-device', ${input.createdAt}, ${input.expiresAt}, 'remote-device', ${JSON.stringify(input.scope)})
  `.pipe(Effect.mapError(toPersistenceSqlError("AuthPairingLinks.remote.create")), Effect.asVoid);
  const requestApproval: RemotePairingRepositoryShape["requestApproval"] = (
    scope,
    id,
    device,
    now,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const record = yield* get(scope, id);
          if (
            !record ||
            record.revokedAt !== null ||
            (record.consumedAt === null && record.expiresAt <= now)
          )
            return false;
          if (record.pendingDevice) return record.pendingDevice.deviceJkt === device.deviceJkt;
          if (record.consumedAt !== null) return false;
          const changed =
            yield* sql`UPDATE auth_pairing_links SET pending_device_jkt = ${device.deviceJkt}, pending_device_key = ${JSON.stringify(device.publicKey)}, pending_device_label = ${device.label}
      WHERE id = ${id} AND purpose = 'remote-device' AND pending_device_jkt IS NULL AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ${now} RETURNING id`;
          return changed.length === 1;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("AuthPairingLinks.remote.requestApproval")));
  const approve: RemotePairingRepositoryShape["approve"] = (
    scope,
    id,
    jkt,
    now,
    enrolledVia = "approval",
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const record = yield* get(scope, id);
          if (
            !record ||
            record.revokedAt !== null ||
            !record.pendingDevice ||
            record.pendingDevice.deviceJkt !== jkt
          )
            return false;
          if (record.consumedAt !== null) {
            const trusted =
              yield* sql`SELECT 1 FROM remote_device_trust WHERE environment_id = ${scope.environmentId} AND root_fingerprint = ${scope.rootFingerprint} AND device_jkt = ${jkt} AND revoked_at IS NULL AND approved_invite_id = ${id}`;
            return trusted.length === 1;
          }
          if (record.expiresAt <= now) return false;
          const changed =
            yield* sql`UPDATE auth_pairing_links SET consumed_at = ${now} WHERE id = ${id} AND purpose = 'remote-device' AND pending_device_jkt = ${jkt} AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ${now} RETURNING id`;
          if (changed.length !== 1) return false;
          yield* sql`INSERT INTO remote_device_trust (environment_id, root_fingerprint, device_jkt, device_public_key, account_authority, owner_user_id, organization_id, label, generation, approved_at, approved_invite_id, revoked_at, enrolled_via)
      VALUES (${scope.environmentId}, ${scope.rootFingerprint}, ${jkt}, ${JSON.stringify(record.pendingDevice.publicKey)}, ${scope.accountAuthority}, ${scope.userId}, ${scope.organizationId}, ${record.pendingDevice.label}, 1, ${now}, ${id}, NULL, ${enrolledVia})
      ON CONFLICT(environment_id, root_fingerprint, device_jkt) DO UPDATE SET
        device_public_key = excluded.device_public_key, account_authority = excluded.account_authority,
        owner_user_id = excluded.owner_user_id, organization_id = excluded.organization_id,
        label = excluded.label, generation = remote_device_trust.generation + 1,
        approved_at = excluded.approved_at, approved_invite_id = excluded.approved_invite_id, revoked_at = NULL,
        enrolled_via = excluded.enrolled_via`;
          // `enabled` marks a live identity; the owner's allow_connections switch is left untouched.
          yield* sql`INSERT INTO remote_access_state (environment_id, root_fingerprint, enabled) VALUES (${scope.environmentId}, ${scope.rootFingerprint}, 1)
      ON CONFLICT(environment_id, root_fingerprint) DO UPDATE SET enabled = 1`;
          return true;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("AuthPairingLinks.remote.approve")));
  const revoke: RemotePairingRepositoryShape["revoke"] = (scope, id, now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (!(yield* get(scope, id))) return;
          yield* sql`UPDATE auth_pairing_links SET revoked_at = ${now} WHERE id = ${id} AND purpose = 'remote-device' AND consumed_at IS NULL AND revoked_at IS NULL`;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("AuthPairingLinks.remote.revoke")));
  const enroll: RemotePairingRepositoryShape["enroll"] = (scope, id, device, now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if (!(yield* requestApproval(scope, id, device, now))) return false;
          yield* approve(scope, id, device.deviceJkt, now, "qr");
          return true;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("AuthPairingLinks.remote.enroll")));
  return { create, get, list: (scope) => query(scope), requestApproval, approve, enroll, revoke };
}
