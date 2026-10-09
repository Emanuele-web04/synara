import { MessageId, ProjectId, ThreadId, type NativeApi } from "@synara/contracts";
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
        text: "ok",
        streaming: false,
        createdAt: "2026-10-09T00:00:02.000Z",
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
      modelSelection: { provider: "claudeAgent", model: "claude-haiku-4-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      ...(throughMessageId ? { throughMessageId: MessageId.makeUnsafe(throughMessageId) } : {}),
    });
    return dispatchCommand.mock.calls[0]?.[0] as {
      readonly throughMessageId?: string;
      readonly importedMessages: ReadonlyArray<{ readonly text: string }>;
    };
  }

  it("tells the server which turn the fork was taken from", async () => {
    const command = await fork("a1");
    expect(command.throughMessageId).toBe("a1");
    expect(command.importedMessages.map((message) => message.text)).toEqual([
      "Remember APPLE",
      "ok",
    ]);
  });

  it("omits the cutoff for a whole-thread fork", async () => {
    const command = await fork();
    expect(command).not.toHaveProperty("throughMessageId");
    expect(command.importedMessages).toHaveLength(4);
  });
});
