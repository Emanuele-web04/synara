import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db";
import { hosts, remoteTunnels, revocationEvents } from "../db/schema";
import { createIsolatedTestDatabase } from "../testing/isolatedDatabase";
import {
  ABANDONED_HOST_IDLE_MS,
  createHostKeyRegistry,
  STALE_HOST_SWEEP_BATCH,
  SUPERSEDED_HOST_IDLE_MS,
} from "./hostKeyRegistry";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

describe.skipIf(!TEST_DATABASE_URL)("stale host retirement (PostgreSQL)", () => {
  // The sweep scans every host, so this file owns its database.
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let database: ReturnType<typeof createDb>;
  let registry: ReturnType<typeof createHostKeyRegistry>;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(TEST_DATABASE_URL!);
    database = createDb(isolated.url);
    registry = createHostKeyRegistry(database.db, "https://api.example.test/api/v1");
  });
  afterAll(async () => {
    await database?.pool.end();
    await isolated?.close();
  });
  beforeEach(async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 15));
    await database.db.execute(
      sql`TRUNCATE ${hosts}, ${remoteTunnels}, ${revocationEvents} CASCADE`,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  async function insertHost(options: {
    ownerUserId: string;
    name: string;
    createdAt: Date;
    lastSeenAt: Date;
    appVersion?: string;
    platform?: "darwin" | "linux" | "windows";
    /** Remote-enabled hosts own a desired tunnel allocation and poll the API. */
    remote?: boolean;
  }) {
    const [row] = await database.db
      .insert(hosts)
      .values({
        ownerUserId: options.ownerUserId,
        ownerOrgId: `org-${options.ownerUserId}`,
        environmentId: randomUUID(),
        name: options.name,
        platform: options.platform ?? "darwin",
        kind: "local",
        appVersion: options.appVersion ?? "1.0.6-remote.44",
        publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "test" },
        keyGeneration: 1,
        createdAt: options.createdAt,
        lastSeenAt: options.lastSeenAt,
      })
      .returning();
    if (options.remote) {
      const label = `synara-${randomUUID().replaceAll("-", "")}`;
      await database.db.insert(remoteTunnels).values({
        hostId: row!.id,
        ownerUserId: row!.ownerUserId,
        ownerOrgId: row!.ownerOrgId,
        environmentId: row!.environmentId,
        keyGeneration: row!.keyGeneration,
        hostname: `${label}.tunnel.example.test`,
        tunnelName: label,
        originPort: 4000,
      });
    }
    return row!;
  }

  async function read(id: string) {
    const [row] = await database.db.select().from(hosts).where(eq(hosts.id, id));
    return row!;
  }

  async function unlinkEvents(ids: string[]) {
    return database.db
      .select({ hostId: revocationEvents.hostId, kind: revocationEvents.kind })
      .from(revocationEvents)
      .where(inArray(revocationEvents.hostId, ids));
  }

  /** An old install of a machine and the reinstall that replaced it. */
  async function reinstalledMachine(oldLastSeenAt: Date, appVersions?: [string, string]) {
    const owner = randomUUID();
    const old = await insertHost({
      ownerUserId: owner,
      name: "Kaiross-Mac-mini.local",
      createdAt: ago(60 * DAY_MS),
      lastSeenAt: oldLastSeenAt,
      ...(appVersions ? { appVersion: appVersions[0] } : {}),
    });
    const current = await insertHost({
      ownerUserId: owner,
      name: "kaiross-mac-mini",
      createdAt: ago(10 * DAY_MS),
      lastSeenAt: ago(60_000),
      appVersion: appVersions?.[1] ?? "1.6.4",
    });
    return { owner, old, current };
  }

  it("unlinks a superseded install through the revocation path and keeps its replacement", async () => {
    const { old, current } = await reinstalledMachine(ago(SUPERSEDED_HOST_IDLE_MS + DAY_MS));

    expect(await registry.retireStaleHosts()).toEqual({ superseded: 1, abandoned: 0 });
    expect(await registry.retireStaleHosts()).toEqual({ superseded: 0, abandoned: 0 });

    const retired = await read(old.id);
    expect(retired).toMatchObject({
      publicKeyJwk: null,
      discoverable: false,
      keyGeneration: old.keyGeneration + 1,
    });
    expect(await read(current.id)).toEqual(current);
    expect(await unlinkEvents([old.id, current.id])).toEqual([
      { hostId: old.id, kind: "host_unlinked" },
    ]);
  });

  it("keeps an older install that was seen recently, as a Mac switched off for a day", async () => {
    vi.mocked(Date.now).mockReturnValue(Date.UTC(2026, 10, 12));
    const { old } = await reinstalledMachine(ago(3 * DAY_MS));

    expect(await registry.retireStaleHosts()).toEqual({ superseded: 0, abandoned: 0 });
    expect((await read(old.id)).publicKeyJwk).not.toBeNull();
  });

  it("never lets another owner's host with the same name supersede a row", async () => {
    const stale = await insertHost({
      ownerUserId: randomUUID(),
      name: "MacBook-Pro.local",
      createdAt: ago(60 * DAY_MS),
      lastSeenAt: ago(SUPERSEDED_HOST_IDLE_MS + DAY_MS),
    });
    await insertHost({
      ownerUserId: randomUUID(),
      name: "MacBook-Pro.local",
      appVersion: "1.6.4",
      createdAt: ago(DAY_MS),
      lastSeenAt: ago(60_000),
    });

    expect(await registry.retireStaleHosts()).toEqual({ superseded: 0, abandoned: 0 });
    expect((await read(stale.id)).publicKeyJwk).not.toBeNull();
  });

  it("never lets a host on another platform with the same name supersede a row", async () => {
    const owner = randomUUID();
    const linux = await insertHost({
      ownerUserId: owner,
      name: "shaan",
      platform: "linux",
      createdAt: ago(60 * DAY_MS),
      lastSeenAt: ago(SUPERSEDED_HOST_IDLE_MS + DAY_MS),
    });
    await insertHost({
      ownerUserId: owner,
      name: "shaan",
      platform: "windows",
      appVersion: "1.6.4",
      createdAt: ago(DAY_MS),
      lastSeenAt: ago(60_000),
    });

    expect(await registry.retireStaleHosts()).toEqual({ superseded: 0, abandoned: 0 });
    expect((await read(linux.id)).publicKeyJwk).not.toBeNull();
  });

  it("preserves a current host even after the abandonment cutoff and with a matching newer name", async () => {
    const { owner, old } = await reinstalledMachine(ago(ABANDONED_HOST_IDLE_MS + DAY_MS), [
      "1.6.4",
      "1.6.5-beta.1",
    ]);
    await database.db.insert(remoteTunnels).values({
      hostId: old.id,
      ownerUserId: owner,
      ownerOrgId: old.ownerOrgId,
      environmentId: old.environmentId,
      keyGeneration: old.keyGeneration,
      hostname: "stable.tunnel.example.test",
      tunnelName: "stable",
      originPort: 4000,
    });

    expect(await registry.retireStaleHosts()).toEqual({ superseded: 0, abandoned: 0 });
    expect((await read(old.id)).publicKeyJwk).not.toBeNull();
  });

  it("preserves a preview registration seen after Stable Remote launched even if its stored version is stale", async () => {
    vi.mocked(Date.now).mockReturnValue(Date.UTC(2027, 0, 15));
    const { old } = await reinstalledMachine(new Date("2026-11-11T00:00:00Z"));
    await database.db.insert(remoteTunnels).values({
      hostId: old.id,
      ownerUserId: old.ownerUserId,
      ownerOrgId: old.ownerOrgId,
      environmentId: old.environmentId,
      keyGeneration: old.keyGeneration,
      hostname: "upgraded.tunnel.example.test",
      tunnelName: "upgraded",
      originPort: 4000,
    });

    expect(await registry.retireStaleHosts()).toEqual({ superseded: 0, abandoned: 0 });
    expect((await read(old.id)).publicKeyJwk).not.toBeNull();
  });

  it("unlinks an abandoned host without any replacement, once", async () => {
    const abandoned = await insertHost({
      ownerUserId: randomUUID(),
      name: "studio",
      createdAt: ago(90 * DAY_MS),
      lastSeenAt: ago(ABANDONED_HOST_IDLE_MS + DAY_MS),
      remote: true,
    });
    const idle = await insertHost({
      ownerUserId: randomUUID(),
      name: "laptop",
      createdAt: ago(90 * DAY_MS),
      lastSeenAt: ago(ABANDONED_HOST_IDLE_MS - DAY_MS),
      remote: true,
    });

    expect(await registry.retireStaleHosts()).toEqual({ superseded: 0, abandoned: 1 });
    expect(await registry.retireStaleHosts()).toEqual({ superseded: 0, abandoned: 0 });

    expect((await read(abandoned.id)).keyGeneration).toBe(abandoned.keyGeneration + 1);
    expect((await read(idle.id)).publicKeyJwk).not.toBeNull();
    expect(await unlinkEvents([abandoned.id, idle.id])).toEqual([
      { hostId: abandoned.id, kind: "host_unlinked" },
    ]);
  });

  it("keeps a long-silent host without remote access, whose silence proves nothing", async () => {
    const local = await insertHost({
      ownerUserId: randomUUID(),
      name: "desk",
      createdAt: ago(90 * DAY_MS),
      lastSeenAt: ago(ABANDONED_HOST_IDLE_MS + DAY_MS),
    });

    expect(await registry.retireStaleHosts()).toEqual({ superseded: 0, abandoned: 0 });
    expect((await read(local.id)).publicKeyJwk).not.toBeNull();
  });

  it("counts a long-silent host without remote access as superseded when a reinstall replaced it", async () => {
    const { old } = await reinstalledMachine(ago(ABANDONED_HOST_IDLE_MS + DAY_MS));

    expect(await registry.retireStaleHosts()).toEqual({ superseded: 1, abandoned: 0 });
    expect((await read(old.id)).publicKeyJwk).toBeNull();
  });

  it("bounds each pass and retires the longest-silent hosts first", async () => {
    const rows = [];
    for (let index = 0; index <= STALE_HOST_SWEEP_BATCH; index++) {
      rows.push(
        await insertHost({
          ownerUserId: randomUUID(),
          name: `host-${index}`,
          createdAt: ago(90 * DAY_MS),
          lastSeenAt: ago(ABANDONED_HOST_IDLE_MS + (index + 1) * DAY_MS),
          remote: true,
        }),
      );
    }

    expect(await registry.retireStaleHosts()).toEqual({
      superseded: 0,
      abandoned: STALE_HOST_SWEEP_BATCH,
    });
    // The most recently seen row is the one left for the next pass.
    expect((await read(rows[0]!.id)).publicKeyJwk).not.toBeNull();
    expect(await registry.retireStaleHosts()).toEqual({ superseded: 0, abandoned: 1 });
    expect((await read(rows[0]!.id)).publicKeyJwk).toBeNull();
  });
});
