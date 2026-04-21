import { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect("preserves existing attachments when upsert omits attachments", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.makeUnsafe("thread-preserve-attachments");
      const messageId = MessageId.makeUnsafe("message-preserve-attachments");
      const createdAt = "2026-02-28T19:00:00.000Z";
      const updatedAt = "2026-02-28T19:00:01.000Z";
      const persistedAttachments = [
        {
          type: "image" as const,
          id: "thread-preserve-attachments-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "initial",
        attachments: persistedAttachments,
        isStreaming: false,
        source: "native",
        createdAt,
        updatedAt,
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "updated",
        isStreaming: false,
        source: "native",
        createdAt,
        updatedAt: "2026-02-28T19:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "updated");
      assert.deepEqual(rows[0]?.attachments, persistedAttachments);
    }),
  );

  it.effect("allows explicit attachment clearing with an empty array", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.makeUnsafe("thread-clear-attachments");
      const messageId = MessageId.makeUnsafe("message-clear-attachments");
      const createdAt = "2026-02-28T19:10:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "with attachment",
        attachments: [
          {
            type: "image",
            id: "thread-clear-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        isStreaming: false,
        source: "native",
        createdAt,
        updatedAt: "2026-02-28T19:10:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "cleared",
        attachments: [],
        isStreaming: false,
        source: "native",
        createdAt,
        updatedAt: "2026-02-28T19:10:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "cleared");
      assert.deepEqual(rows[0]?.attachments, []);
    }),
  );

  it.effect("preserves structured skills and mentions when upsert omits them", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.makeUnsafe("thread-preserve-inline-metadata");
      const messageId = MessageId.makeUnsafe("message-preserve-inline-metadata");
      const createdAt = "2026-02-28T19:20:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "Use @github with $check-code",
        skills: [
          {
            name: "check-code",
            path: "/Users/test/.codex/skills/check-code/SKILL.md",
          },
        ],
        mentions: [
          {
            name: "github",
            path: "plugin://github@curated",
          },
        ],
        isStreaming: false,
        source: "native",
        createdAt,
        updatedAt: "2026-02-28T19:20:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "updated text",
        isStreaming: false,
        source: "native",
        createdAt,
        updatedAt: "2026-02-28T19:20:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0]?.skills, [
        {
          name: "check-code",
          path: "/Users/test/.codex/skills/check-code/SKILL.md",
        },
      ]);
      assert.deepEqual(rows[0]?.mentions, [
        {
          name: "github",
          path: "plugin://github@curated",
        },
      ]);
    }),
  );

  it.effect("preserves dispatch mode when later updates omit it", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.makeUnsafe("thread-preserve-dispatch-mode");
      const messageId = MessageId.makeUnsafe("message-preserve-dispatch-mode");
      const createdAt = "2026-02-28T19:30:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "steer this",
        dispatchMode: "steer",
        isStreaming: false,
        source: "native",
        createdAt,
        updatedAt: "2026-02-28T19:30:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "steer this harder",
        isStreaming: false,
        source: "native",
        createdAt,
        updatedAt: "2026-02-28T19:30:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.dispatchMode, "steer");
    }),
  );
});
