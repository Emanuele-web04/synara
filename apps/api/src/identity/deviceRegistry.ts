import {
  DEVICE_REGISTER_JWT_TYP,
  DEVICE_REGISTER_MAX_AGE_SECONDS,
  DeviceRegisterClaims,
  SYNARA_DEVICE_ISSUER,
  type AccountDevice,
} from "@synara/contracts";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Schema } from "effect";
import { decodeJwt } from "jose";
import type * as schema from "../db/schema";
import { devices, hosts, deviceAccountSessions, deviceRevocationDeliveries } from "../db/schema";
import { HostAuthDomainError, type DeviceRegistry } from "./interfaces";
import { publicJwkThumbprint, verifyJwtWithEmbeddedJwk } from "./signing";
import { writeRevocationEvents } from "./revocationLog";

type DeviceRow = typeof devices.$inferSelect;

/**
 * Ceiling on device_revoked events written per revocation. Only hosts the
 * device could actually have connected to (linked, and owned-or-discoverable)
 * are notified, newest first; past this the credential TTL and reconnect
 * re-verification are the backstop.
 */
const DEVICE_REVOKE_FANOUT_LIMIT = 200;

function toAccountDevice(row: DeviceRow): AccountDevice {
  return {
    id: row.id,
    publicKeyJwk: row.publicKeyJwk,
    jkt: row.jkt,
    displayName: row.displayName,
    platform: row.platform,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export function createDeviceRegistry(
  db: NodePgDatabase<typeof schema>,
  apiIssuer: string,
): DeviceRegistry {
  return {
    async register(userId, proof, verifiedSessionId) {
      let claims: typeof DeviceRegisterClaims.Type;
      let jkt: string;
      try {
        claims = Schema.decodeUnknownSync(DeviceRegisterClaims)(decodeJwt(proof));
        if (claims.sub !== userId || claims.iss !== SYNARA_DEVICE_ISSUER) {
          throw new Error("Device proof identity does not match the session");
        }
        await verifyJwtWithEmbeddedJwk(proof, {
          typ: DEVICE_REGISTER_JWT_TYP,
          audience: apiIssuer,
          issuer: SYNARA_DEVICE_ISSUER,
          algorithms: ["ES256", "EdDSA"],
          maxAgeSeconds: DEVICE_REGISTER_MAX_AGE_SECONDS,
          publicKeyJwk: claims.publicKeyJwk,
        });
        jkt = await publicJwkThumbprint(claims.publicKeyJwk);
      } catch {
        throw new HostAuthDomainError(401, "bad_proof", "Device proof is invalid");
      }

      return db.transaction(async (tx) => {
        // Serialize first registration too; row locks alone cannot lock an absent key.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([userId, jkt])}, 0))`,
        );
        const rows = await tx
          .select()
          .from(devices)
          .where(and(eq(devices.userId, userId), eq(devices.jkt, jkt)))
          .for("update");
        if (rows.some((row) => row.revokedAt !== null)) {
          throw new HostAuthDomainError(
            403,
            "device_not_registered",
            "This device key was revoked. Create a new device identity and pair it explicitly.",
          );
        }
        const [revokedSession] = await tx
          .select()
          .from(deviceAccountSessions)
          .where(
            and(
              eq(deviceAccountSessions.userId, userId),
              eq(deviceAccountSessions.sessionId, verifiedSessionId),
              isNotNull(deviceAccountSessions.revokedAt),
            ),
          )
          .limit(1);
        if (revokedSession)
          throw new HostAuthDomainError(401, "unauthorized", "Account session was revoked");
        const active = rows[0];
        const values = {
          publicKeyJwk: claims.publicKeyJwk,
          displayName: claims.displayName,
          platform: claims.platform,
        };
        const [row] = active
          ? await tx.update(devices).set(values).where(eq(devices.id, active.id)).returning()
          : await tx
              .insert(devices)
              .values({ ...values, userId, jkt })
              .returning();
        if (!row) throw new Error("Device registration returned no row");
        await tx
          .insert(deviceAccountSessions)
          .values({ deviceId: row.id, userId, sessionId: verifiedSessionId })
          .onConflictDoNothing();
        return toAccountDevice(row);
      });
    },

    async isSessionRevoked(userId, sessionId) {
      const [row] = await db
        .select({ sessionId: deviceAccountSessions.sessionId })
        .from(deviceAccountSessions)
        .where(
          and(
            eq(deviceAccountSessions.userId, userId),
            eq(deviceAccountSessions.sessionId, sessionId),
            isNotNull(deviceAccountSessions.revokedAt),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    async revokeSessions(userId, deviceId, deliver) {
      const bindings = await db.transaction(async (tx) => {
        const [device] = await tx
          .select()
          .from(devices)
          .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
          .for("update");
        if (!device) return undefined;
        await tx
          .update(deviceAccountSessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(deviceAccountSessions.deviceId, deviceId),
              isNull(deviceAccountSessions.revokedAt),
            ),
          );
        return tx
          .select()
          .from(deviceAccountSessions)
          .where(eq(deviceAccountSessions.deviceId, deviceId));
      });
      if (!bindings) return undefined;
      let confirmed = 0;
      let pending = 0;
      for (const binding of bindings) {
        if (binding.deliveredAt) {
          confirmed++;
          continue;
        }
        try {
          await deliver(binding.sessionId);
          await db
            .update(deviceAccountSessions)
            .set({ deliveredAt: new Date() })
            .where(
              and(
                eq(deviceAccountSessions.userId, userId),
                eq(deviceAccountSessions.sessionId, binding.sessionId),
                isNotNull(deviceAccountSessions.revokedAt),
              ),
            );
          confirmed++;
        } catch {
          pending++;
        }
      }
      return { confirmed, pending };
    },

    async list(userId) {
      const ownDevices = await db.select().from(devices).where(eq(devices.userId, userId));
      const deliveries = await db
        .select({
          deviceId: deviceRevocationDeliveries.deviceId,
          hostId: hosts.id,
          hostName: hosts.name,
          confirmedAt: deviceRevocationDeliveries.confirmedAt,
        })
        .from(deviceRevocationDeliveries)
        .innerJoin(devices, eq(devices.id, deviceRevocationDeliveries.deviceId))
        .innerJoin(hosts, eq(hosts.id, deviceRevocationDeliveries.hostId))
        .where(and(eq(devices.userId, userId), eq(hosts.ownerUserId, userId)));
      return ownDevices.map((row) => ({
        ...toAccountDevice(row),
        revocationDeliveries: deliveries
          .filter((delivery) => delivery.deviceId === row.id)
          .map(({ hostId, hostName, confirmedAt }) => ({
            hostId,
            hostName,
            confirmedAt: confirmedAt?.toISOString() ?? null,
          })),
      }));
    },

    async revoke(userId, deviceId, affectedOrgIds) {
      const row = await db.transaction(async (tx) => {
        const [revoked] = await tx
          .update(devices)
          .set({ revokedAt: new Date() })
          .where(
            and(eq(devices.id, deviceId), eq(devices.userId, userId), isNull(devices.revokedAt)),
          )
          .returning();
        if (!revoked) return undefined;
        // Over-notify, but bounded: the API keeps no session bookkeeping, so
        // it cannot know which hosts the device actually touched. Fanning out
        // to every host in every org the user belongs to lets one member of a
        // large org flood the shared feed (org size x revokes, durable for
        // 24h). Cap the fan-out; hosts beyond it still enforce at credential
        // expiry, and a host that missed the signal re-verifies on its next
        // control-socket reconnect.
        const uniqueOrgIds = [...new Set(affectedOrgIds)];
        const affectedHosts =
          uniqueOrgIds.length > 0
            ? await tx
                .select({ id: hosts.id })
                .from(hosts)
                .where(
                  and(
                    inArray(hosts.ownerOrgId, uniqueOrgIds),
                    isNotNull(hosts.publicKeyJwk),
                    or(eq(hosts.ownerUserId, userId), eq(hosts.discoverable, true)),
                  ),
                )
                .orderBy(desc(hosts.lastSeenAt))
                .limit(DEVICE_REVOKE_FANOUT_LIMIT)
            : [];
        if (affectedHosts.length > 0) {
          await tx
            .insert(deviceRevocationDeliveries)
            .values(
              affectedHosts.map((host) => ({
                deviceId: revoked.id,
                hostId: host.id,
                revokedAt: revoked.revokedAt!,
              })),
            )
            .onConflictDoNothing();
          await writeRevocationEvents(
            tx,
            affectedHosts.map((host) => ({
              hostId: host.id,
              kind: "device_revoked" as const,
              subject: revoked.jkt,
            })),
          );
        }
        return revoked;
      });
      return row ? toAccountDevice(row) : undefined;
    },
  };
}
