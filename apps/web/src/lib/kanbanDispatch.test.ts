import { ProjectId, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useComposerDraftStore } from "../composerDraftStore";
import { resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import { buildKanbanComposerDraftSnapshot } from "../components/kanban/kanban.logic";
import { clearPendingTurnDispatch, markPendingTurnDispatch } from "../pendingTurnDispatch";
import type { SidebarThreadSummary } from "../types";
import {
  dispatchKanbanDraftThread,
  dispatchKanbanDraftThreadAsGoal,
  isKanbanDispatchInFlight,
  waitForKanbanDispatchToSettle,
} from "./kanbanDispatch";

const nativeApiMocks = vi.hoisted(() => ({
  dispatchCommand: vi.fn(async (..._args: unknown[]) => undefined),
  cleanup: vi.fn(),
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
    stageUploadComposerAttachments: vi.fn(async () => ({
      runWithDispatch: nativeApiMocks.runWithDispatch,
      cleanup: nativeApiMocks.cleanup,
    })),
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

    // Simulate the chat send holding the shared turn guard.
    markPendingTurnDispatch(threadId);
    try {
      const deferred = await dispatchKanbanDraftThread({
        threadId,
        projectId,
        thread,
        defaultProvider: "codex",
        assistantDeliveryMode: "buffered",
      });
      expect(deferred).toEqual({ kind: "dispatched" });
      expect(
        nativeApiMocks.dispatchCommand.mock.calls.filter(
          ([command]) => commandType(command) === "thread.turn.start",
        ),
      ).toHaveLength(0);
      // The prompt is untouched so the chat send still owns it.
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(prompt);
    } finally {
      clearPendingTurnDispatch(threadId);
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

  it("waitForKanbanDispatchToSettle waits out a board dispatch, then proceeds", async () => {
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
    expect(isKanbanDispatchInFlight(threadId)).toBe(true);

    let waiterDone = false;
    const waiter = waitForKanbanDispatchToSettle(threadId, 1_000).then(() => {
      waiterDone = true;
    });
    // Still gated while the board dispatch is on the wire.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(waiterDone).toBe(false);

    releaseTurnStart();
    await boardPromise;
    await waiter;
    expect(waiterDone).toBe(true);
    expect(isKanbanDispatchInFlight(threadId)).toBe(false);
  });

  it("waitForKanbanDispatchToSettle fails open on timeout", async () => {
    const threadId = ThreadId.makeUnsafe("thread-settle-timeout");
    const projectId = ProjectId.makeUnsafe("project-settle-timeout");
    useComposerDraftStore.getState().setPrompt(threadId, "Stuck board dispatch never locks chat");
    const thread = { id: threadId, projectId } as unknown as SidebarThreadSummary;

    // Never release: the waiter must give up and let the chat send proceed.
    nativeApiMocks.dispatchCommand.mockImplementation(async (...args: unknown[]) => {
      const [command] = args;
      if (commandType(command) === "thread.turn.start") {
        await new Promise(() => undefined);
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
    await expect(waitForKanbanDispatchToSettle(threadId, 60)).resolves.toBeUndefined();
    // Board side still owns the guard; only the waiter gave up.
    expect(isKanbanDispatchInFlight(threadId)).toBe(true);
    void boardPromise;
  });
});
