import { AuthSessionId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { DateTime, Duration, Effect, Exit, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import AuthAccessManagementMigration from "../Migrations/034_AuthAccessManagement";
import AuthAccessOriginMigration from "../Migrations/141_AuthAccessOrigin";
import * as NodeSqliteClient from "../NodeSqliteClient";
import { AuthPairingLinkRepository } from "../Services/AuthPairingLinks";
import { AuthSessionRepository } from "../Services/AuthSessions";
import { AuthPairingLinkRepositoryLive } from "./AuthPairingLinks";
import { AuthSessionRepositoryLive } from "./AuthSessions";
import { SqlitePersistenceMemory } from "./Sqlite";

const repositories = it.layer(
  Layer.mergeAll(AuthPairingLinkRepositoryLive, AuthSessionRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

repositories("auth access origin persistence", (it) => {
  it.effect(
    "preserves unknown, local and remote origins across pairing consumption and session reads",
    () =>
      Effect.gen(function* () {
        const pairing = yield* AuthPairingLinkRepository;
        const sessions = yield* AuthSessionRepository;
        const now = yield* DateTime.now;
        const expiresAt = DateTime.addDuration(now, Duration.days(1));
        const origins = [undefined, null, "local", "remote"] as const;

        for (const [index, accessOrigin] of origins.entries()) {
          const id = `origin-${index}`;
          const credential = `ORIGIN-${index}`;
          const marker = accessOrigin === undefined ? {} : { accessOrigin };
          yield* pairing.create({
            id,
            credential,
            method: "one-time-token",
            role: "client",
            subject: id,
            ...marker,
            label: null,
            createdAt: now,
            expiresAt,
          });
          const expected = accessOrigin ?? null;
          const savedPairing = Option.getOrThrow(yield* pairing.getByCredential({ credential }));
          assert.strictEqual(savedPairing.accessOrigin, expected);
          assert.strictEqual(
            (yield* pairing.listActive({ now })).find((row) => row.id === id)?.accessOrigin,
            expected,
          );
          const consumed = Option.getOrThrow(
            yield* pairing.consumeAvailable({ credential, consumedAt: now, now }),
          );
          assert.strictEqual(consumed.accessOrigin, expected);

          const sessionId = AuthSessionId.makeUnsafe(id);
          yield* sessions.create({
            sessionId,
            subject: id,
            role: "client",
            method: "bearer-session-token",
            ...marker,
            client: {
              label: null,
              ipAddress: null,
              userAgent: null,
              deviceType: "unknown",
              os: null,
              browser: null,
            },
            issuedAt: now,
            expiresAt,
          });
          const savedSession = Option.getOrThrow(yield* sessions.getById({ sessionId }));
          assert.strictEqual(savedSession.accessOrigin, expected);
          assert.strictEqual(
            (yield* sessions.listActive({ now })).find((row) => row.sessionId === sessionId)
              ?.accessOrigin,
            expected,
          );
        }
      }),
  );
});

const migration = it.layer(NodeSqliteClient.layerMemory());

migration("auth access origin migration", (it) => {
  it.effect(
    "keeps legacy credentials unknown, preserves rows on replay and rejects invalid origins",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* AuthAccessManagementMigration;
        yield* sql`INSERT INTO auth_pairing_links
          (id, credential, method, role, subject, label, created_at, expires_at)
          VALUES ('legacy-pairing', 'legacy-secret', 'one-time-token', 'client',
            'legacy-client', 'Keep this pairing', '2026-10-27T12:00:00Z', '2026-10-28T12:00:00Z')`;
        yield* sql`INSERT INTO auth_sessions
          (session_id, subject, role, method, client_label, issued_at, expires_at)
          VALUES ('legacy-session', 'legacy-client', 'owner', 'bearer-session-token',
            'Keep this session', '2026-10-27T12:00:00Z', '2026-10-28T12:00:00Z')`;

        yield* AuthAccessOriginMigration;
        assert.deepStrictEqual(
          yield* sql`SELECT credential, label, access_origin FROM auth_pairing_links`,
          [{ credential: "legacy-secret", label: "Keep this pairing", access_origin: null }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT subject, role, client_label, access_origin FROM auth_sessions`,
          [
            {
              subject: "legacy-client",
              role: "owner",
              client_label: "Keep this session",
              access_origin: null,
            },
          ],
        );

        yield* sql`UPDATE auth_pairing_links SET access_origin = 'remote'`;
        yield* sql`UPDATE auth_sessions SET access_origin = 'local'`;
        yield* AuthAccessOriginMigration;
        assert.deepStrictEqual(yield* sql`SELECT access_origin FROM auth_pairing_links`, [
          { access_origin: "remote" },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT access_origin FROM auth_sessions`, [
          { access_origin: "local" },
        ]);
        assert.isTrue(
          Exit.isFailure(
            yield* sql`UPDATE auth_pairing_links SET access_origin = 'untrusted'`.pipe(Effect.exit),
          ),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* sql`UPDATE auth_sessions SET access_origin = 'untrusted'`.pipe(Effect.exit),
          ),
        );
      }),
  );
});
