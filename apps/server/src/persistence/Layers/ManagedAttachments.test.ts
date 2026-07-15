import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  MANAGED_ATTACHMENT_CLEANUP_MAX_ATTEMPTS,
  ManagedAttachmentRepository,
  type ManagedAttachmentRepositoryShape,
} from "../Services/ManagedAttachments.ts";
import { makeManagedAttachmentRepositoryLive } from "./ManagedAttachments.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { runManagedAttachmentCleanupBatch } from "../../managedAttachmentCleanup.ts";
import {
  persistReservedManagedAttachment,
  reserveManagedAttachmentUpload,
} from "../../managedAttachmentStore.ts";
import { attachmentPrincipalForSession } from "../../managedAttachmentPrincipal.ts";

const limits = {
  homeBytes: 10,
  homeCount: 100,
  principalStagingBytes: 10,
  principalStagingCount: 10,
};

const layer = it.layer(
  Layer.mergeAll(
    makeManagedAttachmentRepositoryLive(limits).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const resetSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM managed_attachment_cleanup_jobs`;
  yield* sql`DELETE FROM managed_attachment_blobs`;
});

const reserveInput = (
  overrides: Partial<{
    attachmentId: string;
    ownerThreadId: string;
    ownerKind: string;
    ownerId: string;
    reservedBytes: number;
    relativePath: string;
  }> = {},
) => ({
  attachmentId: overrides.attachmentId ?? "attachment-1",
  ownerThreadId: overrides.ownerThreadId ?? "thread-1",
  ownerKind: overrides.ownerKind ?? "principal",
  ownerId: overrides.ownerId ?? "principal-1",
  kind: "file",
  originalName: "report.txt",
  mimeType: "text/plain",
  reservedBytes: overrides.reservedBytes ?? 4,
  relativePath: overrides.relativePath ?? "attachments/attachment-1.txt",
  now: "2026-07-14T10:00:00.000Z",
});

const reserveAndStage = (
  repository: ManagedAttachmentRepositoryShape,
  overrides: Parameters<typeof reserveInput>[0] = {},
  stagingExpiresAt = "2026-07-14T11:00:00.000Z",
) =>
  Effect.gen(function* () {
    const input = reserveInput(overrides);
    const reserved = yield* repository.reserve(input);
    assert.strictEqual(reserved.status, "reserved");
    const staged = yield* repository.finalizeStaged({
      attachmentId: input.attachmentId,
      ownerThreadId: input.ownerThreadId,
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      sizeBytes: input.reservedBytes,
      sha256: "a".repeat(64),
      stagingExpiresAt,
      now: "2026-07-14T10:00:01.000Z",
    });
    assert.strictEqual(staged.status, "staged");
    return input;
  });

layer("ManagedAttachmentRepository", (it) => {
  it.effect("uses exact IDs and owners even when legacy-safe thread segments collide", () =>
    Effect.gen(function* () {
      yield* resetSchema;
      const repository = yield* ManagedAttachmentRepository;
      yield* reserveAndStage(repository, {
        attachmentId: "opaque-a",
        ownerThreadId: "Thread Delete.Files",
        relativePath: "attachments/opaque-a.txt",
      });
      yield* reserveAndStage(repository, {
        attachmentId: "opaque-b",
        ownerThreadId: "thread-delete-files",
        relativePath: "attachments/opaque-b.txt",
      });

      const crossOwner = yield* repository.findServerOwned({
        attachmentId: "opaque-a",
        ownerThreadId: "thread-delete-files",
        ownerKind: "principal",
        ownerId: "principal-1",
        now: "2026-07-14T10:01:00.000Z",
      });
      const exact = yield* repository.findServerOwned({
        attachmentId: "opaque-a",
        ownerThreadId: "Thread Delete.Files",
        ownerKind: "principal",
        ownerId: "principal-1",
        now: "2026-07-14T10:01:00.000Z",
      });

      assert.isTrue(Option.isNone(crossOwner));
      assert.strictEqual(Option.getOrNull(exact)?.attachmentId, "opaque-a");
    }),
  );

  it.effect("admits concurrent reservations without exceeding aggregate quota", () =>
    Effect.gen(function* () {
      yield* resetSchema;
      const repository = yield* ManagedAttachmentRepository;
      const results = yield* Effect.all(
        [
          repository.reserve(
            reserveInput({
              attachmentId: "quota-a",
              relativePath: "attachments/quota-a",
              reservedBytes: 6,
            }),
          ),
          repository.reserve(
            reserveInput({
              attachmentId: "quota-b",
              relativePath: "attachments/quota-b",
              reservedBytes: 6,
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const usage = yield* repository.getUsage({ ownerKind: "principal", ownerId: "principal-1" });

      assert.strictEqual(results.filter((result) => result.status === "reserved").length, 1);
      assert.strictEqual(results.filter((result) => result.status === "quota-exceeded").length, 1);
      assert.strictEqual(usage.homeBytes, 6);
      assert.strictEqual(usage.principalStagingCount, 1);
    }),
  );

  it.effect(
    "never partially claims a mixed invalid set and rolls claims back with an outer transaction",
    () =>
      Effect.gen(function* () {
        yield* resetSchema;
        const repository = yield* ManagedAttachmentRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* reserveAndStage(repository, {
          attachmentId: "claim-a",
          relativePath: "attachments/claim-a",
        });
        yield* reserveAndStage(repository, {
          attachmentId: "claim-b",
          ownerId: "principal-2",
          relativePath: "attachments/claim-b",
        });

        const mixed = yield* repository.claimForAcceptedTurn({
          attachmentIds: ["claim-a", "claim-b"],
          ownerThreadId: "thread-1",
          ownerKind: "principal",
          ownerId: "principal-1",
          commandId: "command-1",
          messageId: "message-1",
          now: "2026-07-14T10:02:00.000Z",
        });
        assert.deepStrictEqual(mixed, { status: "rejected", reason: "owner-mismatch" });

        const statesAfterMixed = yield* sql<{ readonly state: string }>`
        SELECT state FROM managed_attachment_blobs WHERE attachment_id = 'claim-a'
      `;
        assert.strictEqual(statesAfterMixed[0]?.state, "staged");

        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const claimed = yield* repository.claimForAcceptedTurn({
                attachmentIds: ["claim-a"],
                ownerThreadId: "thread-1",
                ownerKind: "principal",
                ownerId: "principal-1",
                commandId: "command-rollback",
                messageId: "message-rollback",
                now: "2026-07-14T10:03:00.000Z",
              });
              assert.strictEqual(claimed.status, "claimed");
              return yield* Effect.fail("force rollback");
            }),
          )
          .pipe(Effect.catchCause(() => Effect.void));

        const statesAfterRollback = yield* sql<{ readonly state: string }>`
        SELECT state FROM managed_attachment_blobs WHERE attachment_id = 'claim-a'
      `;
        assert.strictEqual(statesAfterRollback[0]?.state, "staged");
      }),
  );

  it.effect("makes same-message claims idempotent and rejects mismatched reuse", () =>
    Effect.gen(function* () {
      yield* resetSchema;
      const repository = yield* ManagedAttachmentRepository;
      yield* reserveAndStage(repository, {
        attachmentId: "idem",
        relativePath: "attachments/idem",
      });
      const claim = {
        attachmentIds: ["idem"],
        ownerThreadId: "thread-1",
        ownerKind: "principal",
        ownerId: "principal-1",
        commandId: "command-idem",
        messageId: "message-idem",
        now: "2026-07-14T10:02:00.000Z",
      } as const;

      assert.strictEqual((yield* repository.claimForAcceptedTurn(claim)).status, "claimed");
      assert.strictEqual((yield* repository.claimForAcceptedTurn(claim)).status, "claimed");
      assert.strictEqual(
        (yield* repository.claimForAcceptedTurn({
          ...claim,
          commandId: "different-command",
        })).status,
        "claimed",
      );
      assert.deepStrictEqual(
        yield* repository.claimForAcceptedTurn({ ...claim, messageId: "different-message" }),
        { status: "rejected", reason: "already-claimed" },
      );
    }),
  );

  it.effect("rejects expired staged attachments", () =>
    Effect.gen(function* () {
      yield* resetSchema;
      const repository = yield* ManagedAttachmentRepository;
      yield* reserveAndStage(
        repository,
        { attachmentId: "expired", relativePath: "attachments/expired" },
        "2026-07-14T10:00:02.000Z",
      );

      const result = yield* repository.claimForAcceptedTurn({
        attachmentIds: ["expired"],
        ownerThreadId: "thread-1",
        ownerKind: "principal",
        ownerId: "principal-1",
        commandId: "command-expired",
        messageId: "message-expired",
        now: "2026-07-14T10:00:03.000Z",
      });
      assert.deepStrictEqual(result, { status: "rejected", reason: "expired" });
    }),
  );

  it.effect("moves expired staged and abandoned uploading rows into durable cleanup", () =>
    Effect.gen(function* () {
      yield* resetSchema;
      const repository = yield* ManagedAttachmentRepository;
      yield* reserveAndStage(
        repository,
        { attachmentId: "expired-stage", relativePath: "attachments/expired-stage" },
        "2026-07-14T10:00:02.000Z",
      );
      yield* repository.reserve(
        reserveInput({
          attachmentId: "abandoned-upload",
          relativePath: "attachments/abandoned-upload",
        }),
      );
      yield* repository.reserve(
        reserveInput({
          attachmentId: "fresh-upload",
          relativePath: "attachments/fresh-upload",
          reservedBytes: 2,
        }),
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE managed_attachment_blobs
        SET updated_at = '2026-07-14T09:00:00.000Z'
        WHERE attachment_id = 'abandoned-upload'
      `;

      const expired = yield* repository.markExpiredForCleanup({
        now: "2026-07-14T10:10:00.000Z",
        uploadingCutoff: "2026-07-14T09:30:00.000Z",
        limit: 2,
      });
      assert.deepStrictEqual(new Set(expired), new Set(["expired-stage", "abandoned-upload"]));

      const leased = yield* repository.leaseCleanup({
        leaseOwner: "gc-worker",
        now: "2026-07-14T10:10:00.000Z",
        leaseExpiresAt: "2026-07-14T10:11:00.000Z",
        limit: 10,
      });
      assert.deepStrictEqual(
        new Set(leased.map((job) => job.attachmentId)),
        new Set(["expired-stage", "abandoned-upload"]),
      );
      const fresh = yield* repository.findServerOwned({
        attachmentId: "fresh-upload",
        ownerThreadId: "thread-1",
        ownerKind: "principal",
        ownerId: "principal-1",
        now: "2026-07-14T10:10:00.000Z",
      });
      assert.isTrue(Option.isNone(fresh));
      const freshRows = yield* sql<{ readonly state: string }>`
        SELECT state FROM managed_attachment_blobs WHERE attachment_id = 'fresh-upload'
      `;
      assert.strictEqual(freshRows[0]?.state, "uploading");
    }),
  );

  it.effect("cancels only the exact owner and treats claimed attachments as committed", () =>
    Effect.gen(function* () {
      yield* resetSchema;
      const repository = yield* ManagedAttachmentRepository;
      yield* reserveAndStage(repository, {
        attachmentId: "cancel",
        relativePath: "attachments/cancel",
      });

      assert.deepStrictEqual(
        yield* repository.cancelStaged({
          attachmentId: "cancel",
          ownerKind: "principal",
          ownerId: "wrong-principal",
          reason: "upload-cancelled",
          requestedAt: "2026-07-14T10:03:00.000Z",
        }),
        { status: "not-found" },
      );
      assert.deepStrictEqual(
        yield* repository.cancelStaged({
          attachmentId: "cancel",
          ownerKind: "principal",
          ownerId: "principal-1",
          reason: "upload-cancelled",
          requestedAt: "2026-07-14T10:03:00.000Z",
        }),
        { status: "cancelled" },
      );
      assert.deepStrictEqual(
        yield* repository.cancelStaged({
          attachmentId: "cancel",
          ownerKind: "principal",
          ownerId: "principal-1",
          reason: "upload-cancelled",
          requestedAt: "2026-07-14T10:03:01.000Z",
        }),
        { status: "cancelled" },
      );

      yield* reserveAndStage(repository, {
        attachmentId: "committed",
        relativePath: "attachments/committed",
      });
      yield* repository.claimForAcceptedTurn({
        attachmentIds: ["committed"],
        ownerThreadId: "thread-1",
        ownerKind: "principal",
        ownerId: "principal-1",
        commandId: "command-committed",
        messageId: "message-committed",
        now: "2026-07-14T10:04:00.000Z",
      });
      assert.deepStrictEqual(
        yield* repository.cancelStaged({
          attachmentId: "committed",
          ownerKind: "principal",
          ownerId: "principal-1",
          reason: "too-late",
          requestedAt: "2026-07-14T10:04:01.000Z",
        }),
        { status: "already-claimed" },
      );
    }),
  );

  it.effect("retries cleanup leases and completes ENOENT as durable success", () =>
    Effect.gen(function* () {
      yield* resetSchema;
      const repository = yield* ManagedAttachmentRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* reserveAndStage(repository, {
        attachmentId: "cleanup",
        relativePath: "attachments/cleanup",
      });
      yield* reserveAndStage(repository, {
        attachmentId: "cleanup-other",
        ownerThreadId: "thread-2",
        relativePath: "attachments/cleanup-other",
      });
      const marked = yield* sql.withTransaction(
        repository.markCleanupByIds({
          attachmentIds: ["cleanup", "cleanup-other"],
          ownerThreadId: "thread-1",
          reason: "message-removed",
          requestedAt: "2026-07-14T10:05:00.000Z",
        }),
      );
      assert.deepStrictEqual(marked, ["cleanup"]);
      assert.isTrue(
        Option.isSome(
          yield* repository.findServerOwned({
            attachmentId: "cleanup-other",
            ownerThreadId: "thread-2",
            ownerKind: "principal",
            ownerId: "principal-1",
            now: "2026-07-14T10:05:00.000Z",
          }),
        ),
      );

      const firstLease = yield* repository.leaseCleanup({
        leaseOwner: "worker-1",
        now: "2026-07-14T10:05:00.000Z",
        leaseExpiresAt: "2026-07-14T10:06:00.000Z",
        limit: 10,
      });
      assert.strictEqual(firstLease[0]?.attachmentId, "cleanup");
      assert.isTrue(
        yield* repository.retryCleanup({
          attachmentId: "cleanup",
          expectedLeaseOwner: "worker-1",
          error: "EBUSY",
          nextAttemptAt: "2026-07-14T10:07:00.000Z",
          updatedAt: "2026-07-14T10:05:01.000Z",
        }),
      );
      assert.deepStrictEqual(
        yield* repository.leaseCleanup({
          leaseOwner: "worker-2",
          now: "2026-07-14T10:06:30.000Z",
          leaseExpiresAt: "2026-07-14T10:08:00.000Z",
          limit: 10,
        }),
        [],
      );
      const retried = yield* repository.leaseCleanup({
        leaseOwner: "worker-2",
        now: "2026-07-14T10:07:00.000Z",
        leaseExpiresAt: "2026-07-14T10:08:00.000Z",
        limit: 10,
      });
      assert.strictEqual(retried[0]?.attemptCount, 1);
      assert.strictEqual(retried[0]?.lastError, "EBUSY");

      assert.isTrue(
        yield* repository.completeCleanup({
          attachmentId: "cleanup",
          expectedLeaseOwner: "worker-2",
          disposition: "already-missing",
          completedAt: "2026-07-14T10:07:01.000Z",
        }),
      );
      const rows = yield* sql<{ readonly state: string; readonly deletedAt: string | null }>`
        SELECT state, deleted_at AS "deletedAt"
        FROM managed_attachment_blobs
        WHERE attachment_id = 'cleanup'
      `;
      const jobs = yield* sql`SELECT * FROM managed_attachment_cleanup_jobs`;
      assert.deepStrictEqual(rows[0], {
        state: "deleted",
        deletedAt: "2026-07-14T10:07:01.000Z",
      });
      assert.strictEqual(jobs.length, 0);
    }),
  );

  it.effect("stops leasing cleanup at the durable retry ceiling and exposes the failure", () =>
    Effect.gen(function* () {
      yield* resetSchema;
      const repository = yield* ManagedAttachmentRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* reserveAndStage(repository, {
        attachmentId: "poisoned-cleanup",
        relativePath: "attachments/poisoned-cleanup",
      });
      yield* sql.withTransaction(
        repository.markCleanupByIds({
          attachmentIds: ["poisoned-cleanup"],
          ownerThreadId: "thread-1",
          reason: "message-removed",
          requestedAt: "2026-07-14T10:05:00.000Z",
        }),
      );
      yield* sql`
        UPDATE managed_attachment_cleanup_jobs
        SET attempt_count = ${MANAGED_ATTACHMENT_CLEANUP_MAX_ATTEMPTS - 1}
        WHERE attachment_id = 'poisoned-cleanup'
      `;

      const leased = yield* repository.leaseCleanup({
        leaseOwner: "poison-worker",
        now: "2026-07-14T10:05:00.000Z",
        leaseExpiresAt: "2026-07-14T10:06:00.000Z",
        limit: 1,
      });
      assert.strictEqual(leased[0]?.attemptCount, MANAGED_ATTACHMENT_CLEANUP_MAX_ATTEMPTS - 1);
      assert.isTrue(
        yield* repository.retryCleanup({
          attachmentId: "poisoned-cleanup",
          expectedLeaseOwner: "poison-worker",
          error: "EPERM",
          nextAttemptAt: "2026-07-14T10:06:00.000Z",
          updatedAt: "2026-07-14T10:05:01.000Z",
        }),
      );

      assert.deepStrictEqual(
        yield* repository.leaseCleanup({
          leaseOwner: "should-not-run",
          now: "2026-07-14T10:07:00.000Z",
          leaseExpiresAt: "2026-07-14T10:08:00.000Z",
          limit: 1,
        }),
        [],
      );
      const failed = yield* repository.listFailedCleanup({ limit: 10 });
      assert.strictEqual(failed.length, 1);
      assert.strictEqual(failed[0]?.attachmentId, "poisoned-cleanup");
      assert.strictEqual(failed[0]?.attemptCount, MANAGED_ATTACHMENT_CLEANUP_MAX_ATTEMPTS);
      assert.strictEqual(failed[0]?.lastError, "EPERM");
    }),
  );

  it.effect("compacts only expired completed tombstones without changing live quota", () =>
    Effect.gen(function* () {
      yield* resetSchema;
      const repository = yield* ManagedAttachmentRepository;
      const sql = yield* SqlClient.SqlClient;
      for (const attachmentId of ["old-deleted", "recent-deleted", "poison-retained"]) {
        yield* reserveAndStage(repository, {
          attachmentId,
          reservedBytes: 2,
          relativePath: `attachments/${attachmentId}`,
        });
      }
      yield* sql.withTransaction(
        repository.markCleanupByIds({
          attachmentIds: ["old-deleted", "recent-deleted", "poison-retained"],
          ownerThreadId: "thread-1",
          reason: "retention-test",
          requestedAt: "2020-01-01T00:00:00.000Z",
        }),
      );
      const leased = yield* repository.leaseCleanup({
        leaseOwner: "retention-worker",
        now: "2020-01-01T00:00:00.000Z",
        leaseExpiresAt: "2020-01-01T00:01:00.000Z",
        limit: 10,
      });
      assert.strictEqual(leased.length, 3);
      assert.isTrue(
        yield* repository.completeCleanup({
          attachmentId: "old-deleted",
          expectedLeaseOwner: "retention-worker",
          disposition: "deleted",
          completedAt: "2020-01-01T00:00:01.000Z",
        }),
      );
      assert.isTrue(
        yield* repository.completeCleanup({
          attachmentId: "recent-deleted",
          expectedLeaseOwner: "retention-worker",
          disposition: "deleted",
          completedAt: "2026-07-14T10:00:00.000Z",
        }),
      );
      yield* sql`
        UPDATE managed_attachment_cleanup_jobs
        SET attempt_count = ${MANAGED_ATTACHMENT_CLEANUP_MAX_ATTEMPTS},
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = 'EPERM'
        WHERE attachment_id = 'poison-retained'
      `;

      const usageBefore = yield* repository.getUsage({
        ownerKind: "principal",
        ownerId: "principal-1",
      });
      const compacted = yield* repository.compactDeleted({
        deletedBefore: "2025-01-01T00:00:00.000Z",
        limit: 10,
      });
      const usageAfter = yield* repository.getUsage({
        ownerKind: "principal",
        ownerId: "principal-1",
      });
      assert.deepStrictEqual(compacted, ["old-deleted"]);
      assert.deepStrictEqual(usageAfter, usageBefore);

      const remaining = yield* sql<{ readonly attachmentId: string; readonly state: string }>`
        SELECT attachment_id AS "attachmentId", state
        FROM managed_attachment_blobs
        ORDER BY attachment_id ASC
      `;
      assert.deepStrictEqual(remaining, [
        { attachmentId: "poison-retained", state: "deleting" },
        { attachmentId: "recent-deleted", state: "deleted" },
      ]);
      assert.strictEqual((yield* repository.listFailedCleanup({ limit: 10 })).length, 1);
    }),
  );

  it.effect("prunes only claimed blobs absent from the exact retained set for one thread", () =>
    Effect.gen(function* () {
      yield* resetSchema;
      const repository = yield* ManagedAttachmentRepository;
      const sql = yield* SqlClient.SqlClient;
      for (const [attachmentId, ownerThreadId, commandId] of [
        ["retained", "thread-1", "command-retained"],
        ["removed", "thread-1", "command-removed"],
        ["other-thread", "thread-2", "command-other-thread"],
      ] as const) {
        yield* reserveAndStage(repository, {
          attachmentId,
          ownerThreadId,
          reservedBytes: 2,
          relativePath: `attachments/${attachmentId}`,
        });
        const claim = yield* repository.claimForAcceptedTurn({
          attachmentIds: [attachmentId],
          ownerThreadId,
          ownerKind: "principal",
          ownerId: "principal-1",
          commandId,
          messageId: `message-${attachmentId}`,
          now: "2026-07-14T10:04:00.000Z",
        });
        assert.strictEqual(claim.status, "claimed");
      }

      const marked = yield* sql.withTransaction(
        repository.markUnreferencedClaimedForCleanup({
          ownerThreadId: "thread-1",
          retainedAttachmentIds: ["retained"],
          reason: "conversation-rolled-back",
          requestedAt: "2026-07-14T10:05:00.000Z",
        }),
      );
      assert.deepStrictEqual(marked, ["removed"]);

      const rows = yield* sql<{ readonly attachmentId: string; readonly state: string }>`
        SELECT attachment_id AS "attachmentId", state
        FROM managed_attachment_blobs
        ORDER BY attachment_id ASC
      `;
      assert.deepStrictEqual(rows, [
        { attachmentId: "other-thread", state: "claimed" },
        { attachmentId: "removed", state: "deleting" },
        { attachmentId: "retained", state: "claimed" },
      ]);
    }),
  );

  it.effect("converges file-backed crash windows without deleting claimed bytes", () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-managed-process-loss-"));
    return Effect.gen(function* () {
      yield* resetSchema;
      const repository = yield* ManagedAttachmentRepository;
      const sql = yield* SqlClient.SqlClient;
      const principal = attachmentPrincipalForSession("process-loss-session");
      const threadId = "process-loss-thread";
      const committedAt = new Date().toISOString();

      const committedReservation = yield* reserveManagedAttachmentUpload({
        type: "file",
        threadId,
        name: "committed.txt",
        mimeType: "text/plain",
        reservedBytes: 4,
        now: committedAt,
        principal,
        repository,
      });
      yield* persistReservedManagedAttachment({
        reservation: committedReservation,
        bytes: Uint8Array.from([1, 2, 3, 4]),
        attachmentsDir,
        now: committedAt,
        principal,
        repository,
      });
      const claimed = yield* repository.claimForAcceptedTurn({
        attachmentIds: [committedReservation.attachmentId],
        ownerThreadId: threadId,
        ownerKind: principal.ownerKind,
        ownerId: principal.ownerId,
        commandId: "process-loss-command",
        messageId: "process-loss-message",
        now: committedAt,
      });
      assert.strictEqual(claimed.status, "claimed");

      const staleAt = "2020-01-01T00:00:00.000Z";
      const preRenameId = "att_v2_11111111111111111111111111111111";
      const postRenameId = "att_v2_22222222222222222222222222222222";
      const preRenameRelativePath = `objects/11/${preRenameId}.bin`;
      const postRenameRelativePath = `objects/22/${postRenameId}.bin`;
      for (const [attachmentId, relativePath] of [
        [preRenameId, preRenameRelativePath],
        [postRenameId, postRenameRelativePath],
      ] as const) {
        const reserved = yield* repository.reserve({
          attachmentId,
          ownerThreadId: threadId,
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
          kind: "file",
          originalName: `${attachmentId}.bin`,
          mimeType: "application/octet-stream",
          reservedBytes: 2,
          relativePath,
          now: staleAt,
        });
        assert.strictEqual(reserved.status, "reserved");
      }

      yield* Effect.sync(() => {
        const stagingPath = path.join(attachmentsDir, ".staging", `${preRenameId}.part`);
        const finalPath = path.join(attachmentsDir, postRenameRelativePath);
        fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
        fs.mkdirSync(path.dirname(finalPath), { recursive: true });
        fs.writeFileSync(stagingPath, Buffer.from([5, 6]));
        fs.writeFileSync(finalPath, Buffer.from([7, 8]));
      });

      yield* runManagedAttachmentCleanupBatch.pipe(
        Effect.provide(
          Layer.succeed(ServerConfig, {
            attachmentsDir,
          } as ServerConfigShape),
        ),
      );

      const states = yield* sql<{
        readonly attachmentId: string;
        readonly state: string;
      }>`
        SELECT attachment_id AS "attachmentId", state
        FROM managed_attachment_blobs
        ORDER BY attachment_id
      `;
      const stateByAttachmentId = new Map(states.map((row) => [row.attachmentId, row.state]));
      assert.strictEqual(stateByAttachmentId.get(committedReservation.attachmentId), "claimed");
      assert.strictEqual(stateByAttachmentId.get(preRenameId), "deleted");
      assert.strictEqual(stateByAttachmentId.get(postRenameId), "deleted");

      const usage = yield* repository.getUsage({
        ownerKind: principal.ownerKind,
        ownerId: principal.ownerId,
      });
      assert.deepStrictEqual(usage, {
        homeBytes: 4,
        homeCount: 1,
        principalStagingBytes: 0,
        principalStagingCount: 0,
      });
      assert.isTrue(fs.existsSync(path.join(attachmentsDir, committedReservation.relativePath)));
      assert.isFalse(fs.existsSync(path.join(attachmentsDir, ".staging", `${preRenameId}.part`)));
      assert.isFalse(fs.existsSync(path.join(attachmentsDir, postRenameRelativePath)));
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => fs.rmSync(attachmentsDir, { recursive: true, force: true })),
      ),
    );
  });
});
