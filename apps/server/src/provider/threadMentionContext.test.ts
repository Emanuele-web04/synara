import type { OrchestrationThread, ProviderMentionReference } from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  appendThreadMentionContextBlocks,
  formatThreadMentionContextBlock,
  resolveThreadMentionPromptProjection,
  THREAD_MENTION_MAX_CONTEXT_CHARS,
  THREAD_MENTION_MAX_TITLE_CHARS,
  THREAD_MENTION_MAX_TOTAL_CONTEXT_CHARS,
  threadMentionContextSuffix,
} from "./threadMentionContext.ts";

function thread(messages: ReadonlyArray<{ role: "user" | "assistant"; text: string }>) {
  return {
    id: "mentioned-thread",
    projectId: "project-1",
    title: "Release planning",
    modelSelection: { provider: "codex", model: "gpt-test" },
    messages: messages.map((message, index) => ({
      id: `message-${index}`,
      ...message,
      turnId: null,
      streaming: false,
      source: "native",
      createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      updatedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    })),
  } as unknown as OrchestrationThread;
}

const reference = {
  name: "Release planning",
  path: "thread://mentioned-thread",
} satisfies ProviderMentionReference;

describe("thread mention prompt context", () => {
  it("resolves recent messages newest last and removes thread paths from native mentions", async () => {
    const mentionedThread = thread([
      { role: "user", text: "What should ship?" },
      { role: "assistant", text: "Ship the composer mentions." },
    ]);
    const fileMention = { name: "README.md", path: "/workspace/README.md" };
    const result = await Effect.runPromise(
      resolveThreadMentionPromptProjection({
        mentions: [reference, fileMention],
        snapshotQuery: {
          getThreadDetailById: () => Effect.succeed(Option.some(mentionedThread)),
        },
      }),
    );

    expect(result.providerMentions).toEqual([fileMention]);
    expect(result.contextBlocks).toHaveLength(1);
    expect(result.contextBlocks[0]).toBe(
      [
        "<mentioned_thread_context>",
        'Thread: "Release planning"',
        "Provider: codex",
        "Thread ID: mentioned-thread",
        "Recent transcript (newest last):",
        "[user]",
        "What should ship?",
        "",
        "[assistant]",
        "Ship the composer mentions.",
        "</mentioned_thread_context>",
      ].join("\n"),
    );
  });

  it("formats a missing thread as a non-fatal context note", async () => {
    const result = await Effect.runPromise(
      resolveThreadMentionPromptProjection({
        mentions: [reference],
        snapshotQuery: {
          getThreadDetailById: () => Effect.succeed(Option.none()),
        },
      }),
    );

    expect(result.providerMentions).toBeUndefined();
    expect(result.contextBlocks[0]).toContain(
      'Referenced chat "Release planning" (thread id: mentioned-thread) could not be found.',
    );
  });

  it("caps per-message, per-thread, and aggregate context while retaining the newest tail", async () => {
    const longThread = thread(
      Array.from({ length: 25 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `${index === 24 ? "NEWEST-MESSAGE " : ""}${String(index).repeat(2_000)}`,
      })),
    );
    const block = formatThreadMentionContextBlock({ reference, thread: longThread });
    expect(block.length).toBeLessThanOrEqual(THREAD_MENTION_MAX_CONTEXT_CHARS);
    expect(block).toContain("[... earlier transcript context truncated]");
    expect(block).toContain("NEWEST-MESSAGE");
    expect(block).toContain("[... truncated");

    const manyReferences = Array.from({ length: 65 }, (_, index) => ({
      name: `Thread ${index}`,
      path: `thread://thread-${index}`,
    }));
    const getThreadDetailById = vi.fn(() => Effect.succeed(Option.some(longThread)));
    const result = await Effect.runPromise(
      resolveThreadMentionPromptProjection({
        mentions: manyReferences,
        snapshotQuery: {
          getThreadDetailById,
        },
      }),
    );
    expect(result.contextBlocks.join("\n\n").length).toBeLessThanOrEqual(
      THREAD_MENTION_MAX_TOTAL_CONTEXT_CHARS,
    );
    expect(getThreadDetailById.mock.calls.length).toBeLessThan(manyReferences.length);
  });

  it("skips context resolution when the provider input has no remaining budget", async () => {
    const getThreadDetailById = vi.fn(() => Effect.succeed(Option.some(thread([]))));
    const result = await Effect.runPromise(
      resolveThreadMentionPromptProjection({
        mentions: [reference],
        snapshotQuery: { getThreadDetailById },
        maxTotalContextChars: 0,
      }),
    );

    expect(result).toEqual({ contextBlocks: [], providerMentions: undefined });
    expect(getThreadDetailById).not.toHaveBeenCalled();
  });

  it("clamps oversized titles so the block header stays bounded", () => {
    const longTitle = "T".repeat(THREAD_MENTION_MAX_TITLE_CHARS + 500);
    const namedThread = {
      ...thread([{ role: "user", text: "hello" }]),
      title: longTitle,
    } as OrchestrationThread;
    const block = formatThreadMentionContextBlock({ reference, thread: namedThread });
    const titleLine = block.split("\n")[1] ?? "";
    expect(titleLine.length).toBeLessThanOrEqual(
      THREAD_MENTION_MAX_TITLE_CHARS + "Thread: ……".length,
    );
    expect(titleLine).toContain("…");

    const missing = formatThreadMentionContextBlock({
      reference: { name: longTitle, path: "thread://missing" },
      thread: null,
    });
    expect(missing).toContain("…");
    expect(missing.length).toBeLessThan(longTitle.length);

    const oversizedId = formatThreadMentionContextBlock({
      reference: { name: "Missing", path: `thread://${"x".repeat(1_000)}` },
      thread: null,
      maxChars: 256,
    });
    expect(oversizedId.length).toBeLessThanOrEqual(256);
    expect(oversizedId.endsWith("</mentioned_thread_context>")).toBe(true);
  });

  it("builds an appendable suffix that stays outside the wrapped user message", () => {
    expect(threadMentionContextSuffix([])).toBe("");
    expect(threadMentionContextSuffix(["<block-a>", "<block-b>"])).toBe(
      "\n\n<block-a>\n\n<block-b>",
    );
    expect(appendThreadMentionContextBlocks({ text: "hi", contextBlocks: [] })).toBe("hi");
    expect(appendThreadMentionContextBlocks({ text: "hi", contextBlocks: ["<block>"] })).toBe(
      "hi\n\n<block>",
    );
  });
});
