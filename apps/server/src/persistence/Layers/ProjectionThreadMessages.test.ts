import { MessageId, ThreadId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect("orders messages by server sequence instead of caller timestamp", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.makeUnsafe("thread-causal-message-order");
      const write = (input: {
        readonly messageId: string;
        readonly sequence: number;
        readonly createdAt: string;
      }) =>
        repository.upsert({
          messageId: MessageId.makeUnsafe(input.messageId),
          threadId,
          turnId: null,
          role: "user",
          text: input.messageId,
          isStreaming: false,
          source: "native",
          sequence: input.sequence,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        });

      yield* write({
        messageId: "accepted-first",
        sequence: 10,
        createdAt: "2026-07-14T12:00:10.000Z",
      });
      yield* write({
        messageId: "accepted-second-with-older-clock",
        sequence: 11,
        createdAt: "2026-07-14T11:59:00.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.deepStrictEqual(
        rows.map((row) => [row.messageId, row.sequence]),
        [
          [MessageId.makeUnsafe("accepted-first"), 10],
          [MessageId.makeUnsafe("accepted-second-with-older-clock"), 11],
        ],
      );
      assert.strictEqual(
        yield* repository.getLatestUserMessageAt({ threadId }),
        "2026-07-14T11:59:00.000Z",
      );
    }),
  );

  it.effect("keeps equal provider message IDs independent across threads", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const messageId = MessageId.makeUnsafe("shared-provider-message");
      const threadA = ThreadId.makeUnsafe("thread-message-scope-a");
      const threadB = ThreadId.makeUnsafe("thread-message-scope-b");
      const createdAt = "2026-07-14T00:00:00.000Z";

      const write = (input: {
        readonly threadId: ThreadId;
        readonly text: string;
        readonly attachmentId?: string;
        readonly updatedAt?: string;
      }) =>
        repository.upsert({
          messageId,
          threadId: input.threadId,
          turnId: null,
          role: "assistant",
          text: input.text,
          ...(input.attachmentId
            ? {
                attachments: [
                  {
                    type: "file" as const,
                    id: input.attachmentId,
                    name: `${input.attachmentId}.txt`,
                    mimeType: "text/plain",
                    sizeBytes: 1,
                  },
                ],
              }
            : {}),
          isStreaming: false,
          source: "native",
          createdAt,
          updatedAt: input.updatedAt ?? createdAt,
        });

      yield* write({ threadId: threadA, text: "thread A", attachmentId: "attachment-a" });
      yield* write({ threadId: threadB, text: "thread B", attachmentId: "attachment-b" });
      yield* write({
        threadId: threadA,
        text: "thread A updated",
        updatedAt: "2026-07-14T00:00:01.000Z",
      });

      const storedA = yield* repository.getByThreadAndMessageId({ threadId: threadA, messageId });
      const storedB = yield* repository.getByThreadAndMessageId({ threadId: threadB, messageId });
      assert.strictEqual(storedA._tag, "Some");
      assert.strictEqual(storedB._tag, "Some");
      if (storedA._tag === "Some" && storedB._tag === "Some") {
        assert.strictEqual(storedA.value.text, "thread A updated");
        assert.strictEqual(storedA.value.attachments?.[0]?.id, "attachment-a");
        assert.strictEqual(storedB.value.text, "thread B");
        assert.strictEqual(storedB.value.attachments?.[0]?.id, "attachment-b");
      }
    }),
  );

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

  it.effect("round-trips and preserves the automation dispatch origin", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.makeUnsafe("thread-dispatch-origin");
      const messageId = MessageId.makeUnsafe("message-dispatch-origin");
      const createdAt = "2026-02-28T19:31:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "kick off the review",
        dispatchOrigin: "automation",
        isStreaming: false,
        source: "native",
        createdAt,
        updatedAt: "2026-02-28T19:31:01.000Z",
      });

      // A later streaming update omits the origin; it must not be cleared.
      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "kick off the review now",
        isStreaming: false,
        source: "native",
        createdAt,
        updatedAt: "2026-02-28T19:31:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.dispatchOrigin, "automation");
    }),
  );

  it.effect(
    "overwrites a stale automation origin when a resend carries an explicit user origin",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadMessageRepository;
        const threadId = ThreadId.makeUnsafe("thread-dispatch-origin-edit");
        const messageId = MessageId.makeUnsafe("message-dispatch-origin-edit");
        const createdAt = "2026-02-28T19:32:00.000Z";

        yield* repository.upsert({
          messageId,
          threadId,
          turnId: null,
          role: "user",
          text: "automation kicked this off",
          dispatchOrigin: "automation",
          isStreaming: false,
          source: "native",
          createdAt,
          updatedAt: "2026-02-28T19:32:01.000Z",
        });

        // A human edit-and-resend replays through the decider, which stamps an
        // explicit "user" origin; the row must stop being labeled automation.
        yield* repository.upsert({
          messageId,
          threadId,
          turnId: null,
          role: "user",
          text: "human edited and resent this",
          dispatchOrigin: "user",
          isStreaming: false,
          source: "native",
          createdAt,
          updatedAt: "2026-02-28T19:32:02.000Z",
        });

        const rows = yield* repository.listByThreadId({ threadId });
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.dispatchOrigin, "user");
      }),
  );
});
