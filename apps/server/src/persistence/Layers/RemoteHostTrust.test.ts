import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { RemoteHostTrustRepository } from "../Services/RemoteHostTrust";
import { RemoteHostTrustRepositoryLive } from "./RemoteHostTrust";
import { SqlitePersistenceMemory } from "./Sqlite";

const layer = it.layer(
  RemoteHostTrustRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("paired computers", (it) => {
  it.effect(
    "lists only confirmed trust in this account and controller, retaining disconnected computers",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const trust = yield* RemoteHostTrustRepository;
        const binding = {
          controllerEnvironmentId: "controller",
          accountAuthority: "https://account.test/api/v1",
          userId: "owner",
          organizationId: "org",
        };
        const now = "2026-10-07T00:00:00Z";
        const rows = [
          { ...binding, environmentId: "paired", pairedAt: now, revokedAt: null },
          { ...binding, environmentId: "pending", pairedAt: null, revokedAt: null },
          { ...binding, environmentId: "revoked", pairedAt: now, revokedAt: now },
          ...Object.keys(binding).map((key) => ({
            ...binding,
            [key]: "another-scope",
            environmentId: key,
            pairedAt: now,
            revokedAt: null,
          })),
        ];
        for (const row of rows) {
          yield* sql`INSERT INTO remote_host_trust
          (controller_environment_id, account_authority, user_id, organization_id,
           environment_id, channel, root_certificate, root_fingerprint, host_id, label, paired_at, revoked_at)
          VALUES (${row.controllerEnvironmentId}, ${row.accountAuthority}, ${row.userId}, ${row.organizationId},
                  ${row.environmentId}, 'dev', 'certificate', 'fingerprint', ${row.environmentId}, 'Same Mac', ${row.pairedAt}, ${row.revokedAt})`;
        }
        const pairedIds = () =>
          trust
            .listPaired(binding)
            .pipe(Effect.map((hosts) => hosts.map((host) => host.hostId).sort()));
        assert.deepStrictEqual(yield* pairedIds(), ["paired"]);
        yield* trust.setDesired(binding, "paired", true);
        assert.lengthOf(yield* trust.listDesired(binding), 1);
        yield* trust.setDesired(binding, "paired", false);
        assert.deepStrictEqual(yield* trust.listDesired(binding), []);
        assert.deepStrictEqual(yield* pairedIds(), ["paired"]);
        yield* trust.confirm(binding, "pending", "fingerprint", now);
        assert.deepStrictEqual(yield* pairedIds(), ["paired", "pending"]);
        yield* trust.forget(binding, "paired");
        assert.deepStrictEqual(yield* pairedIds(), ["pending"]);
      }),
  );
});
