import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DEFAULT_MANAGED_ATTACHMENT_LIMITS,
  MANAGED_ATTACHMENT_CLEANUP_MAX_ATTEMPTS,
  ManagedAttachmentRepository,
  type ClaimManagedAttachmentsResult,
  type ManagedAttachmentBlob,
  type ManagedAttachmentCleanupJob,
  type ManagedAttachmentLimits,
  type ManagedAttachmentRepositoryShape,
  type ManagedAttachmentUsage,
} from "../Services/ManagedAttachments.ts";

const blobColumns = (sql: SqlClient.SqlClient) => sql`
  attachment_id AS "attachmentId",
  owner_thread_id AS "ownerThreadId",
  owner_kind AS "ownerKind",
  owner_id AS "ownerId",
  kind,
  original_name AS "originalName",
  mime_type AS "mimeType",
  reserved_bytes AS "reservedBytes",
  size_bytes AS "sizeBytes",
  sha256,
  relative_path AS "relativePath",
  state,
  staging_expires_at AS "stagingExpiresAt",
  claim_command_id AS "claimCommandId",
  claim_message_id AS "claimMessageId",
  claimed_at AS "claimedAt",
  delete_reason AS "deleteReason",
  delete_requested_at AS "deleteRequestedAt",
  deleted_at AS "deletedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const makeRepository = (limits: ManagedAttachmentLimits) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const reserve: ManagedAttachmentRepositoryShape["reserve"] = (input) =>
      Effect.gen(function* () {
        const inserted = yield* sql<ManagedAttachmentBlob>`
          INSERT INTO managed_attachment_blobs (
            attachment_id, owner_thread_id, owner_kind, owner_id,
            kind, original_name, mime_type, reserved_bytes, size_bytes, sha256,
            relative_path, state, staging_expires_at,
            claim_command_id, claim_message_id, claimed_at,
            delete_reason, delete_requested_at, deleted_at,
            created_at, updated_at
          )
          SELECT
            ${input.attachmentId}, ${input.ownerThreadId}, ${input.ownerKind}, ${input.ownerId},
            ${input.kind}, ${input.originalName}, ${input.mimeType}, ${input.reservedBytes}, NULL, NULL,
            ${input.relativePath}, 'uploading', NULL,
            NULL, NULL, NULL,
            NULL, NULL, NULL,
            ${input.now}, ${input.now}
          WHERE ${input.reservedBytes} >= 0
            AND (
              SELECT COALESCE(SUM(
                CASE WHEN state = 'uploading' THEN reserved_bytes
                     ELSE COALESCE(size_bytes, reserved_bytes) END
              ), 0)
              FROM managed_attachment_blobs
              WHERE state <> 'deleted'
            ) + ${input.reservedBytes} <= ${limits.homeBytes}
            AND (
              SELECT COUNT(*)
              FROM managed_attachment_blobs
              WHERE state <> 'deleted'
            ) + 1 <= ${limits.homeCount}
            AND (
              SELECT COALESCE(SUM(
                CASE WHEN state = 'uploading' THEN reserved_bytes
                     ELSE COALESCE(size_bytes, reserved_bytes) END
              ), 0)
              FROM managed_attachment_blobs
              WHERE owner_kind = ${input.ownerKind}
                AND owner_id = ${input.ownerId}
                AND state IN ('uploading', 'staged')
            ) + ${input.reservedBytes} <= ${limits.principalStagingBytes}
            AND (
              SELECT COUNT(*)
              FROM managed_attachment_blobs
              WHERE owner_kind = ${input.ownerKind}
                AND owner_id = ${input.ownerId}
                AND state IN ('uploading', 'staged')
            ) + 1 <= ${limits.principalStagingCount}
          ON CONFLICT DO NOTHING
          RETURNING ${blobColumns(sql)}
        `;
        if (inserted[0]) {
          return { status: "reserved" as const, attachment: inserted[0] };
        }
        const conflicts = yield* sql<{ readonly value: number }>`
          SELECT 1 AS value
          FROM managed_attachment_blobs
          WHERE attachment_id = ${input.attachmentId}
             OR relative_path = ${input.relativePath}
          LIMIT 1
        `;
        return conflicts.length > 0
          ? { status: "id-conflict" as const }
          : { status: "quota-exceeded" as const };
      }).pipe(Effect.mapError(toPersistenceSqlError("ManagedAttachment.reserve")));

    const finalizeStaged: ManagedAttachmentRepositoryShape["finalizeStaged"] = (input) =>
      sql<ManagedAttachmentBlob>`
        UPDATE managed_attachment_blobs
        SET state = 'staged',
            size_bytes = ${input.sizeBytes},
            sha256 = ${input.sha256},
            staging_expires_at = ${input.stagingExpiresAt},
            updated_at = ${input.now}
        WHERE attachment_id = ${input.attachmentId}
          AND owner_thread_id = ${input.ownerThreadId}
          AND owner_kind = ${input.ownerKind}
          AND owner_id = ${input.ownerId}
          AND state = 'uploading'
          AND ${input.sizeBytes} >= 0
          AND ${input.sizeBytes} <= reserved_bytes
        RETURNING ${blobColumns(sql)}
      `.pipe(
        Effect.map((rows) =>
          rows[0]
            ? { status: "staged" as const, attachment: rows[0] }
            : { status: "not-uploading" as const },
        ),
        Effect.mapError(toPersistenceSqlError("ManagedAttachment.finalizeStaged")),
      );

    const findServerOwned: ManagedAttachmentRepositoryShape["findServerOwned"] = (input) =>
      sql<ManagedAttachmentBlob>`
        SELECT ${blobColumns(sql)}
        FROM managed_attachment_blobs
        WHERE attachment_id = ${input.attachmentId}
          AND owner_thread_id = ${input.ownerThreadId}
          AND owner_kind = ${input.ownerKind}
          AND owner_id = ${input.ownerId}
          AND (
            state = 'claimed'
            OR (state = 'staged' AND staging_expires_at > ${input.now})
          )
      `.pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(toPersistenceSqlError("ManagedAttachment.findServerOwned")),
      );

    const findClaimedById: ManagedAttachmentRepositoryShape["findClaimedById"] = (input) =>
      sql<ManagedAttachmentBlob>`
        SELECT ${blobColumns(sql)}
        FROM managed_attachment_blobs
        WHERE attachment_id = ${input.attachmentId}
          AND state = 'claimed'
      `.pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(toPersistenceSqlError("ManagedAttachment.findClaimedById")),
      );

    const findClaimedForCommand: ManagedAttachmentRepositoryShape["findClaimedForCommand"] = (
      input,
    ) =>
      sql<ManagedAttachmentBlob>`
          SELECT ${blobColumns(sql)}
          FROM managed_attachment_blobs
          WHERE claim_command_id = ${input.commandId}
            AND state = 'claimed'
          ORDER BY attachment_id ASC
        `.pipe(Effect.mapError(toPersistenceSqlError("ManagedAttachment.findClaimedForCommand")));

    const classifyClaimRejection = (
      input: Parameters<ManagedAttachmentRepositoryShape["claimForAcceptedTurn"]>[0],
    ): Effect.Effect<ClaimManagedAttachmentsResult, unknown> =>
      Effect.gen(function* () {
        const rows = yield* sql<ManagedAttachmentBlob>`
          SELECT ${blobColumns(sql)}
          FROM managed_attachment_blobs
          WHERE attachment_id IN ${sql.in(input.attachmentIds)}
        `;
        if (rows.length !== input.attachmentIds.length) {
          return { status: "rejected", reason: "missing" } as const;
        }
        if (
          rows.some(
            (row) =>
              row.ownerThreadId !== input.ownerThreadId ||
              row.ownerKind !== input.ownerKind ||
              row.ownerId !== input.ownerId,
          )
        ) {
          return { status: "rejected", reason: "owner-mismatch" } as const;
        }
        if (
          rows.some(
            (row) =>
              row.state === "staged" &&
              (row.stagingExpiresAt === null || row.stagingExpiresAt <= input.now),
          )
        ) {
          return { status: "rejected", reason: "expired" } as const;
        }
        return { status: "rejected", reason: "already-claimed" } as const;
      });

    const claimForAcceptedTurn: ManagedAttachmentRepositoryShape["claimForAcceptedTurn"] = (
      input,
    ) => {
      if (input.attachmentIds.length === 0) {
        return Effect.succeed({ status: "claimed", attachments: [] });
      }
      if (new Set(input.attachmentIds).size !== input.attachmentIds.length) {
        return Effect.succeed({ status: "rejected", reason: "duplicate-id" });
      }
      return sql<ManagedAttachmentBlob>`
          UPDATE managed_attachment_blobs
          SET state = 'claimed',
              claim_command_id = ${input.commandId},
              claim_message_id = ${input.messageId},
              claimed_at = COALESCE(claimed_at, ${input.now}),
              staging_expires_at = NULL,
              updated_at = ${input.now}
          WHERE attachment_id IN ${sql.in(input.attachmentIds)}
            AND owner_thread_id = ${input.ownerThreadId}
            AND owner_kind = ${input.ownerKind}
            AND owner_id = ${input.ownerId}
            AND (
              (state = 'staged' AND staging_expires_at > ${input.now})
              OR (
                state = 'claimed'
                AND claim_message_id = ${input.messageId}
              )
            )
            AND (
              SELECT COUNT(*)
              FROM managed_attachment_blobs AS eligible
              WHERE eligible.attachment_id IN ${sql.in(input.attachmentIds)}
                AND eligible.owner_thread_id = ${input.ownerThreadId}
                AND eligible.owner_kind = ${input.ownerKind}
                AND eligible.owner_id = ${input.ownerId}
                AND (
                  (eligible.state = 'staged' AND eligible.staging_expires_at > ${input.now})
                  OR (
                    eligible.state = 'claimed'
                    AND eligible.claim_message_id = ${input.messageId}
                  )
                )
            ) = ${input.attachmentIds.length}
          RETURNING ${blobColumns(sql)}
        `.pipe(
        Effect.flatMap((rows) =>
          rows.length === input.attachmentIds.length
            ? Effect.succeed({ status: "claimed" as const, attachments: rows })
            : classifyClaimRejection(input),
        ),
        Effect.mapError(toPersistenceSqlError("ManagedAttachment.claimForAcceptedTurn")),
      );
    };

    const enqueueCleanupRows = (input: {
      readonly attachmentIds: ReadonlyArray<string>;
      readonly reason: string;
      readonly requestedAt: string;
    }) =>
      sql`
        INSERT INTO managed_attachment_cleanup_jobs (
          attachment_id, reason, attempt_count, next_attempt_at,
          lease_owner, lease_expires_at, last_error, created_at, updated_at
        )
        SELECT attachment_id, ${input.reason}, 0, ${input.requestedAt},
               NULL, NULL, NULL, ${input.requestedAt}, ${input.requestedAt}
        FROM managed_attachment_blobs
        WHERE attachment_id IN ${sql.in(input.attachmentIds)}
          AND state = 'deleting'
        ON CONFLICT (attachment_id) DO NOTHING
      `;

    const cancelStaged: ManagedAttachmentRepositoryShape["cancelStaged"] = (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<ManagedAttachmentBlob>`
            SELECT ${blobColumns(sql)}
            FROM managed_attachment_blobs
            WHERE attachment_id = ${input.attachmentId}
              AND owner_kind = ${input.ownerKind}
              AND owner_id = ${input.ownerId}
          `;
            const attachment = rows[0];
            if (!attachment) return { status: "not-found" as const };
            if (attachment.state === "claimed") {
              return { status: "already-claimed" as const };
            }
            if (attachment.state === "deleting" || attachment.state === "deleted") {
              return { status: "cancelled" as const };
            }
            const updated = yield* sql<{ readonly attachmentId: string }>`
            UPDATE managed_attachment_blobs
            SET state = 'deleting',
                delete_reason = ${input.reason},
                delete_requested_at = ${input.requestedAt},
                updated_at = ${input.requestedAt}
            WHERE attachment_id = ${input.attachmentId}
              AND owner_kind = ${input.ownerKind}
              AND owner_id = ${input.ownerId}
              AND state IN ('uploading', 'staged')
            RETURNING attachment_id AS "attachmentId"
          `;
            if (updated.length === 0) return { status: "not-found" as const };
            yield* enqueueCleanupRows({
              attachmentIds: [input.attachmentId],
              reason: input.reason,
              requestedAt: input.requestedAt,
            });
            return { status: "cancelled" as const };
          }),
        )
        .pipe(Effect.mapError(toPersistenceSqlError("ManagedAttachment.cancelStaged")));

    const markCleanupByIds: ManagedAttachmentRepositoryShape["markCleanupByIds"] = (input) => {
      if (input.attachmentIds.length === 0) return Effect.succeed([]);
      const uniqueIds = [...new Set(input.attachmentIds)];
      return Effect.gen(function* () {
        const rows = yield* sql<{ readonly attachmentId: string }>`
          UPDATE managed_attachment_blobs
          SET state = 'deleting',
              delete_reason = COALESCE(delete_reason, ${input.reason}),
              delete_requested_at = COALESCE(delete_requested_at, ${input.requestedAt}),
              updated_at = ${input.requestedAt}
          WHERE attachment_id IN ${sql.in(uniqueIds)}
            AND owner_thread_id = ${input.ownerThreadId}
            AND state <> 'deleted'
          RETURNING attachment_id AS "attachmentId"
        `;
        const attachmentIds = rows.map((row) => row.attachmentId);
        if (attachmentIds.length > 0) {
          yield* enqueueCleanupRows({ ...input, attachmentIds });
        }
        return attachmentIds;
      }).pipe(Effect.mapError(toPersistenceSqlError("ManagedAttachment.markCleanupByIds")));
    };

    const markCleanupByThread: ManagedAttachmentRepositoryShape["markCleanupByThread"] = (input) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly attachmentId: string }>`
          UPDATE managed_attachment_blobs
          SET state = 'deleting',
              delete_reason = COALESCE(delete_reason, ${input.reason}),
              delete_requested_at = COALESCE(delete_requested_at, ${input.requestedAt}),
              updated_at = ${input.requestedAt}
          WHERE owner_thread_id = ${input.ownerThreadId}
            AND state <> 'deleted'
          RETURNING attachment_id AS "attachmentId"
        `;
        const attachmentIds = rows.map((row) => row.attachmentId);
        if (attachmentIds.length > 0) {
          yield* enqueueCleanupRows({ ...input, attachmentIds });
        }
        return attachmentIds;
      }).pipe(Effect.mapError(toPersistenceSqlError("ManagedAttachment.markCleanupByThread")));

    const markUnreferencedClaimedForCleanup: ManagedAttachmentRepositoryShape["markUnreferencedClaimedForCleanup"] =
      (input) => {
        const retainedAttachmentIds = [...new Set(input.retainedAttachmentIds)];
        return Effect.gen(function* () {
          const rows =
            retainedAttachmentIds.length === 0
              ? yield* sql<{ readonly attachmentId: string }>`
                UPDATE managed_attachment_blobs
                SET state = 'deleting',
                    delete_reason = COALESCE(delete_reason, ${input.reason}),
                    delete_requested_at = COALESCE(delete_requested_at, ${input.requestedAt}),
                    updated_at = ${input.requestedAt}
                WHERE owner_thread_id = ${input.ownerThreadId}
                  AND state = 'claimed'
                RETURNING attachment_id AS "attachmentId"
              `
              : yield* sql<{ readonly attachmentId: string }>`
                UPDATE managed_attachment_blobs
                SET state = 'deleting',
                    delete_reason = COALESCE(delete_reason, ${input.reason}),
                    delete_requested_at = COALESCE(delete_requested_at, ${input.requestedAt}),
                    updated_at = ${input.requestedAt}
                WHERE owner_thread_id = ${input.ownerThreadId}
                  AND state = 'claimed'
                  AND attachment_id NOT IN ${sql.in(retainedAttachmentIds)}
                RETURNING attachment_id AS "attachmentId"
              `;
          const attachmentIds = rows.map((row) => row.attachmentId);
          if (attachmentIds.length > 0) {
            yield* enqueueCleanupRows({ ...input, attachmentIds });
          }
          return attachmentIds;
        }).pipe(
          Effect.mapError(
            toPersistenceSqlError("ManagedAttachment.markUnreferencedClaimedForCleanup"),
          ),
        );
      };

    const markExpiredForCleanup: ManagedAttachmentRepositoryShape["markExpiredForCleanup"] = (
      input,
    ) => {
      if (input.limit <= 0) return Effect.succeed([]);
      return sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly attachmentId: string }>`
              UPDATE managed_attachment_blobs
              SET state = 'deleting',
                  delete_reason = 'staging-expired',
                  delete_requested_at = ${input.now},
                  updated_at = ${input.now}
              WHERE attachment_id IN (
                SELECT attachment_id
                FROM managed_attachment_blobs
                WHERE (state = 'staged' AND staging_expires_at <= ${input.now})
                   OR (state = 'uploading' AND updated_at <= ${input.uploadingCutoff})
                ORDER BY updated_at ASC, attachment_id ASC
                LIMIT ${Math.floor(input.limit)}
              )
              RETURNING attachment_id AS "attachmentId"
            `;
            const attachmentIds = rows.map((row) => row.attachmentId);
            if (attachmentIds.length > 0) {
              yield* enqueueCleanupRows({
                attachmentIds,
                reason: "staging-expired",
                requestedAt: input.now,
              });
            }
            return attachmentIds;
          }),
        )
        .pipe(Effect.mapError(toPersistenceSqlError("ManagedAttachment.markExpiredForCleanup")));
    };

    const leaseCleanup: ManagedAttachmentRepositoryShape["leaseCleanup"] = (input) => {
      if (input.limit <= 0) return Effect.succeed([]);
      return sql<ManagedAttachmentCleanupJob>`
        UPDATE managed_attachment_cleanup_jobs
        SET lease_owner = ${input.leaseOwner},
            lease_expires_at = ${input.leaseExpiresAt},
            updated_at = ${input.now}
        WHERE attachment_id IN (
          SELECT jobs.attachment_id
          FROM managed_attachment_cleanup_jobs AS jobs
          INNER JOIN managed_attachment_blobs AS blobs
            ON blobs.attachment_id = jobs.attachment_id
          WHERE blobs.state = 'deleting'
            AND jobs.attempt_count < ${MANAGED_ATTACHMENT_CLEANUP_MAX_ATTEMPTS}
            AND jobs.next_attempt_at <= ${input.now}
            AND (jobs.lease_owner IS NULL OR jobs.lease_expires_at <= ${input.now})
          ORDER BY jobs.next_attempt_at ASC, jobs.created_at ASC, jobs.attachment_id ASC
          LIMIT ${Math.floor(input.limit)}
        )
        RETURNING
          attachment_id AS "attachmentId",
          (SELECT relative_path FROM managed_attachment_blobs
           WHERE managed_attachment_blobs.attachment_id = managed_attachment_cleanup_jobs.attachment_id)
            AS "relativePath",
          reason,
          attempt_count AS "attemptCount",
          next_attempt_at AS "nextAttemptAt",
          lease_owner AS "leaseOwner",
          lease_expires_at AS "leaseExpiresAt",
          last_error AS "lastError",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `.pipe(Effect.mapError(toPersistenceSqlError("ManagedAttachment.leaseCleanup")));
    };

    const listFailedCleanup: ManagedAttachmentRepositoryShape["listFailedCleanup"] = (input) => {
      if (input.limit <= 0) return Effect.succeed([]);
      return sql<ManagedAttachmentCleanupJob>`
        SELECT
          jobs.attachment_id AS "attachmentId",
          blobs.relative_path AS "relativePath",
          jobs.reason,
          jobs.attempt_count AS "attemptCount",
          jobs.next_attempt_at AS "nextAttemptAt",
          jobs.lease_owner AS "leaseOwner",
          jobs.lease_expires_at AS "leaseExpiresAt",
          jobs.last_error AS "lastError",
          jobs.created_at AS "createdAt",
          jobs.updated_at AS "updatedAt"
        FROM managed_attachment_cleanup_jobs AS jobs
        INNER JOIN managed_attachment_blobs AS blobs
          ON blobs.attachment_id = jobs.attachment_id
        WHERE blobs.state = 'deleting'
          AND jobs.attempt_count >= ${MANAGED_ATTACHMENT_CLEANUP_MAX_ATTEMPTS}
        ORDER BY jobs.updated_at DESC, jobs.attachment_id ASC
        LIMIT ${Math.floor(input.limit)}
      `.pipe(Effect.mapError(toPersistenceSqlError("ManagedAttachment.listFailedCleanup")));
    };

    const compactDeleted: ManagedAttachmentRepositoryShape["compactDeleted"] = (input) => {
      if (input.limit <= 0) return Effect.succeed([]);
      return sql<{ readonly attachmentId: string }>`
        DELETE FROM managed_attachment_blobs
        WHERE attachment_id IN (
          SELECT blobs.attachment_id
          FROM managed_attachment_blobs AS blobs
          LEFT JOIN managed_attachment_cleanup_jobs AS jobs
            ON jobs.attachment_id = blobs.attachment_id
          WHERE blobs.state = 'deleted'
            AND blobs.deleted_at <= ${input.deletedBefore}
            AND jobs.attachment_id IS NULL
          ORDER BY blobs.deleted_at ASC, blobs.attachment_id ASC
          LIMIT ${Math.floor(input.limit)}
        )
        RETURNING attachment_id AS "attachmentId"
      `.pipe(
        Effect.map((rows) => rows.map((row) => row.attachmentId)),
        Effect.mapError(toPersistenceSqlError("ManagedAttachment.compactDeleted")),
      );
    };

    const retryCleanup: ManagedAttachmentRepositoryShape["retryCleanup"] = (input) =>
      sql<{ readonly attachmentId: string }>`
        UPDATE managed_attachment_cleanup_jobs
        SET attempt_count = attempt_count + 1,
            next_attempt_at = ${input.nextAttemptAt},
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = ${input.error},
            updated_at = ${input.updatedAt}
        WHERE attachment_id = ${input.attachmentId}
          AND lease_owner = ${input.expectedLeaseOwner}
        RETURNING attachment_id AS "attachmentId"
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(toPersistenceSqlError("ManagedAttachment.retryCleanup")),
      );

    const completeCleanup: ManagedAttachmentRepositoryShape["completeCleanup"] = (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const completed = yield* sql<{ readonly attachmentId: string }>`
            UPDATE managed_attachment_blobs
            SET state = 'deleted',
                deleted_at = ${input.completedAt},
                updated_at = ${input.completedAt}
            WHERE attachment_id = ${input.attachmentId}
              AND state = 'deleting'
              AND EXISTS (
                SELECT 1
                FROM managed_attachment_cleanup_jobs
                WHERE attachment_id = ${input.attachmentId}
                  AND lease_owner = ${input.expectedLeaseOwner}
              )
            RETURNING attachment_id AS "attachmentId"
          `;
            if (completed.length === 0) return false;
            yield* sql`
            DELETE FROM managed_attachment_cleanup_jobs
            WHERE attachment_id = ${input.attachmentId}
              AND lease_owner = ${input.expectedLeaseOwner}
          `;
            return true;
          }),
        )
        .pipe(Effect.mapError(toPersistenceSqlError("ManagedAttachment.completeCleanup")));

    const getUsage: ManagedAttachmentRepositoryShape["getUsage"] = (input) =>
      sql<ManagedAttachmentUsage>`
        SELECT
          COALESCE(SUM(CASE WHEN state <> 'deleted' THEN
            CASE WHEN state = 'uploading' THEN reserved_bytes
                 ELSE COALESCE(size_bytes, reserved_bytes) END
          ELSE 0 END), 0) AS "homeBytes",
          SUM(CASE WHEN state <> 'deleted' THEN 1 ELSE 0 END) AS "homeCount",
          COALESCE(SUM(CASE
            WHEN owner_kind = ${input.ownerKind}
             AND owner_id = ${input.ownerId}
             AND state IN ('uploading', 'staged')
            THEN CASE WHEN state = 'uploading' THEN reserved_bytes
                      ELSE COALESCE(size_bytes, reserved_bytes) END
            ELSE 0 END), 0) AS "principalStagingBytes",
          SUM(CASE
            WHEN owner_kind = ${input.ownerKind}
             AND owner_id = ${input.ownerId}
             AND state IN ('uploading', 'staged')
            THEN 1 ELSE 0 END) AS "principalStagingCount"
        FROM managed_attachment_blobs
      `.pipe(
        Effect.map(
          (rows) =>
            rows[0] ?? {
              homeBytes: 0,
              homeCount: 0,
              principalStagingBytes: 0,
              principalStagingCount: 0,
            },
        ),
        Effect.mapError(toPersistenceSqlError("ManagedAttachment.getUsage")),
      );

    return {
      reserve,
      finalizeStaged,
      findServerOwned,
      findClaimedById,
      findClaimedForCommand,
      cancelStaged,
      claimForAcceptedTurn,
      markCleanupByIds,
      markCleanupByThread,
      markUnreferencedClaimedForCleanup,
      markExpiredForCleanup,
      leaseCleanup,
      listFailedCleanup,
      compactDeleted,
      retryCleanup,
      completeCleanup,
      getUsage,
    } satisfies ManagedAttachmentRepositoryShape;
  });

export const makeManagedAttachmentRepositoryLive = (
  limits: ManagedAttachmentLimits = DEFAULT_MANAGED_ATTACHMENT_LIMITS,
) => Layer.effect(ManagedAttachmentRepository, makeRepository(limits));

export const ManagedAttachmentRepositoryLive = makeManagedAttachmentRepositoryLive();
