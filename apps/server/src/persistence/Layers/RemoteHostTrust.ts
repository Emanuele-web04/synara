import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../Errors";
import {
  RemoteHostTrustRepository,
  type RemoteHostTrustRecord,
  type RemoteHostTrustRepositoryShape,
} from "../Services/RemoteHostTrust";
import { validateRemoteTlsAnchor } from "../../remoteTransport/certificates";

export const RemoteHostTrustRepositoryLive = Layer.effect(
  RemoteHostTrustRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const setDesired: RemoteHostTrustRepositoryShape["setDesired"] = (binding, hostId, desired) =>
      sql`
    UPDATE remote_host_trust SET desired = ${desired ? 1 : 0} WHERE controller_environment_id = ${binding.controllerEnvironmentId}
      AND account_authority = ${binding.accountAuthority} AND user_id = ${binding.userId} AND organization_id = ${binding.organizationId}
      AND host_id = ${hostId} AND paired_at IS NOT NULL AND revoked_at IS NULL
  `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("RemoteHostTrust.setDesired")));
    const listPaired: RemoteHostTrustRepositoryShape["listPaired"] = (binding) =>
      sql<RemoteHostTrustRecord>`
    SELECT environment_id AS "environmentId", root_certificate AS "rootCertificate", root_fingerprint AS "rootFingerprint", channel, host_id AS "hostId", label, paired_at AS "pairedAt"
    FROM remote_host_trust WHERE controller_environment_id = ${binding.controllerEnvironmentId}
      AND account_authority = ${binding.accountAuthority} AND user_id = ${binding.userId} AND organization_id = ${binding.organizationId}
      AND paired_at IS NOT NULL AND revoked_at IS NULL
  `.pipe(Effect.mapError(toPersistenceSqlError("RemoteHostTrust.listPaired")));
    const listDesired: RemoteHostTrustRepositoryShape["listDesired"] = (binding) =>
      sql<RemoteHostTrustRecord>`
    SELECT environment_id AS "environmentId", root_certificate AS "rootCertificate", root_fingerprint AS "rootFingerprint", channel, host_id AS "hostId", label, paired_at AS "pairedAt"
    FROM remote_host_trust WHERE controller_environment_id = ${binding.controllerEnvironmentId}
      AND account_authority = ${binding.accountAuthority} AND user_id = ${binding.userId} AND organization_id = ${binding.organizationId}
      AND desired = 1 AND paired_at IS NOT NULL AND revoked_at IS NULL
  `.pipe(Effect.mapError(toPersistenceSqlError("RemoteHostTrust.listDesired")));
    const get: RemoteHostTrustRepositoryShape["get"] = (binding, environmentId) =>
      sql<RemoteHostTrustRecord>`
    SELECT environment_id AS "environmentId", root_certificate AS "rootCertificate", root_fingerprint AS "rootFingerprint", channel, host_id AS "hostId", label, paired_at AS "pairedAt"
    FROM remote_host_trust WHERE controller_environment_id = ${binding.controllerEnvironmentId}
      AND account_authority = ${binding.accountAuthority} AND user_id = ${binding.userId} AND organization_id = ${binding.organizationId}
      AND environment_id = ${environmentId} AND revoked_at IS NULL
  `.pipe(
        Effect.map((rows) => rows[0]),
        Effect.mapError(toPersistenceSqlError("RemoteHostTrust.get")),
      );
    const importInvitation: RemoteHostTrustRepositoryShape["importInvitation"] = (
      binding,
      bundle,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* Effect.try({
              try: () => {
                validateRemoteTlsAnchor(bundle);
                if (
                  binding.accountAuthority !== bundle.accountAuthority ||
                  binding.userId !== bundle.userId ||
                  binding.organizationId !== bundle.organizationId
                )
                  throw new Error("Invitation belongs to another account");
                if (bundle.environmentId === binding.controllerEnvironmentId)
                  throw new Error("Cannot pair this installation with itself");
                if (
                  !Number.isFinite(Date.parse(bundle.expiresAt)) ||
                  Date.parse(bundle.expiresAt) <= Date.now() ||
                  Date.parse(bundle.expiresAt) > Date.now() + 10 * 60_000 + 60_000
                )
                  throw new Error("Invitation expired or invalid");
              },
              catch: (cause) => cause,
            });
            const existing = yield* get(binding, bundle.environmentId);
            if (
              existing &&
              (existing.rootFingerprint !== bundle.rootFingerprint ||
                existing.channel !== bundle.channel)
            ) {
              return yield* Effect.fail(
                new Error(
                  "Host identity changed. Forget the old trust explicitly and pair again on the host.",
                ),
              );
            }
            if (existing) return;
            yield* sql`INSERT INTO remote_host_trust (controller_environment_id, account_authority, user_id, organization_id, environment_id, channel, root_certificate, root_fingerprint, host_id, label)
      VALUES (${binding.controllerEnvironmentId}, ${binding.accountAuthority}, ${binding.userId}, ${binding.organizationId}, ${bundle.environmentId}, ${bundle.channel}, ${bundle.rootCertificate}, ${bundle.rootFingerprint}, ${bundle.hostId}, ${bundle.label})`;
          }),
        )
        .pipe(Effect.mapError(toPersistenceSqlError("RemoteHostTrust.importInvitation")));
    const confirm: RemoteHostTrustRepositoryShape["confirm"] = (
      binding,
      environmentId,
      fingerprint,
      now,
    ) =>
      sql`
    UPDATE remote_host_trust SET paired_at = ${now} WHERE controller_environment_id = ${binding.controllerEnvironmentId}
      AND account_authority = ${binding.accountAuthority} AND user_id = ${binding.userId} AND organization_id = ${binding.organizationId}
      AND environment_id = ${environmentId} AND root_fingerprint = ${fingerprint} AND revoked_at IS NULL RETURNING environment_id
  `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(toPersistenceSqlError("RemoteHostTrust.confirm")),
      );
    const forget: RemoteHostTrustRepositoryShape["forget"] = (binding, environmentId) =>
      sql`
    DELETE FROM remote_host_trust WHERE controller_environment_id = ${binding.controllerEnvironmentId}
      AND account_authority = ${binding.accountAuthority} AND user_id = ${binding.userId} AND organization_id = ${binding.organizationId} AND environment_id = ${environmentId}
  `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("RemoteHostTrust.forget")));
    return {
      get,
      importInvitation,
      confirm,
      forget,
      setDesired,
      listDesired,
      listPaired,
    } satisfies RemoteHostTrustRepositoryShape;
  }),
);
