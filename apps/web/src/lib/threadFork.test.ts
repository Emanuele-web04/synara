import {
  MessageId,
  ProjectId,
  ThreadId,
  type NativeApi,
  type ThreadHandoffImportedMessage,
} from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import type { Thread } from "../types";
import { canForkThread, dispatchThreadFork } from "./threadFork";

type ForkCandidate = Parameters<typeof canForkThread>[0]["thread"];

function threadWith(overrides: { parentThreadId?: string }, streaming: boolean): ForkCandidate {
  return {
    parentThreadId: null,
    sidechatSourceThreadId: null,
    sidechatContext: null,
    messages: [{ role: "assistant", streaming }],
    ...overrides,
  } as ForkCandidate;
}

const ordinary = { providerHandoff: true, workspaceHandoff: true };

describe("canForkThread", () => {
  it("offers fork once the thread has a settled message", () => {
    expect(canForkThread({ thread: threadWith({}, false), handoffAvailability: ordinary })).toBe(
      true,
    );
  });

  it("holds fork back while the only message is still streaming", () => {
    expect(canForkThread({ thread: threadWith({}, true), handoffAvailability: ordinary })).toBe(
      false,
    );
  });

  it("hides fork for threads without their own checkout", () => {
    expect(
      canForkThread({
        thread: threadWith({}, false),
        handoffAvailability: { providerHandoff: true, workspaceHandoff: false },
      }),
    ).toBe(false);
    expect(
      canForkThread({
        thread: threadWith({ parentThreadId: "parent" }, false),
        handoffAvailability: ordinary,
      }),
    ).toBe(false);
  });
});

describe("dispatchThreadFork", () => {
  const sourceThread = {
    id: ThreadId.makeUnsafe("thread-source"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Words",
    envMode: "local",
    branch: null,
    worktreePath: null,
    workingDirectory: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    messages: [
      {
        id: "u1",
        role: "user",
        text: "Remember APPLE",
        streaming: false,
        createdAt: "2026-10-09T00:00:01.000Z",
      },
      {
        id: "a1",
        role: "assistant",
        text: "![Old snapshot](./literal%2520.png)",
        streaming: false,
        createdAt: "2026-10-09T00:00:02.000Z",
        attachments: [
          {
            type: "image",
            id: "att_v2_source_snapshot",
            sourcePath: "./literal%20.png",
            name: "literal%20.png",
            mimeType: "image/png",
            sizeBytes: 64,
          },
        ],
      },
      {
        id: "u2",
        role: "user",
        text: "Remember BANANA",
        streaming: false,
        createdAt: "2026-10-09T00:00:03.000Z",
      },
      {
        id: "a2",
        role: "assistant",
        text: "ok",
        streaming: false,
        createdAt: "2026-10-09T00:00:04.000Z",
      },
    ],
  } as unknown as Thread;

  async function fork(throughMessageId?: string) {
    const dispatchCommand = vi.fn(async (_command: unknown) => undefined);
    await dispatchThreadFork({
      api: { orchestration: { dispatchCommand } } as unknown as NativeApi,
      sourceThread,
      target: "local",
      rootBranch: null,
      modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      ...(throughMessageId ? { throughMessageId: MessageId.makeUnsafe(throughMessageId) } : {}),
    });
    return dispatchCommand.mock.calls[0]?.[0] as {
      readonly throughMessageId?: string;
      readonly importedMessages: ReadonlyArray<ThreadHandoffImportedMessage>;
    };
  }

  it("forks through the selected turn with its persisted inline image alias", async () => {
    const command = await fork("a1");
    expect(command.throughMessageId).toBe("a1");
    expect(command.importedMessages.map((message) => message.text)).toEqual([
      "Remember APPLE",
      "![Old snapshot](./literal%2520.png)",
    ]);
    // The original file may be gone; the new thread needs the snapshot id and
    // already-decoded alias to render this Markdown from managed bytes.
    expect(command.importedMessages[1]?.attachments).toEqual([
      {
        type: "image",
        id: "att_v2_source_snapshot",
        sourcePath: "./literal%20.png",
        name: "literal%20.png",
        mimeType: "image/png",
        sizeBytes: 64,
      },
    ]);
  });

  it("rejects an unavailable selected message instead of importing later history", async () => {
    await expect(fork("deleted-message")).rejects.toThrow("Selected message");
  });

  it("omits the cutoff for a whole-thread fork", async () => {
    const command = await fork();
    expect(command).not.toHaveProperty("throughMessageId");
    expect(command.importedMessages).toHaveLength(4);
  });
});
