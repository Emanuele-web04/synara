import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

export type ManagedAttachmentState = "uploading" | "staged" | "claimed" | "deleting" | "deleted";

export interface ManagedAttachmentBlob {
  readonly attachmentId: string;
  readonly ownerThreadId: string;
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly originalName: string;
  readonly mimeType: string;
  readonly reservedBytes: number;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly relativePath: string;
  readonly state: ManagedAttachmentState;
  readonly stagingExpiresAt: string | null;
  readonly claimCommandId: string | null;
  readonly claimMessageId: string | null;
  readonly claimedAt: string | null;
  readonly deleteReason: string | null;
  readonly deleteRequestedAt: string | null;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagedAttachmentCleanupJob {
  readonly attachmentId: string;
  readonly relativePath: string;
  readonly reason: string;
  readonly attemptCount: number;
  readonly nextAttemptAt: string;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const MANAGED_ATTACHMENT_CLEANUP_MAX_ATTEMPTS = 8;

export interface ManagedAttachmentLimits {
  readonly homeBytes: number;
  readonly homeCount: number;
  readonly principalStagingBytes: number;
  readonly principalStagingCount: number;
}

export const DEFAULT_MANAGED_ATTACHMENT_LIMITS: ManagedAttachmentLimits = {
  homeBytes: 5 * 1024 * 1024 * 1024,
  homeCount: 20_000,
  principalStagingBytes: 256 * 1024 * 1024,
  principalStagingCount: 16,
};

export type ReserveManagedAttachmentResult =
  | { readonly status: "reserved"; readonly attachment: ManagedAttachmentBlob }
  | { readonly status: "quota-exceeded" }
  | { readonly status: "id-conflict" };

export type FinalizeManagedAttachmentResult =
  | { readonly status: "staged"; readonly attachment: ManagedAttachmentBlob }
  | { readonly status: "not-uploading" };

export type CancelManagedAttachmentResult =
  | { readonly status: "cancelled" }
  | { readonly status: "not-found" }
  | { readonly status: "already-claimed" };

export type ClaimManagedAttachmentsResult =
  | { readonly status: "claimed"; readonly attachments: ReadonlyArray<ManagedAttachmentBlob> }
  | {
      readonly status: "rejected";
      readonly reason:
        | "duplicate-id"
        | "missing"
        | "owner-mismatch"
        | "expired"
        | "already-claimed";
    };

export interface ManagedAttachmentUsage {
  readonly homeBytes: number;
  readonly homeCount: number;
  readonly principalStagingBytes: number;
  readonly principalStagingCount: number;
}

export interface ManagedAttachmentRepositoryShape {
  readonly reserve: (input: {
    readonly attachmentId: string;
    readonly ownerThreadId: string;
    readonly ownerKind: string;
    readonly ownerId: string;
    readonly kind: string;
    readonly originalName: string;
    readonly mimeType: string;
    readonly reservedBytes: number;
    readonly relativePath: string;
    readonly now: string;
  }) => Effect.Effect<ReserveManagedAttachmentResult, PersistenceSqlError>;
  readonly finalizeStaged: (input: {
    readonly attachmentId: string;
    readonly ownerThreadId: string;
    readonly ownerKind: string;
    readonly ownerId: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly stagingExpiresAt: string;
    readonly now: string;
  }) => Effect.Effect<FinalizeManagedAttachmentResult, PersistenceSqlError>;
  readonly findServerOwned: (input: {
    readonly attachmentId: string;
    readonly ownerThreadId: string;
    readonly ownerKind: string;
    readonly ownerId: string;
    readonly now: string;
  }) => Effect.Effect<Option.Option<ManagedAttachmentBlob>, PersistenceSqlError>;
  readonly findClaimedById: (input: {
    readonly attachmentId: string;
  }) => Effect.Effect<Option.Option<ManagedAttachmentBlob>, PersistenceSqlError>;
  readonly findClaimedForCommand: (input: {
    readonly commandId: string;
  }) => Effect.Effect<ReadonlyArray<ManagedAttachmentBlob>, PersistenceSqlError>;
  readonly cancelStaged: (input: {
    readonly attachmentId: string;
    readonly ownerKind: string;
    readonly ownerId: string;
    readonly reason: string;
    readonly requestedAt: string;
  }) => Effect.Effect<CancelManagedAttachmentResult, PersistenceSqlError>;
  readonly claimForAcceptedTurn: (input: {
    readonly attachmentIds: ReadonlyArray<string>;
    readonly ownerThreadId: string;
    readonly ownerKind: string;
    readonly ownerId: string;
    readonly commandId: string;
    readonly messageId: string;
    readonly now: string;
  }) => Effect.Effect<ClaimManagedAttachmentsResult, PersistenceSqlError>;
  /** Compose this operation inside the transaction that removes the durable reference. */
  readonly markCleanupByIds: (input: {
    readonly attachmentIds: ReadonlyArray<string>;
    readonly ownerThreadId: string;
    readonly reason: string;
    readonly requestedAt: string;
  }) => Effect.Effect<ReadonlyArray<string>, PersistenceSqlError>;
  /** Compose this operation inside the transaction that hard-deletes the thread. */
  readonly markCleanupByThread: (input: {
    readonly ownerThreadId: string;
    readonly reason: string;
    readonly requestedAt: string;
  }) => Effect.Effect<ReadonlyArray<string>, PersistenceSqlError>;
  /** Compose inside the projection transaction after computing exact retained managed IDs. */
  readonly markUnreferencedClaimedForCleanup: (input: {
    readonly ownerThreadId: string;
    readonly retainedAttachmentIds: ReadonlyArray<string>;
    readonly reason: string;
    readonly requestedAt: string;
  }) => Effect.Effect<ReadonlyArray<string>, PersistenceSqlError>;
  readonly markExpiredForCleanup: (input: {
    readonly now: string;
    readonly uploadingCutoff: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<string>, PersistenceSqlError>;
  readonly leaseCleanup: (input: {
    readonly leaseOwner: string;
    readonly now: string;
    readonly leaseExpiresAt: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ManagedAttachmentCleanupJob>, PersistenceSqlError>;
  /** Jobs at the retry ceiling remain durable and require operator intervention. */
  readonly listFailedCleanup: (input: {
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ManagedAttachmentCleanupJob>, PersistenceSqlError>;
  /** Purge only completed tombstones older than the caller-owned retention cutoff. */
  readonly compactDeleted: (input: {
    readonly deletedBefore: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<string>, PersistenceSqlError>;
  readonly retryCleanup: (input: {
    readonly attachmentId: string;
    readonly expectedLeaseOwner: string;
    readonly error: string;
    readonly nextAttemptAt: string;
    readonly updatedAt: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  /** `already-missing` (ENOENT) and a physical delete have identical durable completion. */
  readonly completeCleanup: (input: {
    readonly attachmentId: string;
    readonly expectedLeaseOwner: string;
    readonly disposition: "deleted" | "already-missing";
    readonly completedAt: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  readonly getUsage: (input: {
    readonly ownerKind: string;
    readonly ownerId: string;
  }) => Effect.Effect<ManagedAttachmentUsage, PersistenceSqlError>;
}

export class ManagedAttachmentRepository extends ServiceMap.Service<
  ManagedAttachmentRepository,
  ManagedAttachmentRepositoryShape
>()("synara/persistence/Services/ManagedAttachments/ManagedAttachmentRepository") {}
