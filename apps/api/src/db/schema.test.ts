import { beforeAll, describe, expect, it } from "vitest";
import { eq, getTableName } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createDb } from "./index";
import { runMigrations } from "./migrate";
import { devices, hosts, revocationEvents } from "./schema";
import * as schema from "./schema";

const url = process.env.TEST_DATABASE_URL;

function hostRow(overrides: Partial<typeof hosts.$inferInsert> = {}) {
  return {
    // WorkOS ids are opaque strings with no local row behind them.
    ownerOrgId: `org_${crypto.randomUUID()}`,
    ownerUserId: `user_${crypto.randomUUID()}`,
    environmentId: "env-1",
    name: "MacBook",
    platform: "darwin" as const,
    kind: "local" as const,
    endpoints: [],
    ...overrides,
  };
}

describe.skipIf(!url)("schema", () => {
  beforeAll(async () => {
    await runMigrations(url!);
  });

  it("blocks untrusted table access while preserving the account API owner", async () => {
    const { pool } = createDb(url!);
    const client = await pool.connect();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const reader = `untrusted_${suffix}`;
    const owner = `api_owner_${suffix}`;
    const userId = `user_${suffix}`;
    try {
      await client.query("BEGIN");
      const tables = Object.values(schema).map(getTableName).toSorted();
      const flags = await client.query<{ name: string; enabled: boolean }>(
        `SELECT relname AS name, relrowsecurity AS enabled
         FROM pg_class JOIN pg_namespace ON pg_namespace.oid = relnamespace
         WHERE nspname = 'public' AND relname = ANY($1::text[]) ORDER BY relname`,
        [tables],
      );
      expect(flags.rows).toEqual(tables.map((name) => ({ name, enabled: true })));

      // Mimic an exposed Data API role even when it has ordinary table grants.
      // All setup is transactional: rollback removes roles, grants and data.
      await client.query(`CREATE ROLE "${reader}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await client.query(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${owner}"`);
      await client.query(`GRANT USAGE ON SCHEMA public TO "${reader}"`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${reader}"`,
      );
      await client.query(`ALTER TABLE profiles OWNER TO "${owner}"`);
      await client.query(`ALTER TABLE inbox_recaps OWNER TO "${owner}"`);
      await client.query(`SET LOCAL ROLE "${owner}"`);
      await client.query(
        `INSERT INTO profiles (user_id, handle, display_name, avatar_color)
         VALUES ($1, $2, 'Private profile', 'blue')`,
        [userId, suffix],
      );
      expect(
        (await client.query("SELECT user_id FROM profiles WHERE user_id = $1", [userId])).rowCount,
      ).toBe(1);
      await client.query(
        `INSERT INTO inbox_recaps (user_id, org_id, source_host_id, source_host_name, day, timezone, recap)
         VALUES ($1, 'org_test', $2, 'Private Mac', '2026-10-01', 'UTC', '{}'::jsonb)`,
        [userId, crypto.randomUUID()],
      );
      await client.query("RESET ROLE");
      await client.query(`SET LOCAL ROLE "${reader}"`);
      expect(
        (await client.query("SELECT * FROM inbox_recaps WHERE user_id = $1", [userId])).rowCount,
      ).toBe(0);
      expect(
        (
          await client.query(
            "UPDATE inbox_recaps SET source_host_name = 'Injected' WHERE user_id = $1",
            [userId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (await client.query("DELETE FROM inbox_recaps WHERE user_id = $1", [userId])).rowCount,
      ).toBe(0);
      await client.query("SAVEPOINT denied_recap_insert");
      await expect(
        client.query(
          `INSERT INTO inbox_recaps (user_id, org_id, source_host_id, source_host_name, day, timezone, recap)
         VALUES ($1, 'org_test', $2, 'Injected Mac', '2026-10-01', 'UTC', '{}'::jsonb)`,
          [userId, crypto.randomUUID()],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT denied_recap_insert");
      expect(
        (await client.query("SELECT user_id FROM profiles WHERE user_id = $1", [userId])).rowCount,
      ).toBe(0);
      expect(
        (
          await client.query("UPDATE profiles SET display_name = 'Changed' WHERE user_id = $1", [
            userId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (await client.query("DELETE FROM profiles WHERE user_id = $1", [userId])).rowCount,
      ).toBe(0);
      await client.query("SAVEPOINT denied_insert");
      await expect(
        client.query(
          `INSERT INTO profiles (user_id, handle, display_name, avatar_color)
         VALUES ($1, $2, 'Injected profile', 'blue')`,
          [`intruder_${suffix}`, `intruder_${suffix}`],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT denied_insert");
      await client.query("RESET ROLE");
      await client.query(`SET LOCAL ROLE "${owner}"`);
      expect(
        (
          await client.query("SELECT source_host_name FROM inbox_recaps WHERE user_id = $1", [
            userId,
          ])
        ).rows,
      ).toEqual([{ source_host_name: "Private Mac" }]);
      expect(
        (await client.query("SELECT display_name FROM profiles WHERE user_id = $1", [userId])).rows,
      ).toEqual([{ display_name: "Private profile" }]);
      expect(
        (await client.query("DELETE FROM profiles WHERE user_id = $1", [userId])).rowCount,
      ).toBe(1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });

  it("enforces unique (ownerOrgId, environmentId)", async () => {
    const { db, pool } = createDb(url!);
    try {
      const row = hostRow();
      await db.insert(hosts).values(row);
      await expect(db.insert(hosts).values(row)).rejects.toThrow();
    } finally {
      await pool.end();
    }
  });

  // The key that changed in 0002. Two organizations describing the same
  // machine is the ordinary case once a machine can be linked from more than
  // one workspace, and the old (user, environment) index did not allow it.
  it("lets two organizations register the same environment id", async () => {
    const { db, pool } = createDb(url!);
    try {
      const environmentId = `env_${crypto.randomUUID()}`;
      await db.insert(hosts).values(hostRow({ environmentId }));
      await expect(db.insert(hosts).values(hostRow({ environmentId }))).resolves.toBeDefined();
    } finally {
      await pool.end();
    }
  });

  it("allows a revoked device thumbprint to be registered again for the same user", async () => {
    const { db, pool } = createDb(url!);
    try {
      const userId = `user_${crypto.randomUUID()}`;
      const jkt = `jkt_${crypto.randomUUID()}`;
      const key = { kty: "OKP" as const, crv: "Ed25519" as const, x: "eA" };
      await db.insert(devices).values({
        userId,
        jkt,
        publicKeyJwk: key,
        displayName: "Phone",
        platform: "ios",
      });
      await expect(
        db.insert(devices).values({
          userId,
          jkt,
          publicKeyJwk: key,
          displayName: "Duplicate",
          platform: "ios",
        }),
      ).rejects.toThrow();
      await db.update(devices).set({ revokedAt: new Date() }).where(eq(devices.userId, userId));
      await expect(
        db.insert(devices).values({
          userId,
          jkt,
          publicKeyJwk: key,
          displayName: "Replacement",
          platform: "ios",
        }),
      ).resolves.toBeDefined();
    } finally {
      await pool.end();
    }
  });

  it("keeps revocation events after their host row is deleted", async () => {
    const { db, pool } = createDb(url!);
    try {
      const [host] = await db.insert(hosts).values(hostRow()).returning();
      if (!host) throw new Error("host insert returned no row");
      await db.insert(revocationEvents).values({ hostId: host.id, kind: "host_unlinked" });
      await db.delete(hosts).where(eq(hosts.id, host.id));
      const rows = await db
        .select()
        .from(revocationEvents)
        .where(eq(revocationEvents.hostId, host.id));
      expect(rows).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("migrates a seeded legacy host and removes the host-token surface", async () => {
    const databaseName = `synara_slice_a_${crypto.randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({ connectionString: url! });
    const targetUrl = new URL(url!);
    targetUrl.pathname = `/${databaseName}`;
    let target: pg.Pool | undefined;
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      target = new pg.Pool({ connectionString: targetUrl.toString() });
      const migrations = fileURLToPath(new URL("../../drizzle/", import.meta.url));
      const files = [
        "0000_account_backend_init.sql",
        "0001_workos_swap.sql",
        "0002_org_ownership.sql",
        "0003_profiles.sql",
        "0004_host_token_active_unique.sql",
        "0005_profiles_public_usage_stats.sql",
        "0006_profile_utc_offset.sql",
        "0007_profile_avatars.sql",
      ];
      for (const file of files) {
        await target.query(
          (await readFile(`${migrations}${file}`, "utf8")).replaceAll(
            "--> statement-breakpoint",
            "",
          ),
        );
      }
      const hostId = crypto.randomUUID();
      await target.query(
        `INSERT INTO hosts
          (id, owner_org_id, registered_by_user_id, environment_id, name, platform, kind, endpoints)
         VALUES ($1, 'org_seed', 'user_seed', 'env_seed', 'Seed', 'linux', 'local', $2::jsonb)`,
        [
          hostId,
          JSON.stringify([
            { url: "http://192.168.1.2", transport: "lan" },
            { url: "https://relay.example", transport: "public" },
          ]),
        ],
      );
      await target.query(
        (await readFile(`${migrations}0008_modern_norrin_radd.sql`, "utf8")).replaceAll(
          "--> statement-breakpoint",
          "",
        ),
      );
      await target.query(
        (await readFile(`${migrations}0009_narrow_energizer.sql`, "utf8")).replaceAll(
          "--> statement-breakpoint",
          "",
        ),
      );
      const migrated = await target.query<{
        owner_user_id: string;
        endpoints: Array<{ transport: string }>;
      }>("SELECT owner_user_id, endpoints FROM hosts WHERE id = $1", [hostId]);
      expect(migrated.rows[0]).toEqual({
        owner_user_id: "user_seed",
        endpoints: [{ url: "http://192.168.1.2", transport: "lan" }],
      });
      expect(
        (
          await target.query<{ exists: boolean }>(
            "SELECT to_regclass('public.host_tokens') IS NOT NULL AS exists",
          )
        ).rows[0]?.exists,
      ).toBe(false);
      expect(
        (
          await target.query<{ exists: boolean }>(
            `SELECT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'hosts'
                AND column_name = 'registered_by_user_id'
            ) AS exists`,
          )
        ).rows[0]?.exists,
      ).toBe(false);
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
  });
});
