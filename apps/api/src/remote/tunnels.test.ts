import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../db";
import { runMigrations } from "../db/migrate";
import { hosts, remoteTunnels } from "../db/schema";
import type { HostRecord } from "../identity/interfaces";
import type { CloudflareClient } from "./cloudflare";
import { createTunnelCoordinator } from "./tunnels";

describe.skipIf(!process.env.TEST_DATABASE_URL)("managed tunnel recovery (PostgreSQL)", () => {
  const database = createDb(process.env.TEST_DATABASE_URL ?? "postgres://unused");
  beforeAll(() => runMigrations(process.env.TEST_DATABASE_URL!));
  afterAll(() => database.pool.end());
  async function fixture() {
    const id = randomUUID();
    const host: HostRecord = {
      id,
      ownerUserId: id,
      ownerOrgId: id,
      environmentId: id,
      keyGeneration: 1,
      discoverable: false,
      publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "test" },
    };
    await database.db
      .insert(hosts)
      .values({ ...host, name: "fixture", platform: "darwin", kind: "local" });
    const tunnels = new Map<string, { id: string; name: string }>();
    let creates = 0;
    const client: CloudflareClient = {
      findTunnel: async (name) => tunnels.get(name),
      createTunnel: async (name) => {
        creates++;
        const row = { id: randomUUID(), name };
        tunnels.set(name, row);
        return row;
      },
      configure: async () => {},
      ensureDns: async () => randomUUID(),
      token: async () => "private-connector-token",
      deleteDns: async () => {},
      deleteTunnel: async (id) => {
        for (const [name, row] of tunnels) if (row.id === id) tunnels.delete(name);
      },
    };
    return {
      host,
      client,
      tunnels,
      creates: () => creates,
      service: createTunnelCoordinator(database.db, client, "remote.example.test"),
    };
  }
  it("reuses allocation and connector token without exposing it in the directory", async () => {
    const f = await fixture();
    const first = await f.service.provision(f.host, 34567);
    expect(await f.service.provision(f.host, 34568)).toEqual(first);
    expect(f.creates()).toBe(1);
    expect([...(await f.service.endpoints([f.host.id]))]).toEqual([
      [f.host.id, `https://${first.hostname}`],
    ]);
  });
  it("a delayed disable cannot retire the next allocation of the same host key", async () => {
    const f = await fixture();
    const old = await f.service.provision(f.host, 34567);
    await f.service.disable(f.host, old.tunnelId);
    const next = await f.service.provision(f.host, 34568);
    await f.service.disable(f.host, old.tunnelId);
    expect([...(await f.service.endpoints([f.host.id]))]).toEqual([
      [f.host.id, `https://${next.hostname}`],
    ]);
  });
  it("serializes two concurrent requests without holding a host SQL lock across Cloudflare", async () => {
    const f = await fixture();
    let unblock!: () => void;
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    f.client.configure = async () => {
      entered();
      await gate;
    };
    const first = f.service.provision(f.host, 34567);
    await entering;
    await expect(f.service.provision(f.host, 34567)).rejects.toThrow("already running");
    await database.db
      .update(hosts)
      .set({ name: "host lock is free" })
      .where(eq(hosts.id, f.host.id));
    unblock();
    await first;
    expect(f.creates()).toBe(1);
  });
  it("recovers a create whose response was lost, then a DNS failure", async () => {
    const f = await fixture();
    const create = f.client.createTunnel;
    f.client.createTunnel = async (name) => {
      await create(name);
      throw new Error("response lost");
    };
    await expect(f.service.provision(f.host, 34567)).rejects.toThrow("response lost");
    f.client.ensureDns = async () => {
      throw new Error("dns failed");
    };
    await expect(f.service.provision(f.host, 34567)).rejects.toThrow("dns failed");
    f.client.ensureDns = async () => "dns-id";
    await f.service.provision(f.host, 34567);
    expect(f.creates()).toBe(1);
  });
  it("fences unlink during provisioning and retries failed cleanup after host deletion", async () => {
    const f = await fixture();
    f.client.token = async () => {
      await database.db.delete(hosts).where(eq(hosts.id, f.host.id));
      return "private-connector-token";
    };
    await expect(f.service.provision(f.host, 34567)).rejects.toThrow("allocation changed");
    expect((await f.service.endpoints([f.host.id])).size).toBe(0);
    const remove = f.client.deleteTunnel;
    f.client.deleteTunnel = async () => {
      throw new Error("unavailable");
    };
    await f.service.cleanup();
    expect(f.tunnels.size).toBe(1);
    f.client.deleteTunnel = remove;
    await f.service.cleanup();
    expect(f.tunnels.size).toBe(0);
  });
  it("never lets old cleanup delete a newly enabled allocation", async () => {
    const f = await fixture();
    const old = await f.service.provision(f.host, 34567);
    await f.service.disable(f.host);
    const next = await f.service.provision(f.host, 34567);
    expect(next.tunnelId).not.toBe(old.tunnelId);
    await f.service.cleanup();
    expect([...f.tunnels.values()].map((row) => row.id)).toEqual([next.tunnelId]);
    const rows = await database.db
      .select()
      .from(remoteTunnels)
      .where(eq(remoteTunnels.hostId, f.host.id));
    expect(rows.find((row) => !row.desired)?.cleanedAt).toBeInstanceOf(Date);
  });
  it("rejects stale host generations before touching Cloudflare", async () => {
    const f = await fixture();
    await database.db.update(hosts).set({ keyGeneration: 2 }).where(eq(hosts.id, f.host.id));
    await expect(f.service.provision(f.host, 34567)).rejects.toThrow("allocation changed");
    expect(f.creates()).toBe(0);
  });
});
