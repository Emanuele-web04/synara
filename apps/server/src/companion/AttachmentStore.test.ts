import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "node:crypto";
import { AuthSessionId, ThreadId } from "@synara/contracts";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../config";
import { ManagedAttachmentRepositoryLive } from "../persistence/Layers/ManagedAttachments";
import { ManagedAttachmentRepository } from "../persistence/Services/ManagedAttachments";
import { attachmentPrincipalForSession } from "../managedAttachmentPrincipal";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import {
  CompanionAttachmentStore,
  CompanionAttachmentStoreLive,
} from "./AttachmentStore";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-companion-upload-test-",
}).pipe(Layer.provide(NodeServices.layer));
const dependencies = Layer.mergeAll(
  SqlitePersistenceMemory,
  ManagedAttachmentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  NodeServices.layer,
  serverConfigLayer,
);
const testLayer = CompanionAttachmentStoreLive.pipe(Layer.provideMerge(dependencies));

describe("CompanionAttachmentStore upload reservations", () => {
  it("bounds aggregate in-flight attachment capacity per authenticated session", async () => {
    await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const attachments = yield* CompanionAttachmentStore;
      const sessionId = AuthSessionId.makeUnsafe("attachment-quota-session");
      const now = new Date();
      yield* sql`
        INSERT INTO auth_sessions (
          session_id, subject, role, method, client_device_type, issued_at,
          expires_at, revoked_at, access_profile
        ) VALUES (
          ${sessionId}, 'upload-test', 'client', 'browser-session-cookie', 'mobile',
          ${new Date(now.getTime() - 1_000).toISOString()},
          ${new Date(now.getTime() + 60_000).toISOString()}, NULL, 'companion'
        )
      `;

      const reservations = yield* Effect.forEach(
        Array.from({ length: 8 }),
        () => attachments.acquireUploadReservation(sessionId),
        { concurrency: 1 },
      );
      const rejected = yield* Effect.flip(attachments.acquireUploadReservation(sessionId));
      expect(rejected.reason).toBe("quota");

      yield* reservations[0]!.release;
      const replacement = yield* attachments.acquireUploadReservation(sessionId);
      yield* Effect.forEach(
        [...reservations.slice(1), replacement],
        (reservation) => reservation.release,
        { discard: true },
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);
  });

  it("finalizes streamed uploads into the current managed attachment ledger", async () => {
    await Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const attachments = yield* CompanionAttachmentStore;
      const managed = yield* ManagedAttachmentRepository;
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sessionId = AuthSessionId.makeUnsafe("attachment-managed-session");
      const threadId = ThreadId.makeUnsafe("attachment-managed-thread");
      const now = new Date();
      yield* sql`
        INSERT INTO auth_sessions (
          session_id, subject, role, method, client_device_type, issued_at,
          expires_at, revoked_at, access_profile
        ) VALUES (
          ${sessionId}, 'upload-test', 'client', 'browser-session-cookie', 'mobile',
          ${new Date(now.getTime() - 1_000).toISOString()},
          ${new Date(now.getTime() + 60_000).toISOString()}, NULL, 'companion'
        )
      `;
      const bytes = new TextEncoder().encode("managed companion upload");
      const temporaryDirectory = path.join(config.attachmentsDir, ".companion-uploads");
      const temporaryPath = path.join(temporaryDirectory, "managed.part");
      yield* fileSystem.makeDirectory(temporaryDirectory, { recursive: true });
      yield* fileSystem.writeFile(temporaryPath, bytes);

      const registered = yield* attachments.registerPersisted({
        sessionId,
        threadId,
        filename: "notes.txt",
        mediaType: "text/plain",
        kind: "file",
        sizeBytes: bytes.byteLength,
        sha256: Crypto.createHash("sha256").update(bytes).digest("hex"),
        temporaryPath,
      });
      const principal = attachmentPrincipalForSession(sessionId);
      const staged = yield* managed.findServerOwned({
        attachmentId: registered.attachment.id,
        ownerThreadId: threadId,
        ownerKind: principal.ownerKind,
        ownerId: principal.ownerId,
        now: new Date().toISOString(),
      });

      expect(Option.isSome(staged)).toBe(true);
      if (Option.isSome(staged)) {
        expect(staged.value.state).toBe("staged");
        expect(staged.value.sha256).toBe(
          Crypto.createHash("sha256").update(bytes).digest("hex"),
        );
      }
    }).pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);
  });
});
