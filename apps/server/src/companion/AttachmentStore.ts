import * as Crypto from "node:crypto";
import fs from "node:fs/promises";

import {
  type AuthSessionId,
  type ChatAttachment,
  CompanionUploadId,
  type ThreadId,
} from "@synara/contracts";
import {
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Path,
  Ref,
  Semaphore,
  ServiceMap,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { resolveAttachmentRelativePath } from "../attachmentPaths";
import { ServerConfig } from "../config";
import { attachmentPrincipalForSession } from "../managedAttachmentPrincipal";
import { reserveManagedAttachmentUpload } from "../managedAttachmentStore";
import { ManagedAttachmentRepository } from "../persistence/Services/ManagedAttachments";
import { repairPrivateFile, syncDirectoryEntry } from "../privatePathPermissions";

export const COMPANION_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const COMPANION_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const COMPANION_UPLOAD_TTL_MS = 24 * 60 * 60 * 1_000;
export const COMPANION_MAX_OUTSTANDING_UPLOADS_PER_SESSION = 16;
export const COMPANION_MAX_OUTSTANDING_UPLOAD_BYTES_PER_SESSION = 200 * 1024 * 1024;

interface UploadRow {
  readonly id: string;
  readonly attachmentId: string;
  readonly sessionId: AuthSessionId;
  readonly threadId: ThreadId;
  readonly filename: string;
  readonly mediaType: string;
  readonly kind: "image" | "file";
  readonly sizeBytes: number;
  readonly storagePath: string;
  readonly expiresAt: string;
}

export class CompanionAttachmentStoreError extends Error {
  readonly _tag = "CompanionAttachmentStoreError";

  readonly reason: "quota" | "inactive-session" | "internal";

  constructor(
    message: string,
    options?: ErrorOptions & {
      readonly reason?: "quota" | "inactive-session" | "internal";
    },
  ) {
    super(message, options);
    this.reason = options?.reason ?? "internal";
  }
}

export interface CompanionAttachmentStoreShape {
  readonly acquireUploadReservation: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<
    { readonly release: Effect.Effect<void, never> },
    CompanionAttachmentStoreError
  >;
  readonly registerPersisted: (input: {
    readonly sessionId: AuthSessionId;
    readonly threadId: ThreadId;
    readonly filename: string;
    readonly mediaType: string;
    readonly kind: "image" | "file";
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly temporaryPath: string;
  }) => Effect.Effect<
    { readonly uploadId: CompanionUploadId; readonly attachment: ChatAttachment; readonly expiresAt: DateTime.Utc },
    CompanionAttachmentStoreError
  >;
  readonly consume: (input: {
    readonly sessionId: AuthSessionId;
    readonly threadId: ThreadId;
    readonly requestId: string;
    readonly uploadIds: ReadonlyArray<CompanionUploadId>;
  }) => Effect.Effect<ReadonlyArray<ChatAttachment>, CompanionAttachmentStoreError>;
  /** Release a request-scoped reservation when its command was not accepted. */
  readonly release: (input: {
    readonly sessionId: AuthSessionId;
    readonly threadId: ThreadId;
    readonly requestId: string;
    readonly uploadIds: ReadonlyArray<CompanionUploadId>;
  }) => Effect.Effect<void, CompanionAttachmentStoreError>;
  readonly delete: (input: {
    readonly sessionId: AuthSessionId;
    readonly uploadId: CompanionUploadId;
  }) => Effect.Effect<boolean, CompanionAttachmentStoreError>;
  readonly cleanupExpired: Effect.Effect<number, never>;
}

export class CompanionAttachmentStore extends ServiceMap.Service<
  CompanionAttachmentStore,
  CompanionAttachmentStoreShape
>()("synara/companion/AttachmentStore") {}

function sanitizeFilename(value: string): string {
  const base = value.replace(/\\/g, "/").split("/").at(-1) ?? "attachment";
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, "-").trim();
  return (cleaned || "attachment").slice(0, 255);
}

function sanitizeMediaType(value: string, kind: "image" | "file"): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)) {
    return kind === "image" ? "image/jpeg" : "application/octet-stream";
  }
  if (kind === "image" && !normalized.startsWith("image/")) {
    throw new CompanionAttachmentStoreError("Image uploads require an image media type.");
  }
  return normalized.slice(0, 100);
}

function toAttachment(row: Pick<UploadRow, "kind" | "attachmentId" | "filename" | "mediaType" | "sizeBytes">): ChatAttachment {
  return {
    type: row.kind,
    id: row.attachmentId,
    name: row.filename,
    mimeType: row.mediaType,
    sizeBytes: row.sizeBytes,
  };
}

export const makeCompanionAttachmentStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const managedAttachments = yield* ManagedAttachmentRepository;
  const uploadReservationLock = yield* Semaphore.make(1);
  const uploadReservations = yield* Ref.make(
    new Map<string, { readonly sessionId: AuthSessionId; readonly reservedBytes: number }>(),
  );

  const acquireUploadReservation: CompanionAttachmentStoreShape["acquireUploadReservation"] =
    (sessionId) =>
      uploadReservationLock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const activeSession = yield* sql<{ readonly sessionId: AuthSessionId }>`
            SELECT session_id AS "sessionId"
            FROM auth_sessions
            WHERE session_id = ${sessionId}
              AND revoked_at IS NULL
              AND expires_at > ${DateTime.formatIso(now)}
            LIMIT 1
          `;
          if (!activeSession[0]) {
            return yield* Effect.fail(
              new CompanionAttachmentStoreError("The authenticated session is no longer active.", {
                reason: "inactive-session",
              }),
            );
          }

          const persistedRows = yield* sql<{
            readonly uploadCount: number;
            readonly totalBytes: number;
          }>`
            SELECT COUNT(*) AS "uploadCount", COALESCE(SUM(size_bytes), 0) AS "totalBytes"
            FROM companion_attachment_uploads
            WHERE session_id = ${sessionId}
              AND consumed_at IS NULL
              AND revoked_at IS NULL
              AND expires_at > ${DateTime.formatIso(now)}
          `;
          const inFlight = [...(yield* Ref.get(uploadReservations)).values()].filter(
            (reservation) => reservation.sessionId === sessionId,
          );
          const persistedCount = Number(persistedRows[0]?.uploadCount ?? 0);
          const persistedBytes = Number(persistedRows[0]?.totalBytes ?? 0);
          const inFlightBytes = inFlight.reduce(
            (total, reservation) => total + reservation.reservedBytes,
            0,
          );
          if (
            persistedCount + inFlight.length + 1 >
              COMPANION_MAX_OUTSTANDING_UPLOADS_PER_SESSION ||
            persistedBytes + inFlightBytes + COMPANION_MAX_FILE_BYTES >
              COMPANION_MAX_OUTSTANDING_UPLOAD_BYTES_PER_SESSION
          ) {
            return yield* Effect.fail(
              new CompanionAttachmentStoreError("Outstanding attachment quota exceeded.", {
                reason: "quota",
              }),
            );
          }

          const reservationId = Crypto.randomUUID();
          yield* Ref.update(uploadReservations, (current) => {
            const next = new Map(current);
            next.set(reservationId, {
              sessionId,
              reservedBytes: COMPANION_MAX_FILE_BYTES,
            });
            return next;
          });
          return {
            release: uploadReservationLock.withPermits(1)(
              Ref.update(uploadReservations, (current) => {
                const next = new Map(current);
                next.delete(reservationId);
                return next;
              }),
            ),
          };
        }),
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof CompanionAttachmentStoreError
            ? cause
            : new CompanionAttachmentStoreError("Failed to reserve attachment upload capacity.", {
                cause,
              }),
        ),
      );

  const registerPersisted: CompanionAttachmentStoreShape["registerPersisted"] = (input) =>
    Effect.gen(function* () {
      const maxBytes = input.kind === "image" ? COMPANION_MAX_IMAGE_BYTES : COMPANION_MAX_FILE_BYTES;
      if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > maxBytes) {
        return yield* Effect.fail(
          new CompanionAttachmentStoreError("Attachment is empty or too large."),
        );
      }
      const uploadId = CompanionUploadId.makeUnsafe(Crypto.randomUUID());
      const filename = sanitizeFilename(input.filename);
      const mediaType = sanitizeMediaType(input.mediaType, input.kind);
      const createdAt = yield* DateTime.now;
      const createdAtIso = DateTime.formatIso(createdAt);
      const expiresAt = DateTime.makeUnsafe(
        DateTime.toEpochMillis(createdAt) + COMPANION_UPLOAD_TTL_MS,
      );
      const principal = attachmentPrincipalForSession(input.sessionId);
      const reservation = yield* reserveManagedAttachmentUpload({
        type: input.kind,
        threadId: input.threadId,
        name: filename,
        mimeType: mediaType,
        reservedBytes: input.sizeBytes,
        now: createdAtIso,
        principal,
        repository: managedAttachments,
      });
      const finalPath = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: reservation.relativePath,
      });
      if (!finalPath) {
        yield* managedAttachments.cancelStaged({
          attachmentId: reservation.attachmentId,
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
          reason: "companion-path-invalid",
          requestedAt: createdAtIso,
        }).pipe(Effect.ignore);
        return yield* Effect.fail(
          new CompanionAttachmentStoreError("Invalid attachment path."),
        );
      }
      const attachment = toAttachment({
        kind: input.kind,
        attachmentId: reservation.attachmentId,
        filename,
        mediaType,
        sizeBytes: input.sizeBytes,
      });

      yield* fileSystem.makeDirectory(path.dirname(finalPath), { recursive: true });
      const persisted = yield* Effect.exit(
        fileSystem.rename(input.temporaryPath, finalPath).pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: async () => {
                await repairPrivateFile(finalPath);
                const handle = await fs.open(finalPath, "r+");
                try {
                  await handle.sync();
                } finally {
                  await handle.close();
                }
                await syncDirectoryEntry(path.dirname(finalPath));
              },
              catch: (cause) => cause,
            }),
          ),
        ),
      );
      if (persisted._tag === "Failure") {
        yield* managedAttachments.cancelStaged({
          attachmentId: reservation.attachmentId,
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
          reason: "companion-upload-write-failed",
          requestedAt: createdAtIso,
        }).pipe(Effect.ignore);
        return yield* Effect.failCause(persisted.cause);
      }
      const finalized = yield* managedAttachments.finalizeStaged({
        attachmentId: reservation.attachmentId,
        ownerThreadId: input.threadId,
        ownerKind: principal.ownerKind,
        ownerId: principal.ownerId,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        stagingExpiresAt: DateTime.formatIso(expiresAt),
        now: createdAtIso,
      });
      if (finalized.status !== "staged") {
        yield* managedAttachments.cancelStaged({
          attachmentId: reservation.attachmentId,
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
          reason: "companion-upload-finalize-failed",
          requestedAt: createdAtIso,
        }).pipe(Effect.ignore);
        return yield* Effect.fail(
          new CompanionAttachmentStoreError("Attachment reservation expired before finalization."),
        );
      }
      const inserted = yield* sql<{ readonly id: string }>`
        INSERT INTO companion_attachment_uploads (
          id, attachment_id, session_id, thread_id, filename, media_type, kind, size_bytes,
          storage_path, created_at, expires_at, consumed_at, revoked_at
        ) SELECT
          ${uploadId}, ${reservation.attachmentId}, ${input.sessionId}, ${input.threadId}, ${filename}, ${mediaType},
          ${input.kind}, ${input.sizeBytes}, ${finalPath}, ${createdAtIso},
          ${DateTime.formatIso(expiresAt)}, NULL, NULL
        FROM auth_sessions
        WHERE session_id = ${input.sessionId}
          AND revoked_at IS NULL
          AND expires_at > ${DateTime.formatIso(createdAt)}
        RETURNING id AS "id"
      `.pipe(
        Effect.onExit((exit) =>
          exit._tag === "Failure"
            ? managedAttachments.cancelStaged({
                attachmentId: reservation.attachmentId,
                ownerKind: principal.ownerKind,
                ownerId: principal.ownerId,
                reason: "companion-upload-ledger-failed",
                requestedAt: createdAtIso,
              }).pipe(Effect.ignore)
            : Effect.void,
        ),
      );
      if (!inserted[0]) {
        yield* managedAttachments.cancelStaged({
          attachmentId: reservation.attachmentId,
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
          reason: "companion-session-inactive",
          requestedAt: createdAtIso,
        }).pipe(Effect.ignore);
        return yield* Effect.fail(
          new CompanionAttachmentStoreError("The authenticated session is no longer active.", {
            reason: "inactive-session",
          }),
        );
      }

      return { uploadId, attachment, expiresAt: DateTime.toUtc(expiresAt) };
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof CompanionAttachmentStoreError
          ? cause
          : new CompanionAttachmentStoreError("Failed to persist attachment upload.", { cause }),
      ),
    );

  const consume: CompanionAttachmentStoreShape["consume"] = (input) =>
    Effect.gen(function* () {
      if (input.uploadIds.length === 0) return [];
      if (input.uploadIds.length > 8 || new Set(input.uploadIds).size !== input.uploadIds.length) {
        return yield* Effect.fail(new CompanionAttachmentStoreError("Invalid attachment list."));
      }
      const now = yield* DateTime.now;
      const rows = yield* sql.withTransaction(
        Effect.forEach(input.uploadIds, (uploadId) =>
          sql<UploadRow>`
            UPDATE companion_attachment_uploads
            SET consumed_at = COALESCE(consumed_at, ${DateTime.formatIso(now)}),
                consumed_by_request_id = COALESCE(consumed_by_request_id, ${input.requestId})
            WHERE id = ${uploadId}
              AND session_id = ${input.sessionId}
              AND thread_id = ${input.threadId}
              AND (consumed_at IS NULL OR consumed_by_request_id = ${input.requestId})
              AND revoked_at IS NULL
              AND expires_at > ${DateTime.formatIso(now)}
            RETURNING
              id AS "id", attachment_id AS "attachmentId", session_id AS "sessionId", thread_id AS "threadId",
              filename AS "filename", media_type AS "mediaType", kind AS "kind",
              size_bytes AS "sizeBytes", storage_path AS "storagePath", expires_at AS "expiresAt"
          `.pipe(
            Effect.flatMap((matched) =>
              matched[0]
                ? Effect.succeed(matched[0])
                : Effect.fail(new CompanionAttachmentStoreError("Attachment is unavailable or already used.")),
            ),
          ),
        ),
      );
      return rows.map(toAttachment);
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof CompanionAttachmentStoreError
          ? cause
          : new CompanionAttachmentStoreError("Failed to consume attachment uploads.", { cause }),
      ),
    );

  const deleteUpload: CompanionAttachmentStoreShape["delete"] = (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const rows = yield* sql<Pick<UploadRow, "attachmentId">>`
        UPDATE companion_attachment_uploads
        SET revoked_at = ${DateTime.formatIso(now)}
        WHERE id = ${input.uploadId}
          AND session_id = ${input.sessionId}
          AND consumed_at IS NULL
          AND revoked_at IS NULL
        RETURNING attachment_id AS "attachmentId"
      `;
      const row = rows[0];
      if (!row) return false;
      const principal = attachmentPrincipalForSession(input.sessionId);
      yield* managedAttachments.cancelStaged({
        attachmentId: row.attachmentId,
        ownerKind: principal.ownerKind,
        ownerId: principal.ownerId,
        reason: "companion-upload-cancelled",
        requestedAt: DateTime.formatIso(now),
      });
      return true;
    }).pipe(
      Effect.mapError((cause) => new CompanionAttachmentStoreError("Failed to delete attachment upload.", { cause })),
    );

  const release: CompanionAttachmentStoreShape["release"] = (input) =>
    input.uploadIds.length === 0
      ? Effect.void
      : sql`
          UPDATE companion_attachment_uploads
          SET consumed_at = NULL, consumed_by_request_id = NULL
          WHERE session_id = ${input.sessionId}
            AND thread_id = ${input.threadId}
            AND consumed_by_request_id = ${input.requestId}
            AND id IN ${sql.in(input.uploadIds)}
            AND revoked_at IS NULL
        `.pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new CompanionAttachmentStoreError(
                "Failed to release attachment reservation.",
                { cause },
              ),
          ),
        );

  const cleanupExpired: CompanionAttachmentStoreShape["cleanupExpired"] = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const rows = yield* sql<Pick<UploadRow, "attachmentId" | "sessionId">>`
      DELETE FROM companion_attachment_uploads
      WHERE consumed_at IS NULL AND expires_at <= ${DateTime.formatIso(now)}
      RETURNING attachment_id AS "attachmentId", session_id AS "sessionId"
    `;
    yield* Effect.forEach(
      rows,
      (row) => {
        const principal = attachmentPrincipalForSession(row.sessionId);
        return managedAttachments.cancelStaged({
          attachmentId: row.attachmentId,
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
          reason: "companion-upload-expired",
          requestedAt: DateTime.formatIso(now),
        }).pipe(Effect.ignore);
      },
      { discard: true, concurrency: 4 },
    );
    return rows.length;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to clean expired companion uploads", { cause }).pipe(Effect.as(0)),
    ),
  );

  return {
    acquireUploadReservation,
    registerPersisted,
    consume,
    release,
    delete: deleteUpload,
    cleanupExpired,
  };
});

export const CompanionAttachmentStoreLive = Layer.effect(
  CompanionAttachmentStore,
  makeCompanionAttachmentStore,
);
