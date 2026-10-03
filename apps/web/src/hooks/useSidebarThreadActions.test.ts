// FILE: useSidebarThreadActions.test.ts
// Purpose: Covers Sidebar pin races, archive/Done navigation, undo, and batch deletion.
// Layer: Web hook tests

import { ProjectId, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reactHarness = vi.hoisted(() => {
  interface HookSlot {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
  }
  let slots: HookSlot[] = [];
  let cursor = 0;
  const nextSlot = () => {
    const slot = (slots[cursor] ??= {});
    cursor += 1;
    return slot;
  };
  // Vitest requires helpers referenced by a hoisted factory to stay inside that factory.
  // oxlint-disable-next-line consistent-function-scoping
  const depsEqual = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      slots = [];
      cursor = 0;
    },
    useCallback<T>(callback: T, deps: readonly unknown[]): T {
      const slot = nextSlot();
      if (!depsEqual(slot.deps, deps)) {
        slot.deps = deps;
        slot.value = callback;
      }
      return slot.value as T;
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const slot = nextSlot();
      if (depsEqual(slot.deps, deps)) return;
      slot.cleanup?.();
      slot.deps = deps;
      slot.cleanup = effect() ?? undefined;
    },
    useMemo<T>(factory: () => T, deps: readonly unknown[]): T {
      const slot = nextSlot();
      if (!depsEqual(slot.deps, deps)) {
        slot.deps = deps;
        slot.value = factory();
      }
      return slot.value as T;
    },
    useRef<T>(value: T) {
      const slot = nextSlot();
      if (!("value" in slot)) slot.value = { current: value };
      return slot.value as { current: T };
    },
    useState<T>(initialValue: T | (() => T)) {
      const slot = nextSlot();
      if (!("value" in slot)) {
        slot.value =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue = (next: T | ((current: T) => T)) => {
        slot.value =
          typeof next === "function" ? (next as (current: T) => T)(slot.value as T) : next;
      };
      return [slot.value as T, setValue] as const;
    },
  };
});

const harness = vi.hoisted(() => ({
  pinnedThreadIds: [] as string[],
  pinThread: vi.fn(),
  unpinThread: vi.fn(),
  prunePinnedThreads: vi.fn(),
  dispatchCommand: vi.fn(),
  confirm: vi.fn(),
  archiveThread: vi.fn(),
  releaseArchivedWorktree: vi.fn(),
  unarchiveThread: vi.fn(),
  alreadyUnarchived: false,
  activeThreadDelete: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  removeFromSelection: vi.fn(),
  reconcileDeletedThreads: vi.fn(),
  clearDraftThread: vi.fn(),
  clearProjectDraftThreadById: vi.fn(),
  removeThreadFromSplitViews: vi.fn(),
  clearTemporaryThread: vi.fn(),
  clearTerminalState: vi.fn(),
  handleNewChat: vi.fn(),
  removeDeletedThreadFromClientState: vi.fn(),
  resolveSplitViewPaneIdForThread: vi.fn(),
  resolveSplitViewFocusedThreadId: vi.fn(),
  splitViewsById: {} as Record<string, unknown>,
  shellSnapshotSequence: 0,
}));

vi.mock("react", () => ({
  useCallback: reactHarness.useCallback,
  useEffect: reactHarness.useEffect,
  useMemo: reactHarness.useMemo,
  useRef: reactHarness.useRef,
  useState: reactHarness.useState,
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutateAsync: vi.fn() }),
  useQueryClient: () => ({}),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => harness.navigate }));
vi.mock("../lib/gitReactQuery", () => ({ gitRemoveWorktreeMutationOptions: () => ({}) }));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (selector: (state: unknown) => unknown) =>
    selector({
      clearDraftThread: harness.clearDraftThread,
      clearProjectDraftThreadById: harness.clearProjectDraftThreadById,
    }),
}));
vi.mock("../pinnedThreadsStore", () => ({
  usePinnedThreadsStore: (selector: (state: unknown) => unknown) =>
    selector({
      pinnedThreadIds: harness.pinnedThreadIds,
      pinThread: harness.pinThread,
      unpinThread: harness.unpinThread,
      prunePinnedThreads: harness.prunePinnedThreads,
    }),
}));
vi.mock("../splitViewStore", () => {
  const useSplitViewStore = (selector: (state: unknown) => unknown) =>
    selector({ removeThreadFromSplitViews: harness.removeThreadFromSplitViews });
  useSplitViewStore.getState = () => ({ splitViewsById: harness.splitViewsById });
  return {
    useSplitViewStore,
    resolveSplitViewFocusedThreadId: harness.resolveSplitViewFocusedThreadId,
    resolveSplitViewPaneIdForThread: harness.resolveSplitViewPaneIdForThread,
  };
});
vi.mock("../temporaryThreadStore", () => ({
  useTemporaryThreadStore: (selector: (state: unknown) => unknown) =>
    selector({ clearTemporaryThread: harness.clearTemporaryThread }),
}));
vi.mock("../threadSelectionStore", () => ({
  useThreadSelectionStore: (selector: (state: unknown) => unknown) =>
    selector({ removeFromSelection: harness.removeFromSelection }),
}));
vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: { dispatchCommand: harness.dispatchCommand },
    dialogs: { confirm: harness.confirm },
  }),
}));
vi.mock("../lib/threadArchive", () => ({
  archiveThreadFromClient: harness.archiveThread,
  unarchiveThreadFromClient: harness.unarchiveThread,
  isThreadAlreadyUnarchivedError: () => harness.alreadyUnarchived,
}));
vi.mock("../lib/archiveThreadWorktreeCleanup", () => ({
  releaseOrphanedWorktreeAfterArchive: harness.releaseArchivedWorktree,
}));
vi.mock("../lib/activeThreadDelete", () => ({
  deleteActiveThreadFromClient: harness.activeThreadDelete,
}));
vi.mock("../lib/deletedThreadClientReconciliation", () => ({
  reconcileDeletedThreadsFromClient: harness.reconcileDeletedThreads,
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: harness.toast } }));
vi.mock("../store", () => {
  const useStore = (selector: (state: unknown) => unknown) =>
    selector({ shellSnapshotSequence: harness.shellSnapshotSequence });
  useStore.getState = () => ({
    shellSnapshotSequence: harness.shellSnapshotSequence,
    removeDeletedThreadFromClientState: harness.removeDeletedThreadFromClientState,
  });
  useStore.subscribe = () => () => {};
  return { useStore };
});
vi.mock("../threadDerivation", () => ({
  getThreadFromState: (_state: unknown, threadId: ThreadId) => ({ id: threadId }),
}));

import type { Project, SidebarThreadSummary } from "../types";
import { useSidebarThreadActions } from "./useSidebarThreadActions";

const PROJECT_ID = ProjectId.makeUnsafe("project-actions");
const THREAD_ID = ThreadId.makeUnsafe("thread-actions");
const FALLBACK_ID = ThreadId.makeUnsafe("thread-fallback");
const PROJECT = {
  id: PROJECT_ID,
  kind: "project",
  name: "Actions",
  remoteName: "Actions",
  folderName: "actions",
  localName: null,
  cwd: "/repo",
  defaultModelSelection: null,
  expanded: true,
  scripts: [],
} satisfies Project;

function makeThread(id: ThreadId, overrides: Partial<SidebarThreadSummary> = {}) {
  return {
    id,
    projectId: PROJECT_ID,
    title: String(id),
    modelSelection: { provider: "codex", model: "gpt-5.6" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: id === THREAD_ID ? "2026-07-20T00:00:00.000Z" : "2026-07-19T00:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
    ...overrides,
  } as SidebarThreadSummary;
}

let sidebarThreads: SidebarThreadSummary[];

function render(
  overrides: {
    activeSplitView?: Parameters<typeof useSidebarThreadActions>[0]["activeSplitView"];
    routeSplitViewId?: string | null;
    routeThreadId?: ThreadId | null;
    threadsHydrated?: boolean;
    archiveDeletesOrphanedWorktree?: boolean;
    sidebarTreeThreads?: readonly SidebarThreadSummary[];
  } = {},
) {
  reactHarness.beginRender();
  return useSidebarThreadActions({
    activeSplitView: overrides.activeSplitView ?? null,
    appSettings: {
      archiveDeletesOrphanedWorktree: overrides.archiveDeletesOrphanedWorktree ?? false,
      confirmThreadArchive: false,
      confirmThreadDelete: false,
      sidebarThreadSortOrder: "updated_at",
    },
    clearTerminalState: harness.clearTerminalState,
    handleNewChat: harness.handleNewChat,
    projectById: new Map([[PROJECT_ID, PROJECT]]),
    routeSplitViewId: overrides.routeSplitViewId ?? null,
    routeThreadId: overrides.routeThreadId ?? null,
    sidebarThreads,
    sidebarTreeThreads: overrides.sidebarTreeThreads ?? sidebarThreads,
    sidebarThreadSummaryById: Object.fromEntries(
      sidebarThreads.map((thread) => [thread.id, thread]),
    ),
    threadsHydrated: overrides.threadsHydrated ?? false,
  });
}

function deferWindowTimers() {
  vi.stubGlobal("window", {
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
  });
}

async function flushActionResponses() {
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
}

beforeEach(() => {
  reactHarness.reset();
  sidebarThreads = [makeThread(THREAD_ID), makeThread(FALLBACK_ID)];
  harness.pinnedThreadIds = [];
  harness.shellSnapshotSequence = 0;
  harness.alreadyUnarchived = false;
  harness.splitViewsById = {};
  for (const mock of [
    harness.pinThread,
    harness.unpinThread,
    harness.prunePinnedThreads,
    harness.dispatchCommand,
    harness.confirm,
    harness.archiveThread,
    harness.releaseArchivedWorktree,
    harness.unarchiveThread,
    harness.activeThreadDelete,
    harness.navigate,
    harness.toast,
    harness.removeFromSelection,
    harness.reconcileDeletedThreads,
    harness.clearDraftThread,
    harness.clearProjectDraftThreadById,
    harness.removeThreadFromSplitViews,
    harness.clearTemporaryThread,
    harness.clearTerminalState,
    harness.handleNewChat,
    harness.resolveSplitViewPaneIdForThread,
    harness.resolveSplitViewFocusedThreadId,
  ]) {
    mock.mockReset();
  }
  harness.pinThread.mockImplementation((threadId: ThreadId) => {
    if (!harness.pinnedThreadIds.includes(threadId)) harness.pinnedThreadIds.unshift(threadId);
  });
  harness.unpinThread.mockImplementation((threadId: ThreadId) => {
    harness.pinnedThreadIds = harness.pinnedThreadIds.filter((id) => id !== threadId);
  });
  harness.dispatchCommand.mockResolvedValue({ sequence: 1 });
  harness.archiveThread.mockResolvedValue(1);
  harness.releaseArchivedWorktree.mockResolvedValue("removed");
  harness.unarchiveThread.mockResolvedValue(undefined);
  harness.confirm.mockResolvedValue(true);
  harness.handleNewChat.mockResolvedValue({ ok: true });
  harness.activeThreadDelete.mockImplementation(async (input: unknown) => {
    const action = input as {
      prepareForDelete?: () => unknown;
      onDeleted: (input: {
        thread: { id: ThreadId; projectId: ProjectId };
        prepared?: unknown;
      }) => void;
    };
    const prepared = action.prepareForDelete?.();
    action.onDeleted({ thread: { id: THREAD_ID, projectId: PROJECT_ID }, prepared });
  });
  vi.stubGlobal("window", {
    setTimeout: (callback: () => void) => {
      callback();
      return 1;
    },
    clearTimeout: vi.fn(),
  });
});

describe("useSidebarThreadActions", () => {
  it("uses elapsed durations and tomorrow at 9am in the user's local calendar", async () => {
    const now = new Date(2026, 9, 2, 23, 45);
    const clock = vi.spyOn(Date, "now").mockReturnValue(now.getTime());
    try {
      const controller = render();
      controller.snoozeThread(THREAD_ID, 30);
      controller.snoozeThread(THREAD_ID, 60);
      controller.snoozeThread(THREAD_ID, 120);
      controller.snoozeThread(THREAD_ID, "tomorrow");
      await vi.waitFor(() => expect(harness.dispatchCommand).toHaveBeenCalledTimes(4));
      expect(harness.dispatchCommand.mock.calls.map(([command]) => command.snoozedUntil)).toEqual([
        new Date(2026, 9, 3, 0, 15).toISOString(),
        new Date(2026, 9, 3, 0, 45).toISOString(),
        new Date(2026, 9, 3, 1, 45).toISOString(),
        new Date(2026, 9, 3, 9, 0).toISOString(),
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("schedules and cancels snooze through thread metadata without navigating", async () => {
    const controller = render();
    controller.setThreadSnoozedUntil(THREAD_ID, "2026-10-02T12:00:00.000Z");
    await vi.waitFor(() =>
      expect(harness.dispatchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.meta.update",
          threadId: THREAD_ID,
          snoozedUntil: "2026-10-02T12:00:00.000Z",
        }),
      ),
    );
    controller.setThreadSnoozedUntil(THREAD_ID, null);
    await vi.waitFor(() =>
      expect(harness.dispatchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.meta.update",
          threadId: THREAD_ID,
          snoozedUntil: null,
        }),
      ),
    );
    expect(harness.navigate).not.toHaveBeenCalled();
  });

  it("reports snooze failures without hiding the server-confirmed row", async () => {
    harness.dispatchCommand.mockRejectedValueOnce(new Error("offline"));
    render().setThreadSnoozedUntil(THREAD_ID, "2026-10-02T12:00:00.000Z");
    await vi.waitFor(() =>
      expect(harness.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })),
    );
    expect(sidebarThreads[0]?.snoozedUntil ?? null).toBeNull();
  });

  it("leaves the focused chat only after snooze is confirmed and offers undo", async () => {
    let confirm!: (value: { sequence: number }) => void;
    harness.dispatchCommand.mockReturnValueOnce(
      new Promise((resolve) => {
        confirm = resolve;
      }),
    );
    const controller = render({ routeThreadId: THREAD_ID });
    controller.snoozeThread(THREAD_ID, 30);
    expect(harness.navigate).not.toHaveBeenCalled();
    confirm({ sequence: 1 });
    await vi.waitFor(() =>
      expect(harness.navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { threadId: FALLBACK_ID },
        }),
      ),
    );
    const undoToast = harness.toast.mock.calls.at(-1)?.[0] as {
      data: { archiveUndo: { message: string; onUndo: () => Promise<boolean> } };
    };
    expect(undoToast.data.archiveUndo.message).toMatch(/^Snoozed until /);
    await expect(undoToast.data.archiveUndo.onUndo()).resolves.toBe(true);
    expect(harness.dispatchCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: THREAD_ID, snoozedUntil: null }),
    );
  });

  it("does not change focus after a failed snooze or a route change during confirmation", async () => {
    harness.dispatchCommand.mockRejectedValueOnce(new Error("offline"));
    const controller = render({ routeThreadId: THREAD_ID });
    controller.snoozeThread(THREAD_ID, 30);
    await vi.waitFor(() =>
      expect(harness.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })),
    );
    expect(harness.navigate).not.toHaveBeenCalled();
    let confirm!: (value: { sequence: number }) => void;
    harness.dispatchCommand.mockReturnValueOnce(
      new Promise((resolve) => {
        confirm = resolve;
      }),
    );
    controller.snoozeThread(THREAD_ID, 30);
    render({ routeThreadId: FALLBACK_ID });
    confirm({ sequence: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.navigate).not.toHaveBeenCalled();
  });

  it.each(["open-split", "leave-and-return"] as const)(
    "keeps newer navigation when snooze confirmation follows %s",
    async (navigation) => {
      let confirm!: (value: { sequence: number }) => void;
      harness.dispatchCommand.mockReturnValueOnce(
        new Promise((resolve) => {
          confirm = resolve;
        }),
      );
      const controller = render({ routeThreadId: THREAD_ID });
      controller.snoozeThread(THREAD_ID, 30);
      if (navigation === "open-split") {
        render({
          routeThreadId: THREAD_ID,
          activeSplitView: { id: "split-snooze" } as never,
          routeSplitViewId: "split-snooze",
        });
      } else {
        render({ routeThreadId: FALLBACK_ID });
        render({ routeThreadId: THREAD_ID });
      }
      confirm({ sequence: 1 });
      await flushActionResponses();

      expect(harness.navigate).not.toHaveBeenCalled();
      expect(harness.handleNewChat).not.toHaveBeenCalled();
      expect(harness.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ archiveUndo: expect.any(Object) }),
        }),
      );
    },
  );

  it("returns focus to an ordinary visible chat rather than a dock chat or subagent", async () => {
    const dockChat = makeThread(ThreadId.makeUnsafe("dock-chat"), {
      lastVisitedAt: "2026-10-03T12:00:00.000Z",
    });
    const child = makeThread(ThreadId.makeUnsafe("visible-subagent"), {
      parentThreadId: FALLBACK_ID,
      lastVisitedAt: "2026-10-03T11:00:00.000Z",
    });
    const focused = makeThread(THREAD_ID);
    const fallback = makeThread(FALLBACK_ID);
    sidebarThreads = [focused, fallback, dockChat, child];
    render({
      routeThreadId: THREAD_ID,
      sidebarTreeThreads: [focused, fallback, child],
    }).snoozeThread(THREAD_ID, 30);
    await flushActionResponses();

    expect(harness.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { threadId: FALLBACK_ID } }),
    );
  });

  it("opens a new chat if all other chats are snoozed", async () => {
    sidebarThreads = [
      makeThread(THREAD_ID),
      makeThread(FALLBACK_ID, { snoozedUntil: "2026-10-03T12:00:00Z" }),
    ];
    render({ routeThreadId: THREAD_ID }).snoozeThread(THREAD_ID, 30);
    await vi.waitFor(() => expect(harness.handleNewChat).toHaveBeenCalled());
    expect(harness.navigate).not.toHaveBeenCalled();
  });

  it("pins optimistically and dispatches thread metadata", async () => {
    let controller = render();

    controller.toggleThreadPinned(THREAD_ID);
    await vi.waitFor(() => expect(harness.dispatchCommand).toHaveBeenCalled());
    controller = render();

    expect(harness.pinThread).toHaveBeenCalledWith(THREAD_ID);
    expect(harness.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.meta.update",
        threadId: THREAD_ID,
        isPinned: true,
      }),
    );
    expect(controller.pinnedThreadIdSet.has(THREAD_ID)).toBe(true);
  });

  it("rolls the latest failed pin back to confirmed server state", async () => {
    harness.dispatchCommand.mockRejectedValue(new Error("pin rejected"));

    render().toggleThreadPinned(THREAD_ID);
    await vi.waitFor(() => expect(harness.toast).toHaveBeenCalled());

    expect(harness.pinThread).toHaveBeenCalledWith(THREAD_ID);
    expect(harness.unpinThread).toHaveBeenCalledWith(THREAD_ID);
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Unable to pin thread" }),
    );
  });

  it("does not let an older failed pin roll back a newer click", async () => {
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: () => void;
    harness.dispatchCommand
      .mockImplementationOnce(() => new Promise((_, reject) => (rejectFirst = reject)))
      .mockImplementationOnce(() => new Promise<void>((resolve) => (resolveSecond = resolve)));
    let controller = render();

    controller.toggleThreadPinned(THREAD_ID);
    await vi.waitFor(() => expect(harness.dispatchCommand).toHaveBeenCalledTimes(1));
    controller = render();
    controller.toggleThreadPinned(THREAD_ID);
    await vi.waitFor(() => expect(harness.dispatchCommand).toHaveBeenCalledTimes(2));
    resolveSecond();
    rejectFirst(new Error("stale failure"));
    await vi.waitFor(() => expect(harness.unpinThread).toHaveBeenCalledTimes(1));

    expect(harness.pinThread).toHaveBeenCalledTimes(1);
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it("waits for hydration and deduplicates an in-flight legacy pin migration", async () => {
    harness.pinnedThreadIds = [THREAD_ID];
    let resolveMigration!: () => void;
    harness.dispatchCommand.mockImplementation(
      () => new Promise<void>((resolve) => (resolveMigration = resolve)),
    );

    render({ threadsHydrated: false });
    expect(harness.dispatchCommand).not.toHaveBeenCalled();
    render({ threadsHydrated: true });
    sidebarThreads = [...sidebarThreads];
    render({ threadsHydrated: true });
    expect(harness.dispatchCommand).toHaveBeenCalledTimes(1);
    resolveMigration();
  });

  it("serializes archives and navigates the active thread to its fallback", async () => {
    let releaseArchive!: () => void;
    harness.archiveThread.mockImplementation(
      () => new Promise<void>((resolve) => (releaseArchive = resolve)),
    );
    const controller = render({ routeThreadId: THREAD_ID });

    const first = controller.archiveThread(THREAD_ID);
    const duplicate = controller.archiveThread(THREAD_ID);
    await expect(duplicate).resolves.toBe(false);
    releaseArchive();
    await expect(first).resolves.toBe(true);

    expect(harness.archiveThread).toHaveBeenCalledOnce();
    expect(harness.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { threadId: FALLBACK_ID }, replace: true }),
    );
  });

  it("restores the saved chat draft when archiving the last thread leaves no fallback", async () => {
    sidebarThreads = [makeThread(THREAD_ID)];

    await expect(render({ routeThreadId: THREAD_ID }).archiveThread(THREAD_ID)).resolves.toBe(true);

    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.handleNewChat).toHaveBeenCalledWith();
  });

  it("opens the most recent chat after the focused thread is marked done", async () => {
    deferWindowTimers();
    const controller = render({ routeThreadId: THREAD_ID });

    controller.setThreadSettledWithToast(THREAD_ID, true);
    await flushActionResponses();

    expect(harness.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { threadId: FALLBACK_ID }, replace: true }),
    );
  });

  it("keeps the focused chat when marking it done fails", async () => {
    deferWindowTimers();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    harness.dispatchCommand.mockRejectedValue(new Error("done rejected"));

    render({ routeThreadId: THREAD_ID }).setThreadSettledWithToast(THREAD_ID, true);
    await flushActionResponses();

    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.handleNewChat).not.toHaveBeenCalled();
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Unable to mark thread as done" }),
    );
    errorLog.mockRestore();
  });

  it("keeps the focused chat when undoing done", async () => {
    deferWindowTimers();
    sidebarThreads = [
      makeThread(THREAD_ID, { settledAt: "2026-07-20T01:00:00.000Z" }),
      makeThread(FALLBACK_ID),
    ];

    render({ routeThreadId: THREAD_ID }).setThreadSettledWithToast(THREAD_ID, false);
    await flushActionResponses();

    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.handleNewChat).not.toHaveBeenCalled();
  });

  it("does not navigate for an accepted Done request superseded by Undo", async () => {
    deferWindowTimers();
    let acceptDone!: (response: { sequence: number }) => void;
    harness.dispatchCommand.mockImplementationOnce(
      () => new Promise((resolve) => (acceptDone = resolve)),
    );
    const controller = render({ routeThreadId: THREAD_ID });

    controller.setThreadSettledWithToast(THREAD_ID, true);
    controller.setThreadSettledWithToast(THREAD_ID, false);
    await flushActionResponses();
    acceptDone({ sequence: 1 });
    await flushActionResponses();

    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.handleNewChat).not.toHaveBeenCalled();
  });

  it("uses human recency across projects instead of the sidebar working priority", async () => {
    const recentId = ThreadId.makeUnsafe("thread-recent-other-project");
    sidebarThreads = [
      makeThread(THREAD_ID),
      makeThread(FALLBACK_ID, {
        latestHumanMessageAt: "2026-07-21T00:00:00.000Z",
        latestUserMessageAt: "2026-07-21T00:00:00.000Z",
        hasLiveTailWork: true,
      }),
      makeThread(recentId, {
        projectId: ProjectId.makeUnsafe("project-other"),
        latestHumanMessageAt: "2026-07-22T00:00:00.000Z",
        latestUserMessageAt: "2026-07-22T00:00:00.000Z",
      }),
    ];

    await render({ routeThreadId: THREAD_ID }).archiveThread(THREAD_ID);

    expect(harness.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { threadId: recentId } }),
    );
  });

  it("skips archived, done, and subagent threads when choosing the next chat", async () => {
    sidebarThreads = [
      makeThread(THREAD_ID),
      makeThread(FALLBACK_ID),
      makeThread(ThreadId.makeUnsafe("thread-already-archived"), {
        latestHumanMessageAt: "2026-07-22T00:00:00.000Z",
        latestUserMessageAt: "2026-07-22T00:00:00.000Z",
        archivedAt: "2026-07-22T01:00:00.000Z",
      }),
      makeThread(ThreadId.makeUnsafe("thread-already-done"), {
        latestHumanMessageAt: "2026-07-23T00:00:00.000Z",
        latestUserMessageAt: "2026-07-23T00:00:00.000Z",
        settledAt: "2026-07-23T01:00:00.000Z",
      }),
      makeThread(ThreadId.makeUnsafe("thread-child"), {
        latestHumanMessageAt: "2026-07-24T00:00:00.000Z",
        latestUserMessageAt: "2026-07-24T00:00:00.000Z",
        parentThreadId: THREAD_ID,
      }),
    ];

    await render({ routeThreadId: THREAD_ID }).archiveThread(THREAD_ID);

    expect(harness.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { threadId: FALLBACK_ID } }),
    );
  });

  it("chooses from the visible thread list instead of hidden raw summaries", async () => {
    const focused = makeThread(THREAD_ID);
    const fallback = makeThread(FALLBACK_ID);
    sidebarThreads = [
      focused,
      fallback,
      makeThread(ThreadId.makeUnsafe("thread-hidden"), {
        latestHumanMessageAt: "2026-07-22T00:00:00.000Z",
        latestUserMessageAt: "2026-07-22T00:00:00.000Z",
      }),
    ];

    await render({
      routeThreadId: THREAD_ID,
      sidebarTreeThreads: [focused, fallback],
    }).archiveThread(THREAD_ID);

    expect(harness.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { threadId: FALLBACK_ID } }),
    );
  });

  it("keeps the focused chat when its archive command fails", async () => {
    harness.archiveThread.mockRejectedValue(new Error("archive rejected"));

    await expect(render({ routeThreadId: THREAD_ID }).archiveThread(THREAD_ID)).rejects.toThrow(
      "archive rejected",
    );

    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.handleNewChat).not.toHaveBeenCalled();
  });

  it("reads the current candidate list when an archive response arrives", async () => {
    let acceptArchive!: (sequence: number) => void;
    harness.archiveThread.mockImplementationOnce(
      () => new Promise((resolve) => (acceptArchive = resolve)),
    );
    const pending = render({ routeThreadId: THREAD_ID }).archiveThread(THREAD_ID);
    const recentId = ThreadId.makeUnsafe("thread-arrived-during-archive");
    sidebarThreads = [
      makeThread(THREAD_ID),
      makeThread(recentId, { latestHumanMessageAt: "2026-07-22T00:00:00.000Z" }),
    ];
    render({ routeThreadId: THREAD_ID });

    acceptArchive(1);
    await pending;

    expect(harness.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { threadId: recentId } }),
    );
  });

  it.each(["archive", "done"] as const)(
    "preserves a newer route while the focused thread's %s request is pending",
    async (action) => {
      deferWindowTimers();
      let acceptRequest!: () => void;
      if (action === "archive") {
        harness.archiveThread.mockImplementationOnce(
          () => new Promise<number>((resolve) => (acceptRequest = () => resolve(1))),
        );
      } else {
        harness.dispatchCommand.mockImplementationOnce(
          () =>
            new Promise<{ sequence: number }>(
              (resolve) => (acceptRequest = () => resolve({ sequence: 1 })),
            ),
        );
      }
      const controller = render({ routeThreadId: THREAD_ID });
      const pending =
        action === "archive"
          ? controller.archiveThread(THREAD_ID)
          : controller.setThreadSettledWithToast(THREAD_ID, true);
      render({ routeThreadId: FALLBACK_ID });

      acceptRequest();
      await pending;
      await flushActionResponses();

      expect(harness.navigate).not.toHaveBeenCalled();
      expect(harness.handleNewChat).not.toHaveBeenCalled();
    },
  );

  it.each(["archive", "done"] as const)(
    "keeps focus when a background %s target is opened before acceptance",
    async (action) => {
      deferWindowTimers();
      let acceptRequest!: () => void;
      if (action === "archive") {
        harness.archiveThread.mockImplementationOnce(
          () => new Promise<number>((resolve) => (acceptRequest = () => resolve(1))),
        );
      } else {
        harness.dispatchCommand.mockImplementationOnce(
          () =>
            new Promise<{ sequence: number }>(
              (resolve) => (acceptRequest = () => resolve({ sequence: 1 })),
            ),
        );
      }
      const controller = render({ routeThreadId: FALLBACK_ID });
      const pending =
        action === "archive"
          ? controller.archiveThread(THREAD_ID)
          : controller.setThreadSettledWithToast(THREAD_ID, true);
      render({ routeThreadId: THREAD_ID });

      acceptRequest();
      await pending;
      await flushActionResponses();

      expect(harness.navigate).not.toHaveBeenCalled();
      expect(harness.handleNewChat).not.toHaveBeenCalled();
    },
  );

  it.each(["archive", "done"] as const)(
    "keeps focus after leaving and returning to a pending %s target",
    async (action) => {
      deferWindowTimers();
      let acceptRequest!: () => void;
      if (action === "archive") {
        harness.archiveThread.mockImplementationOnce(
          () => new Promise<number>((resolve) => (acceptRequest = () => resolve(1))),
        );
      } else {
        harness.dispatchCommand.mockImplementationOnce(
          () =>
            new Promise<{ sequence: number }>(
              (resolve) => (acceptRequest = () => resolve({ sequence: 1 })),
            ),
        );
      }
      const controller = render({ routeThreadId: THREAD_ID });
      const pending =
        action === "archive"
          ? controller.archiveThread(THREAD_ID)
          : controller.setThreadSettledWithToast(THREAD_ID, true);
      render({ routeThreadId: FALLBACK_ID });
      render({ routeThreadId: THREAD_ID });

      acceptRequest();
      await pending;
      await flushActionResponses();

      expect(harness.navigate).not.toHaveBeenCalled();
      expect(harness.handleNewChat).not.toHaveBeenCalled();
    },
  );

  it.each(["archive", "done"] as const)(
    "keeps a newer split route while the focused thread's %s request is pending",
    async (action) => {
      deferWindowTimers();
      let acceptRequest!: () => void;
      if (action === "archive") {
        harness.archiveThread.mockImplementationOnce(
          () => new Promise<number>((resolve) => (acceptRequest = () => resolve(1))),
        );
      } else {
        harness.dispatchCommand.mockImplementationOnce(
          () =>
            new Promise<{ sequence: number }>(
              (resolve) => (acceptRequest = () => resolve({ sequence: 1 })),
            ),
        );
      }
      const controller = render({ routeThreadId: THREAD_ID });
      const pending =
        action === "archive"
          ? controller.archiveThread(THREAD_ID)
          : controller.setThreadSettledWithToast(THREAD_ID, true);
      render({ routeThreadId: THREAD_ID, routeSplitViewId: "split-newer" });

      acceptRequest();
      await pending;
      await flushActionResponses();

      expect(harness.navigate).not.toHaveBeenCalled();
      expect(harness.handleNewChat).not.toHaveBeenCalled();
    },
  );

  it.each(["archive", "done"] as const)(
    "skips an accepted archive before its projection when the focused chat is marked %s",
    async (action) => {
      deferWindowTimers();
      const olderId = ThreadId.makeUnsafe("thread-older-pending");
      sidebarThreads = [
        makeThread(THREAD_ID),
        makeThread(FALLBACK_ID),
        makeThread(olderId, { createdAt: "2026-07-18T00:00:00.000Z" }),
      ];
      const controller = render({ routeThreadId: THREAD_ID });
      await controller.archiveThread(FALLBACK_ID);

      if (action === "archive") await controller.archiveThread(THREAD_ID);
      else controller.setThreadSettledWithToast(THREAD_ID, true);
      await flushActionResponses();

      expect(harness.navigate).toHaveBeenCalledOnce();
      expect(harness.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ params: { threadId: olderId } }),
      );
    },
  );

  it.each(["archive", "done"] as const)(
    "keeps the focused chat when another thread is marked %s",
    async (action) => {
      deferWindowTimers();
      const controller = render({ routeThreadId: FALLBACK_ID });

      if (action === "archive") await controller.archiveThread(THREAD_ID);
      else controller.setThreadSettledWithToast(THREAD_ID, true);
      await flushActionResponses();

      expect(harness.navigate).not.toHaveBeenCalled();
      expect(harness.handleNewChat).not.toHaveBeenCalled();
    },
  );

  it("keeps an accepted archive excluded after its Undo toast closes before projection", async () => {
    const olderId = ThreadId.makeUnsafe("thread-older-pending");
    sidebarThreads = [
      makeThread(THREAD_ID),
      makeThread(FALLBACK_ID),
      makeThread(olderId, { createdAt: "2026-07-18T00:00:00.000Z" }),
    ];
    const controller = render({ routeThreadId: THREAD_ID });
    await controller.archiveThreadWithUndo(FALLBACK_ID);
    const toast = harness.toast.mock.calls.at(-1)?.[0] as {
      data: { archiveUndo: { onNoUndo: () => void } };
    };
    toast.data.archiveUndo.onNoUndo();

    await controller.archiveThread(THREAD_ID);

    expect(harness.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { threadId: olderId } }),
    );
  });

  it.each(["archive", "done"] as const)(
    "opens the saved chat draft when %s leaves no unfinished candidate",
    async (action) => {
      deferWindowTimers();
      sidebarThreads = [
        makeThread(THREAD_ID),
        makeThread(FALLBACK_ID, { settledAt: "2026-07-20T00:00:00.000Z" }),
      ];
      const controller = render({ routeThreadId: THREAD_ID });

      if (action === "archive") await controller.archiveThread(THREAD_ID);
      else controller.setThreadSettledWithToast(THREAD_ID, true);
      await flushActionResponses();

      expect(harness.navigate).not.toHaveBeenCalled();
      expect(harness.handleNewChat).toHaveBeenCalledWith();
    },
  );

  it("excludes optimistic Done candidates before the server projection arrives", async () => {
    deferWindowTimers();
    const olderId = ThreadId.makeUnsafe("thread-older-unfinished");
    sidebarThreads = [
      makeThread(THREAD_ID),
      makeThread(FALLBACK_ID, { latestHumanMessageAt: "2026-07-22T00:00:00.000Z" }),
      makeThread(olderId, { createdAt: "2026-07-18T00:00:00.000Z" }),
    ];
    let controller = render({ routeThreadId: THREAD_ID });
    controller.setThreadSettledWithToast(FALLBACK_ID, true);
    await flushActionResponses();
    controller = render({ routeThreadId: THREAD_ID });

    await controller.archiveThread(THREAD_ID);

    expect(harness.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { threadId: olderId } }),
    );
  });

  it("excludes every project bulk-archive target from the next-chat destination", async () => {
    const outsideId = ThreadId.makeUnsafe("thread-outside-project");
    sidebarThreads = [
      makeThread(THREAD_ID),
      makeThread(FALLBACK_ID),
      makeThread(outsideId, {
        projectId: ProjectId.makeUnsafe("project-outside"),
        createdAt: "2026-07-18T00:00:00.000Z",
      }),
    ];

    await render({ routeThreadId: THREAD_ID }).archiveAllThreadsInProject(PROJECT_ID);

    expect(harness.navigate).toHaveBeenCalledOnce();
    expect(harness.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { threadId: outsideId } }),
    );
  });

  it.each(["archive", "done"] as const)(
    "leaves split view when the focused thread is marked %s",
    async (action) => {
      deferWindowTimers();
      const controller = render({
        routeThreadId: THREAD_ID,
        activeSplitView: { id: "split-actions" } as never,
        routeSplitViewId: "split-actions",
      });

      if (action === "archive") await controller.archiveThread(THREAD_ID);
      else controller.setThreadSettledWithToast(THREAD_ID, true);
      await flushActionResponses();

      const navigation = harness.navigate.mock.calls.at(-1)?.[0] as {
        params: { threadId: ThreadId };
        search?: () => unknown;
      };
      expect(navigation).toMatchObject({ params: { threadId: FALLBACK_ID } });
      expect(navigation?.search?.()).toEqual({});
    },
  );

  it("waits for the Undo decision before requesting worktree cleanup", async () => {
    const controller = render({ archiveDeletesOrphanedWorktree: true });
    await controller.archiveThreadWithUndo(THREAD_ID);
    expect(harness.releaseArchivedWorktree).not.toHaveBeenCalled();

    const toast = harness.toast.mock.calls.at(-1)?.[0] as {
      data: { archiveUndo: { onNoUndo: () => void } };
    };
    toast.data.archiveUndo.onNoUndo();
    expect(harness.releaseArchivedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: THREAD_ID, archiveSequence: 1 }),
    );
  });

  it("treats an already-restored invariant as successful Undo", async () => {
    harness.alreadyUnarchived = true;
    harness.unarchiveThread.mockRejectedValue(new Error("already restored"));
    const controller = render({ routeThreadId: THREAD_ID });
    await controller.archiveThreadWithUndo(THREAD_ID);
    const toast = harness.toast.mock.calls.at(-1)?.[0] as {
      data: { archiveUndo: { onUndo: () => Promise<boolean> } };
    };

    await expect(toast.data.archiveUndo.onUndo()).resolves.toBe(true);

    expect(harness.unarchiveThread).toHaveBeenCalledOnce();
    expect(harness.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { threadId: THREAD_ID }, replace: true }),
    );
  });

  it("deduplicates concurrent Undo requests", async () => {
    let resolveUndo!: () => void;
    harness.unarchiveThread.mockImplementation(
      () => new Promise<void>((resolve) => (resolveUndo = resolve)),
    );
    const controller = render({ routeThreadId: THREAD_ID });
    await controller.archiveThreadWithUndo(THREAD_ID);
    const toast = harness.toast.mock.calls.at(-1)?.[0] as {
      data: { archiveUndo: { onUndo: () => Promise<boolean> } };
    };

    const first = toast.data.archiveUndo.onUndo();
    await expect(toast.data.archiveUndo.onUndo()).resolves.toBe(false);
    resolveUndo();
    await expect(first).resolves.toBe(true);

    expect(harness.unarchiveThread).toHaveBeenCalledOnce();
  });

  it("continues project deletion after failures and reconciles only successful ids", async () => {
    const thirdId = ThreadId.makeUnsafe("thread-third");
    sidebarThreads = [makeThread(THREAD_ID), makeThread(thirdId)];
    harness.activeThreadDelete
      .mockRejectedValueOnce(new Error("first failed"))
      .mockImplementationOnce(async (input: unknown) => {
        const action = input as {
          onDeleted: (input: { thread: { id: ThreadId; projectId: ProjectId } }) => void;
        };
        action.onDeleted({ thread: { id: thirdId, projectId: PROJECT_ID } });
      });

    const result = await render().deleteProjectThreads(PROJECT_ID, { confirmMessage: null });

    expect(harness.activeThreadDelete).toHaveBeenCalledTimes(2);
    const firstInput = harness.activeThreadDelete.mock.calls[0]?.[0] as {
      deletedThreadIds: ReadonlySet<ThreadId>;
    };
    const secondInput = harness.activeThreadDelete.mock.calls[1]?.[0] as {
      deletedThreadIds: ReadonlySet<ThreadId>;
    };
    expect(firstInput.deletedThreadIds).toBe(secondInput.deletedThreadIds);
    expect([...firstInput.deletedThreadIds]).toEqual([THREAD_ID, thirdId]);
    expect(harness.reconcileDeletedThreads).toHaveBeenCalledWith(
      expect.objectContaining({ threadIds: [thirdId] }),
    );
    expect(result).toMatchObject({ deletedCount: 1, failureCount: 1, totalCount: 2 });
  });

  it("navigates split deletion to the surviving focused pane after cleanup", async () => {
    const splitView = { id: "split-actions" } as never;
    harness.resolveSplitViewPaneIdForThread.mockReturnValue("pane-deleted");
    harness.resolveSplitViewFocusedThreadId.mockReturnValue(FALLBACK_ID);
    harness.splitViewsById = { "split-actions": { id: "split-actions" } };

    await render({
      activeSplitView: splitView,
      routeSplitViewId: "split-actions",
      routeThreadId: THREAD_ID,
    }).deleteThread(THREAD_ID);

    expect(harness.removeThreadFromSplitViews).toHaveBeenCalledWith(THREAD_ID);
    expect(harness.clearDraftThread).toHaveBeenCalledWith(THREAD_ID);
    expect(harness.clearTerminalState).toHaveBeenCalledWith(THREAD_ID);
    const navigation = harness.navigate.mock.calls.at(-1)?.[0] as {
      params: { threadId: ThreadId };
      search: () => { splitViewId: string };
    };
    expect(navigation.params).toEqual({ threadId: FALLBACK_ID });
    expect(navigation.search()).toEqual({ splitViewId: "split-actions" });
  });

  it("restores the saved chat draft when deleting the last pane leaves no fallback", async () => {
    sidebarThreads = [makeThread(THREAD_ID)];
    harness.resolveSplitViewPaneIdForThread.mockReturnValue("pane-only");
    harness.resolveSplitViewFocusedThreadId.mockReturnValue(null);

    await render({
      activeSplitView: { id: "split-empty" } as never,
      routeSplitViewId: "split-empty",
      routeThreadId: THREAD_ID,
    }).deleteThread(THREAD_ID);

    expect(harness.navigate).not.toHaveBeenCalled();
    expect(harness.handleNewChat).toHaveBeenCalledWith();
  });
});
