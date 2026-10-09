import { randomBytes, createHash } from "node:crypto";
import { DEVICE_USER_CODE_ALPHABET, type RemotePairingBundle } from "@synara/contracts";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { decodeJwt } from "jose";
import type * as schema from "../db/schema";
import {
  devices,
  hosts,
  remotePairingCodes as codes,
  remotePairingBudgets as budgets,
} from "../db/schema";
import { HostAuthDomainError, type HostRecord } from "../identity/interfaces";
import { isUniqueViolation } from "../identity/hostRecords";
import { verifyJwtWithEmbeddedJwk } from "../identity/signing";

const invalid = () =>
  new HostAuthDomainError(
    400,
    "challenge_expired",
    "The pairing code is invalid, used, or expired",
  );
export function createPairingRendezvous(db: NodePgDatabase<typeof schema>, apiIssuer: string) {
  return {
    async publish(host: HostRecord, bundle: RemotePairingBundle) {
      if (
        bundle.hostId !== host.id ||
        bundle.environmentId !== host.environmentId ||
        bundle.userId !== host.ownerUserId ||
        bundle.organizationId !== host.ownerOrgId ||
        bundle.accountAuthority !== apiIssuer ||
        Date.parse(bundle.expiresAt) <= Date.now() ||
        Date.parse(bundle.expiresAt) > Date.now() + 600_000
      )
        throw invalid();
      await db.delete(codes).where(lt(codes.expiresAt, new Date()));
      for (let attempt = 0; attempt < 5; attempt++) {
        const raw = [...randomBytes(8)]
          .map((byte) => DEVICE_USER_CODE_ALPHABET[byte & 31])
          .join("");
        const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
        try {
          return await db.transaction(async (tx) => {
            const [current] = await tx
              .select()
              .from(hosts)
              .where(eq(hosts.id, host.id))
              .for("update");
            if (
              !current?.publicKeyJwk ||
              current.keyGeneration !== host.keyGeneration ||
              current.ownerUserId !== host.ownerUserId ||
              current.ownerOrgId !== host.ownerOrgId
            )
              throw invalid();
            // Explicit renewal cancels the previous rendezvous. Local owner approval remains required.
            await tx
              .update(codes)
              .set({ cancelledAt: new Date(), bundle: null })
              .where(and(eq(codes.hostId, host.id), isNull(codes.cancelledAt)));
            await tx.insert(codes).values({
              inviteId: bundle.inviteId,
              hostId: host.id,
              ownerUserId: host.ownerUserId,
              ownerOrgId: host.ownerOrgId,
              keyGeneration: host.keyGeneration,
              code,
              bundle,
              expiresAt: new Date(bundle.expiresAt),
            });
            return { code, inviteId: bundle.inviteId, expiresAt: bundle.expiresAt };
          });
        } catch (error) {
          if (!isUniqueViolation(error) || attempt === 4) throw error;
        }
      }
      throw invalid();
    },
    async cancel(host: HostRecord, inviteId: string) {
      await db
        .update(codes)
        .set({ cancelledAt: new Date(), bundle: null })
        .where(
          and(
            eq(codes.inviteId, inviteId),
            eq(codes.hostId, host.id),
            eq(codes.keyGeneration, host.keyGeneration),
          ),
        );
    },
    async consumeBudget(key: string, limit: number) {
      const digest = createHash("sha256").update(key).digest("hex");
      const now = new Date();
      const [row] = await db
        .insert(budgets)
        .values({ key: digest, attempts: 1, expiresAt: new Date(now.getTime() + 60_000) })
        .onConflictDoUpdate({
          target: budgets.key,
          set: {
            attempts: sql`CASE WHEN ${budgets.expiresAt} <= ${now} THEN 1 ELSE ${budgets.attempts} + 1 END`,
            expiresAt: sql`CASE WHEN ${budgets.expiresAt} <= ${now} THEN ${new Date(now.getTime() + 60_000)} ELSE ${budgets.expiresAt} END`,
          },
        })
        .returning();
      return Boolean(row && row.attempts <= limit);
    },
    async redeem(
      session: { userId: string; orgId: string },
      code: string,
      deviceJkt: string,
      proof: string,
    ) {
      // Device -> host -> invitation lock order matches grants/revocation and prevents double redemption.
      return db.transaction(async (tx) => {
        const [device] = await tx
          .select()
          .from(devices)
          .where(
            and(
              eq(devices.userId, session.userId),
              eq(devices.jkt, deviceJkt),
              isNull(devices.revokedAt),
            ),
          )
          .for("update");
        if (!device) throw invalid();
        try {
          await verifyJwtWithEmbeddedJwk(proof, {
            typ: "synara-pairing-code+jwt",
            audience: apiIssuer,
            issuer: "synara-device",
            algorithms: ["ES256"],
            maxAgeSeconds: 60,
            publicKeyJwk: device.publicKeyJwk,
          });
          const claims = decodeJwt(proof);
          if (claims.sub !== session.userId || claims.code !== code) throw invalid();
        } catch {
          throw invalid();
        }
        const [candidate] = await tx
          .select()
          .from(codes)
          .where(
            and(
              eq(codes.code, code),
              eq(codes.ownerUserId, session.userId),
              eq(codes.ownerOrgId, session.orgId),
            ),
          );
        if (!candidate) throw invalid();
        const [host] = await tx
          .select()
          .from(hosts)
          .where(eq(hosts.id, candidate.hostId))
          .for("update");
        if (
          !host?.publicKeyJwk ||
          host.keyGeneration !== candidate.keyGeneration ||
          host.ownerUserId !== session.userId ||
          host.ownerOrgId !== session.orgId
        )
          throw invalid();
        const [row] = await tx
          .select()
          .from(codes)
          .where(
            and(
              eq(codes.inviteId, candidate.inviteId),
              isNull(codes.claimedJkt),
              isNull(codes.cancelledAt),
              gt(codes.expiresAt, new Date()),
            ),
          )
          .for("update");
        if (!row?.bundle) throw invalid();
        await tx
          .update(codes)
          .set({ claimedJkt: deviceJkt, bundle: null })
          .where(eq(codes.inviteId, row.inviteId));
        return row.bundle;
      });
    },
    async cleanup() {
      await db.delete(codes).where(lt(codes.expiresAt, new Date()));
      await db.delete(budgets).where(lt(budgets.expiresAt, new Date()));
    },
  };
}
