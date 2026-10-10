import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandId,
  ProjectId,
  ThreadId,
  type ClientOrchestrationCommand,
  type NativeApi,
} from "@synara/contracts";

import {
  useComposerDraftStore,
  markPromotedDraftThreads,
  finalizePromotedDraftThreads,
  isPromotedThreadRoutePending,
  readPromotedThreadRouteMarkers,
  PROMOTED_THREAD_ROUTE_GRACE_MS,
} from "../composerDraftStore";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import {
  promoteThreadCreate,
  waitForPromotedThreadRouteReady,
  isThreadCreateInFlight,
} from "./threadCreatePromotion";

const initialStoreState = useStore.getState();
const initialComposerDraftState = useComposerDraftStore.getState();

afterEach(() => {
  useStore.setState(initialStoreState, true);
  useComposerDraftStore.setState(initialComposerDraftState, true);
});

function makeApi(input: {
  dispatchCommand: ReturnType<typeof vi.fn>;
  getShellSnapshot?: ReturnType<typeof vi.fn>;
}): NativeApi {
  return {
    orchestration: {
      dispatchCommand: input.dispatchCommand,
      getShellSnapshot: input.getShellSnapshot ?? vi.fn(),
    },
  } as unknown as NativeApi;
}

function makeThreadCreateCommand(threadId = "thread-promote") {
  return {
    type: "thread.create",
    commandId: CommandId.makeUnsafe(`cmd-${threadId}`),
    threadId: ThreadId.makeUnsafe(threadId),
    projectId: ProjectId.makeUnsafe("project-promote"),
    title: "Promoted thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    createdAt: "2026-05-06T20:00:00.000Z",
  } satisfies Extract<ClientOrchestrationCommand, { type: "thread.create" }>;
}

describe("threadCreatePromotion", () => {
  it("cleans its grace timer when an in-flight promotion rejects", async () => {
    vi.useFakeTimers();
    try {
      let rejectDispatch!: (error: Error) => void;
      const command = makeThreadCreateCommand("thread-rejected-route");
      const promotion = promoteThreadCreate(
        command,
        makeApi({
          dispatchCommand: vi.fn(
            () =>
              new Promise((_resolve, reject) => {
                rejectDispatch = reject;
              }),
          ),
        }),
      );
      const failed = expect(promotion).rejects.toThrow("rejected");
      expect(isThreadCreateInFlight(command.threadId)).toBe(true);
      const wait = waitForPromotedThreadRouteReady(command.threadId);
      rejectDispatch(new Error("rejected"));
      await failed;
      await wait;
      expect(isThreadCreateInFlight(command.threadId)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not delay a never-promoted route", async () => {
    vi.useFakeTimers();
    try {
      await waitForPromotedThreadRouteReady(ThreadId.makeUnsafe("never-promoted"));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds route protection after the draft disappears and returns isolated marker snapshots", async () => {
    vi.useFakeTimers();
    try {
      const threadId = ThreadId.makeUnsafe("thread-marker-expiry");
      useComposerDraftStore
        .getState()
        .setProjectDraftThreadId(ProjectId.makeUnsafe("project-marker"), threadId);
      markPromotedDraftThreads(new Set([threadId]));
      finalizePromotedDraftThreads(new Set([threadId]));
      expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
      expect(isPromotedThreadRoutePending(threadId)).toBe(true);
      const snapshot = readPromotedThreadRouteMarkers();
      (snapshot as Map<ThreadId, unknown>).clear();
      expect(isPromotedThreadRoutePending(threadId)).toBe(true);
      const wait = waitForPromotedThreadRouteReady(threadId);
      await vi.advanceTimersByTimeAsync(PROMOTED_THREAD_ROUTE_GRACE_MS + 1);
      await wait;
      expect(isPromotedThreadRoutePending(threadId)).toBe(false);
      expect(readPromotedThreadRouteMarkers().has(threadId)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("joins concurrent promotions for the same thread id", async () => {
    let resolveDispatch: (() => void) | null = null;
    const dispatchCommand = vi.fn(
      () =>
        new Promise<{ sequence: number }>((resolve) => {
          resolveDispatch = () => resolve({ sequence: 1 });
        }),
    );
    const api = makeApi({ dispatchCommand });
    const command = makeThreadCreateCommand("thread-concurrent");

    const first = promoteThreadCreate(command, api);
    const second = promoteThreadCreate(
      { ...command, commandId: CommandId.makeUnsafe("cmd-thread-concurrent-second") },
      api,
    );
    expect(resolveDispatch).not.toBeNull();
    (resolveDispatch as unknown as () => void)();

    await expect(first).resolves.toBe("created");
    await expect(second).resolves.toBe("exists");
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
  });

  it("marks the draft as promoted when the thread already exists locally", async () => {
    const threadId = ThreadId.makeUnsafe("thread-existing-local");
    const projectId = ProjectId.makeUnsafe("project-promote");
    useComposerDraftStore.getState().setProjectDraftThreadId(projectId, threadId);
    useStore.getState().syncServerShellSnapshot({
      snapshotSequence: 1,
      spaces: [],
      projects: [
        {
          id: projectId,
          kind: "project",
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-05-06T20:00:00.000Z",
          updatedAt: "2026-05-06T20:00:00.000Z",
        },
      ],
      threads: [
        {
          id: threadId,
          projectId,
          title: "Promoted thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          envMode: "local",
          branch: null,
          worktreePath: null,
          associatedWorktreePath: null,
          associatedWorktreeBranch: null,
          associatedWorktreeRef: null,
          createBranchFlowCompleted: false,
          parentThreadId: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          forkSourceThreadId: null,
          sidechatSourceThreadId: null,
          lastKnownPr: null,
          latestTurn: null,
          createdAt: "2026-05-06T20:00:00.000Z",
          updatedAt: "2026-05-06T20:00:00.000Z",
          archivedAt: null,
          handoff: null,
          session: null,
        },
      ],
      updatedAt: "2026-05-06T20:00:00.000Z",
    });
    const api = makeApi({ dispatchCommand: vi.fn() });

    await expect(promoteThreadCreate(makeThreadCreateCommand(threadId), api)).resolves.toBe(
      "exists",
    );

    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.promotedTo).toBe(threadId);
  });

  it("recovers duplicate promotions by syncing the shell snapshot", async () => {
    const threadId = ThreadId.makeUnsafe("thread-duplicate-recovered");
    const projectId = ProjectId.makeUnsafe("project-promote");
    const dispatchCommand = vi.fn(() =>
      Promise.reject(
        new Error(
          `Orchestration command invariant failed (thread.create): Thread '${threadId}' already exists and cannot be created twice.`,
        ),
      ),
    );
    const getShellSnapshot = vi.fn(() =>
      Promise.resolve({
        snapshotSequence: 1,
        spaces: [],
        projects: [
          {
            id: projectId,
            kind: "project",
            title: "Project",
            workspaceRoot: "/tmp/project",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-05-06T20:00:00.000Z",
            updatedAt: "2026-05-06T20:00:00.000Z",
          },
        ],
        threads: [
          {
            id: threadId,
            projectId,
            title: "Promoted thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            envMode: "local",
            branch: null,
            worktreePath: null,
            associatedWorktreePath: null,
            associatedWorktreeBranch: null,
            associatedWorktreeRef: null,
            createBranchFlowCompleted: false,
            parentThreadId: null,
            subagentAgentId: null,
            subagentNickname: null,
            subagentRole: null,
            forkSourceThreadId: null,
            sidechatSourceThreadId: null,
            lastKnownPr: null,
            latestTurn: null,
            createdAt: "2026-05-06T20:00:00.000Z",
            updatedAt: "2026-05-06T20:00:00.000Z",
            archivedAt: null,
            handoff: null,
            session: null,
          },
        ],
        updatedAt: "2026-05-06T20:00:00.000Z",
      }),
    );
    const api = makeApi({ dispatchCommand, getShellSnapshot });

    await expect(promoteThreadCreate(makeThreadCreateCommand(threadId), api)).resolves.toBe(
      "exists",
    );
    expect(getShellSnapshot).toHaveBeenCalledTimes(1);
    expect(getThreadFromState(useStore.getState(), threadId)?.id).toBe(threadId);
  });
});
