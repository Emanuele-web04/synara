import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId, type HubWorkSourceMessage } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL } from "../managedAttachmentPrincipal.ts";
import {
  ManagedAttachmentStoreError,
  persistReservedManagedAttachment,
  reserveManagedAttachmentUpload,
} from "../managedAttachmentStore.ts";
import { ManagedAttachmentRepositoryLive } from "../persistence/Layers/ManagedAttachments.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ManagedAttachmentRepository,
  type ManagedAttachmentRepositoryShape,
} from "../persistence/Services/ManagedAttachments.ts";
import {
  resolveProviderAttachmentPath,
  resolveProviderDispatchAttachments,
} from "../provider/providerAttachmentPaths.ts";
import { cloneDelegatedAttachments } from "./delegatedAttachments.ts";

const now = "2026-10-02T18:00:00.000Z";
const sourceThreadId = ThreadId.makeUnsafe("source-thread");
const sourceMessageId = MessageId.makeUnsafe("source-message");
const targetThreadId = ThreadId.makeUnsafe("target-thread");
const targetMessageId = MessageId.makeUnsafe("target-message");
const principal = LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL;
const layer = ManagedAttachmentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

function withStore<A, E>(
  run: (store: {
    attachmentsDir: string;
    repository: ManagedAttachmentRepositoryShape;
  }) => Effect.Effect<A, E>,
) {
  return Effect.acquireUseRelease(
    Effect.tryPromise(() => fs.mkdtemp(path.join(os.tmpdir(), "delegated-attachments-"))),
    (attachmentsDir) =>
      Effect.gen(function* () {
        const repository = yield* ManagedAttachmentRepository;
        return yield* run({ attachmentsDir, repository });
      }),
    (attachmentsDir) =>
      Effect.tryPromise(() => fs.rm(attachmentsDir, { recursive: true, force: true })).pipe(
        Effect.orDie,
      ),
  ).pipe(Effect.provide(layer));
}

function sourceMessage(store: {
  attachmentsDir: string;
  repository: ManagedAttachmentRepositoryShape;
}) {
  return Effect.gen(function* () {
    const reservation = yield* reserveManagedAttachmentUpload({
      type: "file",
      threadId: sourceThreadId,
      name: "spec.md",
      mimeType: "text/markdown",
      reservedBytes: 4,
      now,
      principal,
      repository: store.repository,
    });
    const attachment = yield* persistReservedManagedAttachment({
      ...store,
      reservation,
      bytes: Buffer.from("spec"),
      now,
      principal,
    });
    const claim = yield* store.repository.claimForAcceptedTurn({
      attachmentIds: [attachment.id],
      ownerThreadId: sourceThreadId,
      ownerKind: principal.ownerKind,
      ownerId: principal.ownerId,
      commandId: "source-command",
      messageId: sourceMessageId,
      now,
    });
    assert.equal(claim.status, "claimed");
    return {
      threadId: sourceThreadId,
      messageId: sourceMessageId,
      text: "Use this spec",
      attachments: [attachment],
      createdAt: now,
      updatedAt: now,
      turnId: null,
    } satisfies HubWorkSourceMessage;
  });
}

const cloneInput = (
  store: { attachmentsDir: string; repository: ManagedAttachmentRepositoryShape },
  sourceMessages: readonly HubWorkSourceMessage[],
) => ({
  ...store,
  sourceMessages,
  targetThreadId,
  targetMessageId,
  dispatchKey: "hub-delivery-1",
  principal,
  now,
});

it.effect(
  "clones a source file for target ownership and replays staged or claimed delivery without duplicating storage",
  () =>
    withStore((store) =>
      Effect.gen(function* () {
        const source = yield* sourceMessage(store);
        const input = cloneInput(store, [source]);
        const first = yield* cloneDelegatedAttachments(input);
        assert.lengthOf(first, 1);
        assert.notEqual(first[0]!.id, source.attachments[0]!.id);
        assert.deepEqual(yield* cloneDelegatedAttachments(input), first);
        const claim = yield* store.repository.claimForAcceptedTurn({
          attachmentIds: first.map((attachment) => attachment.id),
          ownerThreadId: targetThreadId,
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
          commandId: "target-command",
          messageId: targetMessageId,
          now,
        });
        assert.equal(claim.status, "claimed");
        assert.deepEqual(yield* cloneDelegatedAttachments(input), first);
        const dispatched = yield* resolveProviderDispatchAttachments({
          attachments: first,
          attachmentsDir: store.attachmentsDir,
          repository: store.repository,
          threadId: targetThreadId,
          messageId: targetMessageId,
          provider: "codex",
          operation: "thread.turn.start",
        });
        const filePath = resolveProviderAttachmentPath({
          attachmentsDir: store.attachmentsDir,
          attachment: dispatched[0]!,
        });
        assert.isNotNull(filePath);
        assert.equal(yield* Effect.tryPromise(() => fs.readFile(filePath!, "utf8")), "spec");
        const sourceBlob = Option.getOrThrow(
          yield* store.repository.findClaimedById({ attachmentId: source.attachments[0]!.id }),
        );
        assert.equal(sourceBlob.ownerThreadId, sourceThreadId);
        assert.equal(sourceBlob.claimMessageId, sourceMessageId);
        const usage = yield* store.repository.getUsage({
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
        });
        assert.equal(usage.homeCount, 2);
      }),
    ),
);

it.effect(
  "rejects canonical references whose claimed source belongs to another message or thread before reserving target storage",
  () =>
    withStore((store) =>
      Effect.gen(function* () {
        const source = yield* sourceMessage(store);
        for (const invalid of [
          { ...source, threadId: targetThreadId },
          { ...source, messageId: targetMessageId },
        ]) {
          const result = yield* cloneDelegatedAttachments(cloneInput(store, [invalid])).pipe(
            Effect.result,
          );
          assert.equal(result._tag, "Failure");
        }
        const usage = yield* store.repository.getUsage({
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
        });
        assert.equal(usage.homeCount, 1);
      }),
    ),
);

it.effect("rejects a source file whose stored bytes changed", () =>
  withStore((store) =>
    Effect.gen(function* () {
      const source = yield* sourceMessage(store);
      const blob = Option.getOrThrow(
        yield* store.repository.findClaimedById({ attachmentId: source.attachments[0]!.id }),
      );
      const filePath = resolveAttachmentRelativePath({
        attachmentsDir: store.attachmentsDir,
        relativePath: blob.relativePath,
      })!;
      yield* Effect.tryPromise(() => fs.writeFile(filePath, "evil"));
      const result = yield* cloneDelegatedAttachments(cloneInput(store, [source])).pipe(
        Effect.result,
      );
      assert.equal(result._tag, "Failure");
      const usage = yield* store.repository.getUsage({
        ownerKind: principal.ownerKind,
        ownerId: principal.ownerId,
      });
      assert.equal(usage.homeCount, 1);
    }),
  ),
);

it.effect(
  "retains assistant selections as quoted data and fails when a legacy source file is unavailable",
  () =>
    withStore((store) =>
      Effect.gen(function* () {
        const selection = {
          type: "assistant-selection",
          id: "quote-1",
          assistantMessageId: MessageId.makeUnsafe("assistant-message"),
          text: "Untrusted selected text",
        } as const;
        const source = {
          threadId: sourceThreadId,
          messageId: sourceMessageId,
          text: "Compare this quote",
          attachments: [selection],
          createdAt: now,
          updatedAt: now,
          turnId: null,
        };
        assert.deepEqual(yield* cloneDelegatedAttachments(cloneInput(store, [source])), [
          selection,
        ]);
        const missing = {
          type: "file",
          id: "legacy-file",
          name: "missing.md",
          mimeType: "text/markdown",
          sizeBytes: 4,
        } as const;
        const result = yield* cloneDelegatedAttachments(
          cloneInput(store, [{ ...source, attachments: [missing] }]),
        ).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        const usage = yield* store.repository.getUsage({
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
        });
        assert.equal(usage.homeCount ?? 0, 0);
      }),
    ),
);

it.effect("copies available legacy files into target-owned managed storage", () =>
  withStore((store) =>
    Effect.gen(function* () {
      const attachment = {
        type: "file",
        id: "source-thread-abc",
        name: "legacy.md",
        mimeType: "text/markdown",
        sizeBytes: 4,
      } as const;
      yield* Effect.tryPromise(() =>
        fs.writeFile(
          resolveAttachmentPath({ attachmentsDir: store.attachmentsDir, attachment })!,
          "spec",
        ),
      );
      const source = {
        threadId: sourceThreadId,
        messageId: sourceMessageId,
        turnId: null,
        text: "Use legacy spec",
        attachments: [attachment],
        createdAt: now,
        updatedAt: now,
      };
      const cloned = yield* cloneDelegatedAttachments(cloneInput(store, [source]));
      const owned = Option.getOrThrow(
        yield* store.repository.findServerOwned({
          attachmentId: cloned[0]!.id,
          ownerThreadId: targetThreadId,
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
          now,
        }),
      );
      assert.equal(owned.state, "staged");
      assert.equal(
        yield* Effect.tryPromise(() =>
          fs.readFile(
            resolveAttachmentRelativePath({
              attachmentsDir: store.attachmentsDir,
              relativePath: owned.relativePath,
            })!,
            "utf8",
          ),
        ),
        "spec",
      );
    }),
  ),
);

it.effect("rejects replay when the cloned blob was claimed by another message", () =>
  withStore((store) =>
    Effect.gen(function* () {
      const source = yield* sourceMessage(store);
      const input = cloneInput(store, [source]);
      const cloned = yield* cloneDelegatedAttachments(input);
      const claim = yield* store.repository.claimForAcceptedTurn({
        attachmentIds: cloned.map((attachment) => attachment.id),
        ownerThreadId: targetThreadId,
        ownerKind: principal.ownerKind,
        ownerId: principal.ownerId,
        commandId: "different-command",
        messageId: "different-message",
        now,
      });
      assert.equal(claim.status, "claimed");
      const result = yield* cloneDelegatedAttachments(input).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, ManagedAttachmentStoreError);
        assert.equal(
          (result.failure as ManagedAttachmentStoreError).code,
          "attachment_source_unavailable",
        );
      }
      const owned = Option.getOrThrow(
        yield* store.repository.findClaimedById({ attachmentId: cloned[0]!.id }),
      );
      assert.equal(owned.claimMessageId, "different-message");
    }),
  ),
);

it.effect(
  "fails explicitly on a deterministic upload interrupted before staging without reserving another identity",
  () =>
    withStore((store) =>
      Effect.gen(function* () {
        const source = yield* sourceMessage(store);
        const input = cloneInput(store, [source]);
        const interrupted = yield* cloneDelegatedAttachments({
          ...input,
          repository: {
            ...store.repository,
            reserve: (reservation) =>
              store.repository
                .reserve(reservation)
                .pipe(
                  Effect.flatMap((result) =>
                    result.status === "reserved"
                      ? Effect.die("Simulated process loss after durable reservation")
                      : Effect.succeed(result),
                  ),
                ),
          },
        }).pipe(Effect.exit);
        assert.equal(interrupted._tag, "Failure");
        const result = yield* cloneDelegatedAttachments(input).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.instanceOf(result.failure, ManagedAttachmentStoreError);
          assert.equal(
            (result.failure as ManagedAttachmentStoreError).code,
            "attachment_reservation_conflict",
          );
        }
        const usage = yield* store.repository.getUsage({
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
        });
        assert.equal(usage.homeCount, 2);
      }),
    ),
);

it.effect("rejects too many delegated attachments before allocating storage", () =>
  withStore((store) =>
    Effect.gen(function* () {
      const attachments = Array.from(
        { length: 9 },
        (_, index) =>
          ({
            type: "assistant-selection",
            id: `quote-${index}`,
            assistantMessageId: MessageId.makeUnsafe("assistant-message"),
            text: "Quoted data",
          }) as const,
      );
      const source = {
        threadId: sourceThreadId,
        messageId: sourceMessageId,
        turnId: null,
        text: "Compare quotes",
        attachments,
        createdAt: now,
        updatedAt: now,
      };
      const result = yield* cloneDelegatedAttachments(cloneInput(store, [source])).pipe(
        Effect.result,
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, ManagedAttachmentStoreError);
        assert.equal(
          (result.failure as ManagedAttachmentStoreError).code,
          "attachment_count_exceeded",
        );
      }
      const usage = yield* store.repository.getUsage({
        ownerKind: principal.ownerKind,
        ownerId: principal.ownerId,
      });
      assert.equal(usage.homeCount ?? 0, 0);
    }),
  ),
);
