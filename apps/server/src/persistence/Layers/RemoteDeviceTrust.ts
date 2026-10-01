import { RemoteTrustedDevice, RemoteTrustScope } from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../Errors";
import {
  RemoteDeviceTrustRepository,
  type RemoteDeviceTrustRepositoryShape,
} from "../Services/RemoteDeviceTrust";

export const makeRemoteDeviceTrustRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const listeners = new Set<(scope: RemoteTrustScope, jkt?: string) => void>();
  const notify = (scope: RemoteTrustScope, jkt?: string) => {
    for (const listener of listeners) {
      try {
        listener(scope, jkt);
      } catch {
        /* Revocation is already durable. */
      }
    }
  };
  const list: RemoteDeviceTrustRepositoryShape["list"] = (scope) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        deviceJkt: string;
        publicKey: string;
        label: string;
        generation: number;
        approvedAt: string;
        revokedAt: string | null;
      }>`
      SELECT device_jkt AS "deviceJkt", device_public_key AS "publicKey", label, generation,
        approved_at AS "approvedAt", revoked_at AS "revokedAt"
      FROM remote_device_trust WHERE environment_id = ${scope.environmentId}
        AND root_fingerprint = ${scope.rootFingerprint} AND account_authority = ${scope.accountAuthority}
        AND owner_user_id = ${scope.userId} AND organization_id = ${scope.organizationId}
      ORDER BY approved_at, device_jkt`;
      return yield* Effect.try({
        try: () =>
          rows.map((row) =>
            Schema.decodeUnknownSync(RemoteTrustedDevice)({
              ...row,
              publicKey: JSON.parse(row.publicKey),
            }),
          ),
        catch: (cause) => cause,
      });
    }).pipe(Effect.mapError(toPersistenceSqlError("RemoteDeviceTrust.list")));
  const authorize: RemoteDeviceTrustRepositoryShape["authorize"] = (scope, jkt, generation) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        deviceJkt: string;
        publicKey: string;
        label: string;
        generation: number;
        approvedAt: string;
        revokedAt: string | null;
      }>`
      SELECT t.device_jkt AS "deviceJkt", t.device_public_key AS "publicKey", t.label, t.generation,
        t.approved_at AS "approvedAt", t.revoked_at AS "revokedAt"
      FROM remote_device_trust t JOIN remote_access_state s
        ON s.environment_id = t.environment_id AND s.root_fingerprint = t.root_fingerprint
      WHERE s.enabled = 1 AND t.environment_id = ${scope.environmentId} AND t.root_fingerprint = ${scope.rootFingerprint}
        AND t.account_authority = ${scope.accountAuthority} AND t.owner_user_id = ${scope.userId}
        AND t.organization_id = ${scope.organizationId} AND t.device_jkt = ${jkt} AND t.revoked_at IS NULL
        AND (${generation ?? null} IS NULL OR t.generation = ${generation ?? null}) LIMIT 1`;
      const row = rows[0];
      if (!row) return undefined;
      return yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(RemoteTrustedDevice)({
            ...row,
            publicKey: JSON.parse(row.publicKey),
          }),
        catch: (cause) => cause,
      });
    }).pipe(Effect.mapError(toPersistenceSqlError("RemoteDeviceTrust.authorize")));
  const revoke: RemoteDeviceTrustRepositoryShape["revoke"] = (scope, jkt, now) =>
    sql`
    UPDATE remote_device_trust SET revoked_at = ${now}, generation = generation + 1
    WHERE environment_id = ${scope.environmentId} AND root_fingerprint = ${scope.rootFingerprint}
      AND account_authority = ${scope.accountAuthority} AND owner_user_id = ${scope.userId}
      AND organization_id = ${scope.organizationId} AND device_jkt = ${jkt} AND revoked_at IS NULL
  `.pipe(
      Effect.mapError(toPersistenceSqlError("RemoteDeviceTrust.revoke")),
      Effect.tap(() => Effect.sync(() => notify(scope, jkt))),
      Effect.asVoid,
    );
  const disable: RemoteDeviceTrustRepositoryShape["disable"] = (scope, now) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE remote_access_state SET enabled = 0 WHERE environment_id = ${scope.environmentId} AND root_fingerprint = ${scope.rootFingerprint}`;
          yield* sql`UPDATE remote_device_trust SET revoked_at = ${now}, generation = generation + 1 WHERE environment_id = ${scope.environmentId} AND root_fingerprint = ${scope.rootFingerprint} AND revoked_at IS NULL`;
        }),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("RemoteDeviceTrust.disable")),
        Effect.tap(() => Effect.sync(() => notify(scope))),
      );
  const resetEnvironment: RemoteDeviceTrustRepositoryShape["resetEnvironment"] = (
    environmentId,
    now,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows =
            yield* sql<RemoteTrustScope>`SELECT DISTINCT environment_id AS "environmentId", root_fingerprint AS "rootFingerprint", account_authority AS "accountAuthority", owner_user_id AS "userId", organization_id AS "organizationId" FROM remote_device_trust WHERE environment_id = ${environmentId}`;
          yield* sql`UPDATE remote_access_state SET enabled = 0 WHERE environment_id = ${environmentId}`;
          yield* sql`UPDATE remote_device_trust SET revoked_at = ${now}, generation = generation + 1 WHERE environment_id = ${environmentId} AND revoked_at IS NULL`;
          yield* sql`UPDATE auth_pairing_links SET revoked_at = ${now} WHERE purpose = 'remote-device' AND json_extract(remote_metadata, '$.environmentId') = ${environmentId} AND revoked_at IS NULL`;
          return rows;
        }),
      )
      .pipe(
        Effect.mapError(toPersistenceSqlError("RemoteDeviceTrust.resetEnvironment")),
        Effect.tap((scopes) =>
          Effect.sync(() => {
            for (const scope of scopes) notify(scope);
          }),
        ),
        Effect.asVoid,
      );
  const hasIdentity: RemoteDeviceTrustRepositoryShape["hasIdentity"] = (environmentId) =>
    sql`SELECT 1 FROM remote_access_state WHERE environment_id = ${environmentId} LIMIT 1`.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toPersistenceSqlError("RemoteDeviceTrust.hasIdentity")),
    );
  return {
    resetEnvironment,
    hasIdentity,
    list,
    authorize,
    revoke,
    disable,
    onRevoked: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } satisfies RemoteDeviceTrustRepositoryShape;
});

export const RemoteDeviceTrustRepositoryLive = Layer.effect(
  RemoteDeviceTrustRepository,
  makeRemoteDeviceTrustRepository,
);
