// FILE: assistantImageAttachments.test.ts
// Purpose: Exercise filesystem scope, Markdown selection and managed snapshot recovery.
// Layer: Server storage boundary tests with the real SQLite attachment repository.
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { expect, it } from "vitest";

import {
  stageAssistantImageAttachments,
  cancelAssistantImageAttachments,
} from "./assistantImageAttachments.ts";
import { LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL } from "./managedAttachmentPrincipal.ts";
import { ManagedAttachmentRepositoryLive } from "./persistence/Layers/ManagedAttachments.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { ManagedAttachmentRepository } from "./persistence/Services/ManagedAttachments.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

it("keeps lexical and real image scope paired after discovering a sibling root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inline-image-scope-"));
  const runtime = ManagedRuntime.make(
    ManagedAttachmentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  );
  try {
    const repository = await runtime.runPromise(Effect.service(ManagedAttachmentRepository));
    const cwd = path.join(root, "project");
    const sibling = path.join(root, "sibling");
    await fs.mkdir(cwd);
    await fs.mkdir(sibling);
    for (const name of ["first.png", "private.png"])
      await fs.writeFile(path.join(sibling, name), png);
    for (const name of ["inside space.png", "literal%20.png", "code-only.png"])
      await fs.writeFile(path.join(cwd, name), png);
    await fs.symlink(path.join(sibling, "private.png"), path.join(cwd, "escape.png"));
    const fileUri = pathToFileURL(path.join(cwd, "inside space.png"));
    const text = [
      "![legitimate](../sibling/first.png)",
      "![escaped](./escape.png)",
      `![URI](${fileUri.href})`,
      "![literal][named]",
      "[named]: ./literal%2520.png",
      "`![code](./code-only.png)`",
      "```md\n![fenced](./code-only.png)\n```",
      "[ordinary](./code-only.png)",
      "![network](https://example.invalid/image.png)",
    ].join("\n\n");
    const prepared = await runtime.runPromise(
      stageAssistantImageAttachments({
        text,
        threadId: "scope-thread",
        messageId: "scope-message",
        commandId: "scope-complete",
        cwd,
        sourceRoots: [cwd],
        additionalSourceRoots: Effect.succeed([sibling]),
        attachmentsDir: path.join(root, "attachments"),
        existingAttachments: [],
        repository,
      }),
    );
    expect(prepared.attachments.map((image) => image.sourcePath)).toEqual([
      "../sibling/first.png",
      decodeURIComponent(fileUri.pathname),
      "./literal%20.png",
    ]);
  } finally {
    await runtime.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("gives a rejected completion a new reservation without deleting an accepted snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inline-image-retry-"));
  const runtime = ManagedRuntime.make(
    ManagedAttachmentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  );
  try {
    const repository = await runtime.runPromise(Effect.service(ManagedAttachmentRepository));
    const source = path.join(root, "image.png");
    await fs.writeFile(source, png);
    const input = {
      text: "![image](./image.png)",
      threadId: "retry-thread",
      messageId: "retry-message",
      cwd: root,
      sourceRoots: [root],
      attachmentsDir: path.join(root, "attachments"),
      existingAttachments: [],
      repository,
    };
    const foreign = await runtime.runPromise(
      stageAssistantImageAttachments({
        ...input,
        threadId: "other-thread",
        messageId: "other-message",
        commandId: "other-completion",
      }),
    );
    expect(foreign.attachments).toHaveLength(1);
    const foreignReference = await runtime.runPromise(
      stageAssistantImageAttachments({
        ...input,
        commandId: "foreign-alias-completion",
        existingAttachments: foreign.attachments,
      }),
    );
    expect(foreignReference.attachments).toEqual([]);
    const untouched = await runtime.runPromise(
      repository.findServerOwned({
        attachmentId: foreign.attachments[0]!.id,
        ownerThreadId: "other-thread",
        ...LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
        now: new Date().toISOString(),
      }),
    );
    expect(Option.isSome(untouched) && untouched.value.state).toBe("staged");
    const first = await runtime.runPromise(
      stageAssistantImageAttachments({ ...input, commandId: "rejected-completion" }),
    );
    expect(first.attachments).toHaveLength(1);
    await runtime.runPromise(
      cancelAssistantImageAttachments({ attachmentIds: first.attachmentIds, repository }),
    );
    const second = await runtime.runPromise(
      stageAssistantImageAttachments({ ...input, commandId: "accepted-completion" }),
    );
    expect(second.attachments).toHaveLength(1);
    expect(second.attachments[0]!.id).not.toBe(first.attachments[0]!.id);
    const claim = await runtime.runPromise(
      repository.claimForAcceptedTurn({
        attachmentIds: second.attachmentIds,
        ownerThreadId: input.threadId,
        ...LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
        commandId: "accepted-completion",
        messageId: input.messageId,
        now: new Date().toISOString(),
      }),
    );
    expect(claim.status).toBe("claimed");
    await fs.unlink(source);
    await runtime.runPromise(
      cancelAssistantImageAttachments({ attachmentIds: second.attachmentIds, repository }),
    );
    const replay = await runtime.runPromise(
      stageAssistantImageAttachments({
        ...input,
        commandId: "next-completion",
        existingAttachments: second.attachments,
      }),
    );
    expect(replay.attachments).toEqual(second.attachments);
    const claimed = await runtime.runPromise(
      repository.findClaimedById({ attachmentId: second.attachments[0]!.id }),
    );
    expect(Option.isSome(claimed)).toBe(true);
  } finally {
    await runtime.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
