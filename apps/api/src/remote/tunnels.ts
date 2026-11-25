import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { hosts, remoteTunnels } from "../db/schema";
import { HostAuthDomainError, type HostRecord } from "../identity/interfaces";
import type { CloudflareClient } from "./cloudflare";

type Allocation = typeof remoteTunnels.$inferSelect;
const LEASE_MS = 120_000;
const changed = () =>
  new HostAuthDomainError(
    409,
    "host_not_linked",
    "Remote allocation changed; retry from the current host identity",
  );
const sameHost = (host: HostRecord, row: typeof hosts.$inferSelect) =>
  row.publicKeyJwk !== null &&
  row.keyGeneration === host.keyGeneration &&
  row.ownerUserId === host.ownerUserId &&
  row.ownerOrgId === host.ownerOrgId &&
  row.environmentId === host.environmentId;

/** External operations never run under a SQL lock. Immutable allocation names fence old cleanup. */
export function createTunnelCoordinator(
  db: NodePgDatabase<typeof schema>,
  cloudflare: CloudflareClient,
  domain: string,
) {
  async function reserve(host: HostRecord, port: number) {
    return db.transaction(async (tx) => {
      const [current] = await tx.select().from(hosts).where(eq(hosts.id, host.id)).for("update");
      if (!current || !sameHost(host, current)) throw changed();
      const [existing] = await tx
        .select()
        .from(remoteTunnels)
        .where(and(eq(remoteTunnels.hostId, host.id), eq(remoteTunnels.desired, true)));
      if (existing && existing.keyGeneration === host.keyGeneration) return existing;
      if (existing)
        await tx
          .update(remoteTunnels)
          .set({ desired: false, ready: false, updatedAt: new Date() })
          .where(eq(remoteTunnels.id, existing.id));
      const id = randomUUID();
      const label = `synara-${id.replaceAll("-", "")}`;
      const [created] = await tx
        .insert(remoteTunnels)
        .values({
          id,
          hostId: host.id,
          ownerUserId: host.ownerUserId,
          ownerOrgId: host.ownerOrgId,
          environmentId: host.environmentId,
          keyGeneration: host.keyGeneration,
          hostname: `${label}.${domain}`,
          tunnelName: label,
          originPort: port,
        })
        .returning();
      if (!created) throw changed();
      return created;
    });
  }
  async function claim(id: string) {
    const leaseId = randomUUID();
    const [claimed] = await db
      .update(remoteTunnels)
      .set({ leaseId, leaseUntil: new Date(Date.now() + LEASE_MS) })
      .where(
        and(
          eq(remoteTunnels.id, id),
          or(isNull(remoteTunnels.leaseUntil), lt(remoteTunnels.leaseUntil, new Date())),
        ),
      )
      .returning();
    if (!claimed)
      throw new HostAuthDomainError(
        409,
        "approval_pending",
        "Remote setup is already running; retry shortly",
      );
    return claimed;
  }
  async function checkpoint(
    row: Allocation,
    values: Partial<
      Pick<Allocation, "tunnelId" | "dnsRecordId" | "originPort" | "ready" | "cleanedAt">
    >,
  ) {
    const [saved] = await db
      .update(remoteTunnels)
      .set({ ...values, updatedAt: new Date(), leaseUntil: new Date(Date.now() + LEASE_MS) })
      .where(
        and(
          eq(remoteTunnels.id, row.id),
          eq(remoteTunnels.leaseId, row.leaseId!),
          gt(remoteTunnels.leaseUntil, new Date()),
          eq(remoteTunnels.desired, row.desired),
        ),
      )
      .returning();
    if (!saved) throw changed();
    return saved;
  }
  async function release(row: Allocation) {
    await db
      .update(remoteTunnels)
      .set({ leaseId: null, leaseUntil: null })
      .where(and(eq(remoteTunnels.id, row.id), eq(remoteTunnels.leaseId, row.leaseId!)));
  }
  async function retireObsolete() {
    await db
      .update(remoteTunnels)
      .set({ desired: false, ready: false, updatedAt: new Date() })
      .where(
        and(
          eq(remoteTunnels.desired, true),
          sql`NOT EXISTS (SELECT 1 FROM ${hosts} WHERE ${hosts.id} = ${remoteTunnels.hostId}
        AND ${hosts.publicKeyJwk} IS NOT NULL AND ${hosts.keyGeneration} = ${remoteTunnels.keyGeneration}
        AND ${hosts.ownerUserId} = ${remoteTunnels.ownerUserId} AND ${hosts.ownerOrgId} = ${remoteTunnels.ownerOrgId})`,
        ),
      );
  }
  return {
    async provision(host: HostRecord, port: number) {
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw new HostAuthDomainError(400, "validation_failed", "Invalid remote ingress port");
      const row = await claim((await reserve(host, port)).id);
      try {
        // The durable name precedes create; a lost response is recovered by lookup, never another name.
        const tunnel =
          (await cloudflare.findTunnel(row.tunnelName)) ??
          (await cloudflare.createTunnel(row.tunnelName));
        await checkpoint(row, { tunnelId: tunnel.id, ready: false });
        await cloudflare.configure(tunnel.id, row.hostname, port);
        const dnsRecordId = await cloudflare.ensureDns(row.hostname, tunnel.id);
        await checkpoint(row, { dnsRecordId, originPort: port });
        const connectorToken = await cloudflare.token(tunnel.id);
        // Recheck ownership after all external work; unlink wins even if it ran during provisioning.
        return await db.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(hosts)
            .where(eq(hosts.id, host.id))
            .for("update");
          if (!current || !sameHost(host, current)) throw changed();
          const [ready] = await tx
            .update(remoteTunnels)
            .set({ ready: true, updatedAt: new Date() })
            .where(
              and(
                eq(remoteTunnels.id, row.id),
                eq(remoteTunnels.leaseId, row.leaseId!),
                gt(remoteTunnels.leaseUntil, new Date()),
                eq(remoteTunnels.desired, true),
              ),
            )
            .returning();
          if (!ready) throw changed();
          return { tunnelId: tunnel.id, hostname: row.hostname, connectorToken };
        });
      } finally {
        await release(row);
      }
    },
    async disable(host: HostRecord, tunnelId?: string) {
      await db
        .update(remoteTunnels)
        .set({ desired: false, ready: false, updatedAt: new Date() })
        .where(
          and(
            eq(remoteTunnels.hostId, host.id),
            eq(remoteTunnels.keyGeneration, host.keyGeneration),
            eq(remoteTunnels.ownerUserId, host.ownerUserId),
            tunnelId ? eq(remoteTunnels.tunnelId, tunnelId) : undefined,
          ),
        );
    },
    async endpoints(hostIds: readonly string[]) {
      if (!hostIds.length) return new Map<string, string>();
      // Join fences directory publication immediately; cleanup is deliberately eventual.
      const rows = await db
        .select({ hostId: remoteTunnels.hostId, hostname: remoteTunnels.hostname })
        .from(remoteTunnels)
        .innerJoin(
          hosts,
          and(
            eq(hosts.id, remoteTunnels.hostId),
            eq(hosts.keyGeneration, remoteTunnels.keyGeneration),
          ),
        )
        .where(
          and(
            eq(remoteTunnels.desired, true),
            eq(remoteTunnels.ready, true),
            sql`${hosts.publicKeyJwk} IS NOT NULL`,
            inArray(hosts.id, [...hostIds]),
          ),
        );
      return new Map(rows.map((row) => [row.hostId, `https://${row.hostname}`]));
    },
    async cleanup() {
      await retireObsolete();
      // Retain and revisit allocation tombstones: a provider may finish a create
      // after the request timed out and after an initial empty cleanup lookup.
      const pending = await db
        .select()
        .from(remoteTunnels)
        .where(
          and(
            eq(remoteTunnels.desired, false),
            or(
              isNull(remoteTunnels.cleanedAt),
              lt(remoteTunnels.cleanedAt, new Date(Date.now() - 3_600_000)),
            ),
          ),
        )
        .orderBy(remoteTunnels.updatedAt)
        .limit(10);
      for (const candidate of pending) {
        let row: Allocation;
        try {
          row = await claim(candidate.id);
        } catch {
          continue;
        }
        try {
          const tunnel = await cloudflare.findTunnel(row.tunnelName);
          const tunnelId = tunnel?.id ?? row.tunnelId;
          if (tunnelId) {
            await cloudflare.deleteDns(row.hostname, tunnelId);
            await cloudflare.deleteTunnel(tunnelId);
          }
          await checkpoint(row, { cleanedAt: new Date(), ready: false });
        } catch {
          // Keep names/IDs, rotate failed entries to the end of the bounded retry batch.
          await db
            .update(remoteTunnels)
            .set({ updatedAt: new Date() })
            .where(eq(remoteTunnels.id, row.id));
        } finally {
          await release(row);
        }
      }
    },
  };
}
export type TunnelCoordinator = ReturnType<typeof createTunnelCoordinator>;
