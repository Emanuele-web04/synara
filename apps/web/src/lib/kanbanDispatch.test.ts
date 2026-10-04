import { ProjectId, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useComposerDraftStore } from "../composerDraftStore";
import { resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import { buildKanbanComposerDraftSnapshot } from "../components/kanban/kanban.logic";
import { createPastedTextDraft } from "./composerPastedText";
import {
  clearPendingTurnDispatch,
  hasPendingTurnDispatch,
  markPendingTurnDispatch,
} from "../pendingTurnDispatch";
import { runComposerSendOnce } from "./composerSendOwnership";
import { waitForDraftThreadDispatchToSettle } from "./draftThreadDispatch";
import * as composerImageBlobStore from "./composerImageBlobStore";
import { createEmptyThreadDraft } from "../composerDraftDomain";
import type { PersistedComposerImageAttachment } from "../composerDraftStore";
import type { SidebarThreadSummary } from "../types";
import { dispatchKanbanDraftThread, dispatchKanbanDraftThreadAsGoal } from "./kanbanDispatch";

const nativeApiMocks = vi.hoisted(() => ({
  dispatchCommand: vi.fn(async (..._args: unknown[]) => undefined),
  cleanup: vi.fn(),
  stagedUploads: [] as Array<{
    files?: ReadonlyArray<unknown> | undefined;
    images?: ReadonlyArray<unknown> | undefined;
  }>,
  runWithDispatch: vi.fn(async (fn: (attachments: unknown) => Promise<unknown>) => {
    await fn([]);
  }),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand: nativeApiMocks.dispatchCommand,
    },
  }),
}));

vi.mock("../kanbanUiStore", () => ({
  useKanbanUiStore: {
    getState: () => ({
      markOptimisticDispatch: () => undefined,
      clearOptimisticDispatch: () => undefined,
    }),
  },
}));

vi.mock("../store", () => ({
  useStore: {
    getState: () => ({ projects: [], threads: [], sessions: [] }),
  },
}));

vi.mock("./threadCreatePromotion", () => ({
  promoteThreadCreate: vi.fn(async () => "created"),
}));

vi.mock("./threadBootstrap", () => ({
  resolveTerminalThreadCreationState: () => ({
    envMode: "local",
    branch: null,
    worktreePath: null,
    workingDirectory: null,
    lastKnownPr: null,
  }),
}));

vi.mock("./composerSend", async () => {
  const actual = await vi.importActual<typeof import("./composerSend")>("./composerSend");
  return {
    ...actual,
    stageUploadComposerAttachments: vi.fn(
      async (input: {
        files?: ReadonlyArray<unknown> | undefined;
        images?: ReadonlyArray<unknown> | undefined;
      }) => {
        nativeApiMocks.stagedUploads.push(input);
        return {
          runWithDispatch: nativeApiMocks.runWithDispatch,
          cleanup: nativeApiMocks.cleanup,
        };
      },
    ),
  };
});

function commandType(command: unknown): string {
  return (command as { type?: string }).type ?? "";
}

describe("kanbanDispatch failure preserves the prompt", () => {
  beforeEach(() => {
    resetComposerDraftStore();
    nativeApiMocks.dispatchCommand.mockReset();
    nativeApiMocks.runWithDispatch.mockClear();
  });

  it("accept-then-fail leaves the prompt intact and visible", async () => {
    const threadId = ThreadId.makeUnsafe("thread-fail-keep-1");
    const projectId = ProjectId.makeUnsafe("project-fail-keep");
    const prompt = "Goal prompt that must survive a turn failure";
    useComposerDraftStore.getState().setPrompt(threadId, prompt);
    nativeApiMocks.dispatchCommand.mockImplementation(async (...args: unknown[]) => {
      const [command] = args;
      // The goal command is accepted, then the provider fails the turn.
      if (commandType(command) === "thread.turn.start") {
        throw new Error("provider exploded");
      }
      return undefined;
    });

    const result = await dispatchKanbanDraftThreadAsGoal({
      threadId,
      projectId,
      thread: { id: threadId, projectId } as unknown as SidebarThreadSummary,
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });

    expect(result.kind).toBe("error");
    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.prompt).toBe(prompt);
    // Visible: the board derives the draft/unsent-prompt card from this snapshot.
    expect(buildKanbanComposerDraftSnapshot(draft ?? null)?.prompt).toBe(prompt);
  });
});

describe("kanbanDispatch board-vs-chat turn guard", () => {
  beforeEach(() => {
    resetComposerDraftStore();
    nativeApiMocks.dispatchCommand.mockReset();
    nativeApiMocks.runWithDispatch.mockClear();
  });

  it("defers a board dispatch while a chat send is already in flight", async () => {
    const threadId = ThreadId.makeUnsafe("thread-race-chat-1");
    const projectId = ProjectId.makeUnsafe("project-race-chat");
    const prompt = "Board prompt deferred to the in-flight chat send";
    useComposerDraftStore.getState().setPrompt(threadId, prompt);
    const thread = { id: threadId, projectId } as unknown as SidebarThreadSummary;

    // Simulate the chat send holding the dispatch guard: it arms the watchdog
    // marker and claims dispatch ownership for the turn-start RPC window.
    markPendingTurnDispatch(threadId);
    let releaseChat!: () => void;
    const chatSend = runComposerSendOnce(
      threadId,
      () =>
        new Promise<boolean>((resolve) => {
          releaseChat = () => resolve(true);
        }),
    );
    await Promise.resolve();
    try {
      const deferred = await dispatchKanbanDraftThread({
        threadId,
        projectId,
        thread,
        defaultProvider: "codex",
        assistantDeliveryMode: "buffered",
      });
      expect(deferred).toEqual({ kind: "dispatched", deferred: true });
      expect(
        nativeApiMocks.dispatchCommand.mock.calls.filter(
          ([command]) => commandType(command) === "thread.turn.start",
        ),
      ).toHaveLength(0);
      // The prompt is untouched so the chat send still owns it.
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(prompt);
    } finally {
      clearPendingTurnDispatch(threadId);
      releaseChat();
      await chatSend;
    }

    const retry = await dispatchKanbanDraftThread({
      threadId,
      projectId,
      thread,
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });
    expect(retry).toEqual({ kind: "dispatched" });
    expect(
      nativeApiMocks.dispatchCommand.mock.calls.filter(
        ([command]) => commandType(command) === "thread.turn.start",
      ),
    ).toHaveLength(1);
  });

  it("dispatches a follow-up drop while only the watchdog marker is armed", async () => {
    const threadId = ThreadId.makeUnsafe("thread-marker-no-owner");
    const projectId = ProjectId.makeUnsafe("project-marker-no-owner");
    const prompt = "Follow-up drafted while the watchdog marker is still live";
    useComposerDraftStore.getState().setPrompt(threadId, prompt);
    const thread = { id: threadId, projectId } as unknown as SidebarThreadSummary;

    // After a send's turn RPC settles, the watchdog marker stays armed until
    // stream ack or the age cap — but ownership is already released. A drop in
    // that window is a valid follow-up, not a duplicate, and must dispatch.
    markPendingTurnDispatch(threadId);
    try {
      const result = await dispatchKanbanDraftThread({
        threadId,
        projectId,
        thread,
        defaultProvider: "codex",
        assistantDeliveryMode: "buffered",
      });
      expect(result.kind).toBe("dispatched");
      expect(
        nativeApiMocks.dispatchCommand.mock.calls.filter(
          ([command]) => commandType(command) === "thread.turn.start",
        ),
      ).toHaveLength(1);
    } finally {
      clearPendingTurnDispatch(threadId);
    }
  });

  it("waitForDraftThreadDispatchToSettle waits out a board dispatch, then proceeds", async () => {
    const threadId = ThreadId.makeUnsafe("thread-settle-wait");
    const projectId = ProjectId.makeUnsafe("project-settle");
    useComposerDraftStore.getState().setPrompt(threadId, "Board dispatch settles first");
    const thread = { id: threadId, projectId } as unknown as SidebarThreadSummary;

    let releaseTurnStart: () => void = () => undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurnStart = resolve;
    });
    nativeApiMocks.dispatchCommand.mockImplementation(async (...args: unknown[]) => {
      const [command] = args;
      if (commandType(command) === "thread.turn.start") {
        await turnGate;
      }
      return undefined;
    });

    const boardPromise = dispatchKanbanDraftThread({
      threadId,
      projectId,
      thread,
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });

    let waiterDone = false;
    const waiter = waitForDraftThreadDispatchToSettle(threadId).then((settled) => {
      waiterDone = true;
      return settled;
    });
    // Still gated while the board dispatch is on the wire.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(waiterDone).toBe(false);

    releaseTurnStart();
    await boardPromise;
    const settled = await waiter;
    expect(waiterDone).toBe(true);
    // The waiter learns the board outcome so it can abort instead of sending a
    // duplicate turn.
    expect(settled).toEqual({ kind: "dispatched" });
  });

  it("waitForDraftThreadDispatchToSettle returns the settled board failure", async () => {
    const threadId = ThreadId.makeUnsafe("thread-settle-fail");
    const projectId = ProjectId.makeUnsafe("project-settle-fail");
    useComposerDraftStore.getState().setPrompt(threadId, "Failing board dispatch settles the wait");
    const thread = { id: threadId, projectId } as unknown as SidebarThreadSummary;

    nativeApiMocks.dispatchCommand.mockImplementation(async (...args: unknown[]) => {
      const [command] = args;
      if (commandType(command) === "thread.turn.start") {
        throw new Error("provider exploded");
      }
      return undefined;
    });

    const boardPromise = dispatchKanbanDraftThread({
      threadId,
      projectId,
      thread,
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });

    // The rejected dispatch resolves as its error result — never a rejection —
    // so the waiting chat send learns the board did not dispatch and proceeds.
    const [boardResult, settled] = await Promise.all([
      boardPromise,
      waitForDraftThreadDispatchToSettle(threadId),
    ]);
    expect(boardResult.kind).toBe("error");
    expect(settled).toEqual(boardResult);
  });

  it("keeps the pending-turn marker armed after a successful board dispatch", async () => {
    const threadId = ThreadId.makeUnsafe("thread-watchdog");
    const projectId = ProjectId.makeUnsafe("project-watchdog");
    useComposerDraftStore.getState().setPrompt(threadId, "Prompt.");
    const thread = { id: threadId, projectId } as unknown as SidebarThreadSummary;
    const result = await dispatchKanbanDraftThread({
      threadId,
      projectId,
      thread,
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });
    expect(result.kind).toBe("dispatched");
    // The turn may not have streamed yet; the watchdog stays armed until the
    // stream ack or the age cap, mirroring the composer-send path.
    expect(hasPendingTurnDispatch(threadId)).toBe(true);
    // Exclusion ended when the turn RPC settled: a later drop is a follow-up.
    clearPendingTurnDispatch(threadId);
  });
});

describe("kanbanDispatch persisted image attachments", () => {
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;

  beforeEach(() => {
    resetComposerDraftStore();
    nativeApiMocks.dispatchCommand.mockReset();
    nativeApiMocks.stagedUploads.length = 0;
    nativeApiMocks.runWithDispatch.mockClear();
    URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`);
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    vi.restoreAllMocks();
  });

  it.each(["accepted", "refused"] as const)(
    "hydrates saved images and releases temporary previews when dispatch is %s",
    async (outcome) => {
      const threadId = ThreadId.makeUnsafe("thread-persisted-image");
      const projectId = ProjectId.makeUnsafe("project-persisted-image");
      useComposerDraftStore.getState().setPrompt(threadId, "Prompt with a saved screenshot");
      const persisted: PersistedComposerImageAttachment = {
        id: "appsnap-saved-1",
        name: "saved-capture.png",
        mimeType: "image/png",
        sizeBytes: 4,
        blobKey: "thread-persisted-image:appsnap-saved-1",
      };
      useComposerDraftStore.setState((state) => {
        const draft = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: { ...draft, persistedAttachments: [persisted] },
          },
        };
      });
      const blobFile = new File(["png"], "saved-capture.png", { type: "image/png" });
      vi.spyOn(composerImageBlobStore, "readComposerImageBlob").mockResolvedValue(blobFile);

      if (outcome === "refused") {
        nativeApiMocks.dispatchCommand.mockRejectedValue(new Error("Turn refused"));
      }
      const result = await dispatchKanbanDraftThread({
        threadId,
        projectId,
        thread: { id: threadId, projectId } as unknown as SidebarThreadSummary,
        defaultProvider: "codex",
        assistantDeliveryMode: "buffered",
      });

      expect(result.kind).toBe(outcome === "accepted" ? "dispatched" : "error");
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:saved-capture.png");
      // The staged turn carries the hydrated image — it is not silently dropped
      // before the composer clear deletes its persisted blob.
      const stagedImages = nativeApiMocks.stagedUploads.at(-1)?.images as
        | ReadonlyArray<{ id: string; file: File }>
        | undefined;
      expect(stagedImages).toHaveLength(1);
      expect(stagedImages?.[0]?.id).toBe("appsnap-saved-1");
      expect(stagedImages?.[0]?.file).toBe(blobFile);
    },
  );
});

describe("kanbanDispatch oversized prompts and pasted text", () => {
  beforeEach(() => {
    resetComposerDraftStore();
    nativeApiMocks.dispatchCommand.mockReset();
    nativeApiMocks.stagedUploads.length = 0;
    nativeApiMocks.runWithDispatch.mockClear();
  });

  const threadSummary = (threadId: ThreadId, projectId: ProjectId) =>
    ({ id: threadId, projectId }) as unknown as SidebarThreadSummary;

  function dispatchedCommand<T>(type: string): T | undefined {
    return nativeApiMocks.dispatchCommand.mock.calls
      .map(([command]) => command as { type?: string })
      .filter((command) => command.type === type)
      .at(-1) as T | undefined;
  }

  function lastStagedFile(): { name: string; file: File } | undefined {
    const staged = nativeApiMocks.stagedUploads.at(-1);
    return staged?.files?.at(-1) as { name: string; file: File } | undefined;
  }

  it("converts an oversized prompt into a managed file attachment", async () => {
    const threadId = ThreadId.makeUnsafe("thread-big-prompt-file");
    const projectId = ProjectId.makeUnsafe("project-big-prompt-file");
    const prompt = `Big task. ${"x".repeat(1500)}`;
    useComposerDraftStore.getState().setPrompt(threadId, prompt);

    const result = await dispatchKanbanDraftThread({
      threadId,
      projectId,
      thread: threadSummary(threadId, projectId),
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });

    expect(result.kind).toBe("dispatched");
    const turnStart = dispatchedCommand<{ message: { text: string } }>("thread.turn.start");
    expect(turnStart?.message.text).toMatch(/^Read this file: synara-prompt-.+\.md$/);
    const staged = lastStagedFile();
    expect(staged?.name).toMatch(/^synara-prompt-.+\.md$/);
    await expect(staged?.file.text() ?? Promise.resolve("")).resolves.toContain(prompt);
  });

  it("dispatches a draft made only of a large pasted text", async () => {
    const threadId = ThreadId.makeUnsafe("thread-pasted-only");
    const projectId = ProjectId.makeUnsafe("project-pasted-only");
    useComposerDraftStore.getState().addPastedTexts(threadId, [
      createPastedTextDraft({
        id: "pasted-1",
        createdAt: new Date().toISOString(),
        text: "y".repeat(5000),
      }),
    ]);

    const result = await dispatchKanbanDraftThread({
      threadId,
      projectId,
      thread: threadSummary(threadId, projectId),
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });

    expect(result.kind).toBe("dispatched");
    const turnStart = dispatchedCommand<{ message: { text: string } }>("thread.turn.start");
    expect(turnStart?.message.text).toMatch(/^Read this file: /);
    await expect(lastStagedFile()?.file.text() ?? Promise.resolve("")).resolves.toContain(
      "<pasted_text>",
    );
  });

  it("sends the full oversized goal text untruncated for the server to materialize", async () => {
    const threadId = ThreadId.makeUnsafe("thread-big-goal");
    const projectId = ProjectId.makeUnsafe("project-big-goal");
    const prompt = `g${"o".repeat(5000)}`;
    useComposerDraftStore.getState().setPrompt(threadId, prompt);

    const result = await dispatchKanbanDraftThreadAsGoal({
      threadId,
      projectId,
      thread: threadSummary(threadId, projectId),
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });

    expect(result.kind).toBe("dispatched");
    const metaUpdate = dispatchedCommand<{ goal?: string }>("thread.meta.update");
    expect(metaUpdate?.goal).toBe(prompt);
  });

  it("leaves a small prompt inline", async () => {
    const threadId = ThreadId.makeUnsafe("thread-small-prompt");
    const projectId = ProjectId.makeUnsafe("project-small-prompt");
    useComposerDraftStore.getState().setPrompt(threadId, "short prompt");

    const result = await dispatchKanbanDraftThread({
      threadId,
      projectId,
      thread: threadSummary(threadId, projectId),
      defaultProvider: "codex",
      assistantDeliveryMode: "buffered",
    });

    expect(result.kind).toBe("dispatched");
    const turnStart = dispatchedCommand<{ message: { text: string } }>("thread.turn.start");
    expect(turnStart?.message.text).toBe("short prompt");
    expect(lastStagedFile()).toBeUndefined();
  });
});
