// Owns durable, account-scoped cloud erasure and access fencing.
// Provider outages retry through the existing API maintenance loop.
import type { BillingService } from "./billing/service";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { AvatarStorage } from "./avatarStorage";
import * as schema from "./db/schema";
import type { AccountIdentityVerifier } from "./identity/interfaces";
import { writeRevocationEvents } from "./identity/revocationLog";

export function createAccountDeletionService(options: {
  db: NodePgDatabase<typeof schema>;
  verifier: AccountIdentityVerifier;
  avatarStorage?: AvatarStorage;
  billing?: BillingService;
}) {
  const { db } = options;

  async function isDeleting(userId: string) {
    const [row] = await db
      .select({ id: schema.accountDeletions.userId })
      .from(schema.accountDeletions)
      .where(eq(schema.accountDeletions.userId, userId))
      .limit(1);
    return row !== undefined;
  }

  // Persist the intent before acknowledging it. Public profiles and new API
  // access disappear immediately; provider and object-store cleanup can retry.
  async function request(userId: string) {
    await db.transaction(async (tx) => {
      // Fence existing billing even when its provider is temporarily unconfigured.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`billing:${userId}`}, 0))`,
      );
      await tx
        .update(schema.billingAccounts)
        .set({ deletedAt: new Date(), accessGranted: false })
        .where(eq(schema.billingAccounts.userId, userId));
      if (options.billing) {
        await tx
          .insert(schema.billingAccounts)
          .values({ userId, deletedAt: new Date() })
          .onConflictDoUpdate({
            target: schema.billingAccounts.userId,
            set: { deletedAt: new Date(), accessGranted: false },
          });
      }
      await tx
        .insert(schema.accountDeletions)
        .values({
          userId,
          nextAttemptAt: new Date(Date.now() + 60_000),
        })
        .onConflictDoNothing();
      await tx
        .update(schema.profiles)
        .set({ public: false })
        .where(eq(schema.profiles.userId, userId));
      const hosts = await tx
        .select({ id: schema.hosts.id })
        .from(schema.hosts)
        .where(eq(schema.hosts.ownerUserId, userId))
        .orderBy(schema.hosts.id)
        .for("update");
      await tx
        .update(schema.hosts)
        .set({
          publicKeyJwk: null,
          discoverable: false,
          keyGeneration: sql`${schema.hosts.keyGeneration} + 1`,
        })
        .where(eq(schema.hosts.ownerUserId, userId));
      await writeRevocationEvents(
        tx,
        hosts.map(({ id }) => ({ hostId: id, kind: "host_unlinked" as const })),
      );
      await tx
        .update(schema.remoteTunnels)
        .set({ desired: false, ready: false, updatedAt: new Date() })
        .where(eq(schema.remoteTunnels.ownerUserId, userId));
      await tx
        .delete(schema.remotePairingCodes)
        .where(eq(schema.remotePairingCodes.ownerUserId, userId));
      await tx
        .update(schema.liveActivities)
        .set({ expiresAt: new Date(), dirty: true, nextAttemptAt: new Date() })
        .where(eq(schema.liveActivities.userId, userId));
    });
  }

  // Revisit completed local purges for a day: requests admitted just before
  // erasure can finish late. The access tombstone remains for 30 days.
  async function erase(userId: string, requestedAt: Date) {
    // Stop sandbox renewals before deleting identity; outages retry through this outbox.
    const [billing] = await db
      .select()
      .from(schema.billingAccounts)
      .where(eq(schema.billingAccounts.userId, userId));
    if (billing && (billing.customerId || billing.checkoutUrl || billing.checkoutAttemptId)) {
      if (!options.billing) throw new Error("Sandbox billing cleanup is awaiting configuration");
      await options.billing.cleanupDeletedAccount(userId);
    }
    const [profile] = await db
      .select({ key: schema.profiles.avatarKey })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId));
    if (profile?.key && options.avatarStorage) await options.avatarStorage.delete(profile.key);
    const [intent] = await db
      .select()
      .from(schema.accountDeletions)
      .where(eq(schema.accountDeletions.userId, userId));
    if (!intent?.identityDeletedAt) {
      await options.verifier.deleteUser!(userId);
      await db
        .update(schema.accountDeletions)
        .set({ identityDeletedAt: new Date() })
        .where(eq(schema.accountDeletions.userId, userId));
    }
    await db.transaction(async (tx) => {
      const hosts = await tx
        .select({ id: schema.hosts.id })
        .from(schema.hosts)
        .where(eq(schema.hosts.ownerUserId, userId))
        .orderBy(schema.hosts.id)
        .for("update");
      for (const { id } of hosts) {
        await tx.delete(schema.liveActivityHosts).where(eq(schema.liveActivityHosts.hostId, id));
      }
      await tx.delete(schema.hostSecrets).where(eq(schema.hostSecrets.ownerUserId, userId));
      await tx
        .delete(schema.hostSecretVersions)
        .where(eq(schema.hostSecretVersions.ownerUserId, userId));
      await tx.delete(schema.syncKeyWraps).where(eq(schema.syncKeyWraps.ownerUserId, userId));
      await tx
        .delete(schema.remotePairingCodes)
        .where(eq(schema.remotePairingCodes.ownerUserId, userId));
      await tx.delete(schema.linkChallenges).where(eq(schema.linkChallenges.ownerUserId, userId));
      await tx.delete(schema.liveActivities).where(eq(schema.liveActivities.userId, userId));
      await tx.delete(schema.devices).where(eq(schema.devices.userId, userId));
      await tx.delete(schema.hosts).where(eq(schema.hosts.ownerUserId, userId));
      await tx.delete(schema.inboxRecaps).where(eq(schema.inboxRecaps.userId, userId));
      await tx.delete(schema.usageModelStats).where(eq(schema.usageModelStats.userId, userId));
      await tx.delete(schema.usageSkillStats).where(eq(schema.usageSkillStats.userId, userId));
      await tx.delete(schema.profiles).where(eq(schema.profiles.userId, userId));
      // Allocation IDs remain available to the existing external cleanup job,
      // without retaining their former account, workspace or environment IDs.
      await tx
        .update(schema.remoteTunnels)
        .set({
          ownerUserId: "deleted",
          ownerOrgId: "deleted",
          environmentId: "deleted",
          desired: false,
          ready: false,
          updatedAt: new Date(),
        })
        .where(eq(schema.remoteTunnels.ownerUserId, userId));
      await tx
        .update(schema.accountDeletions)
        .set({
          completedAt: Date.now() - requestedAt.getTime() >= 86_400_000 ? new Date() : null,
          nextAttemptAt: new Date(
            Math.max(Date.now() + 60_000, requestedAt.getTime() + 86_400_000),
          ),
          leaseUntil: null,
        })
        .where(eq(schema.accountDeletions.userId, userId));
    });
  }

  async function flush() {
    if (!options.verifier.deleteUser) return;
    const due = await db
      .select()
      .from(schema.accountDeletions)
      .where(
        and(
          isNull(schema.accountDeletions.completedAt),
          lt(schema.accountDeletions.nextAttemptAt, new Date()),
          or(
            isNull(schema.accountDeletions.leaseUntil),
            lt(schema.accountDeletions.leaseUntil, new Date()),
          ),
        ),
      )
      .limit(8);
    for (const row of due) {
      const [claimed] = await db
        .update(schema.accountDeletions)
        .set({ leaseUntil: new Date(Date.now() + 120_000) })
        .where(
          and(
            eq(schema.accountDeletions.userId, row.userId),
            isNull(schema.accountDeletions.completedAt),
            lt(schema.accountDeletions.nextAttemptAt, new Date()),
            or(
              isNull(schema.accountDeletions.leaseUntil),
              lt(schema.accountDeletions.leaseUntil, new Date()),
            ),
          ),
        )
        .returning();
      if (!claimed) continue;
      try {
        await erase(row.userId, row.requestedAt);
      } catch {
        await db
          .update(schema.accountDeletions)
          .set({
            leaseUntil: null,
            nextAttemptAt: new Date(Date.now() + 60_000),
          })
          .where(eq(schema.accountDeletions.userId, row.userId));
        console.warn("[api] Account erasure remains queued");
      }
    }
    await db
      .delete(schema.accountDeletions)
      .where(
        and(
          lt(schema.accountDeletions.completedAt, new Date(Date.now() - 30 * 86_400_000)),
          lt(schema.accountDeletions.requestedAt, new Date(Date.now() - 30 * 86_400_000)),
        ),
      );
  }

  return { isDeleting, request, flush, supported: options.verifier.deleteUser !== undefined };
}
export type AccountDeletionService = ReturnType<typeof createAccountDeletionService>;
