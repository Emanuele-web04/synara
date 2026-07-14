import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig, type ServerConfigShape } from "./config";
import { runManagedAttachmentCleanupBatch } from "./managedAttachmentCleanup";
import {
  ManagedAttachmentRepository,
  type ManagedAttachmentCleanupJob,
  type ManagedAttachmentRepositoryShape,
} from "./persistence/Services/ManagedAttachments";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function makeFixture(options: { readonly finalPathIsDirectory?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-managed-cleanup-"));
  temporaryRoots.push(root);
  const attachmentId = "att_v2_0123456789abcdef0123456789abcdef";
  const relativePath = `objects/01/${attachmentId}.png`;
  const finalPath = path.join(root, relativePath);
  const stagingPath = path.join(root, ".staging", `${attachmentId}.part`);
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.mkdir(path.dirname(stagingPath), { recursive: true });
  if (options.finalPathIsDirectory) await fs.mkdir(finalPath);
  else await fs.writeFile(finalPath, "final");
  await fs.writeFile(stagingPath, "partial");

  const job: ManagedAttachmentCleanupJob = {
    attachmentId,
    relativePath,
    reason: "test-cleanup",
    attemptCount: 0,
    nextAttemptAt: new Date(0).toISOString(),
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  return { root, finalPath, stagingPath, job };
}

function makeRepository(job: ManagedAttachmentCleanupJob) {
  const completed: string[] = [];
  const retried: string[] = [];
  const repository = {
    markExpiredForCleanup: () => Effect.succeed([]),
    leaseCleanup: () => Effect.succeed([job]),
    compactDeleted: () => Effect.succeed([]),
    completeCleanup: ({ attachmentId }: Parameters<
      ManagedAttachmentRepositoryShape["completeCleanup"]
    >[0]) =>
      Effect.sync(() => {
        completed.push(attachmentId);
        return true;
      }),
    retryCleanup: ({ attachmentId }: Parameters<
      ManagedAttachmentRepositoryShape["retryCleanup"]
    >[0]) =>
      Effect.sync(() => {
        retried.push(attachmentId);
        return true;
      }),
  } as unknown as ManagedAttachmentRepositoryShape;
  return { repository, completed, retried };
}

describe("managed attachment cleanup", () => {
  it("removes both crash-left staging bytes and the final blob before completing the job", async () => {
    const fixture = await makeFixture();
    const state = makeRepository(fixture.job);
    await Effect.runPromise(
      runManagedAttachmentCleanupBatch.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ManagedAttachmentRepository, state.repository),
            Layer.succeed(ServerConfig, {
              attachmentsDir: fixture.root,
            } as ServerConfigShape),
          ),
        ),
      ),
    );

    await expect(fs.stat(fixture.finalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(fixture.stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(state.completed).toEqual([fixture.job.attachmentId]);
    expect(state.retried).toEqual([]);
  });

  it("keeps a durable retry when physical deletion fails", async () => {
    const fixture = await makeFixture({ finalPathIsDirectory: true });
    const state = makeRepository(fixture.job);
    await Effect.runPromise(
      runManagedAttachmentCleanupBatch.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ManagedAttachmentRepository, state.repository),
            Layer.succeed(ServerConfig, {
              attachmentsDir: fixture.root,
            } as ServerConfigShape),
          ),
        ),
      ),
    );

    expect(state.completed).toEqual([]);
    expect(state.retried).toEqual([fixture.job.attachmentId]);
  });
});
