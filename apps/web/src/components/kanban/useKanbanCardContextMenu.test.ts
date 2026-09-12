// FILE: useKanbanCardContextMenu.test.ts
// Purpose: Verifies Kanban delegates active-thread archive/delete to shared owners.
// Layer: Web Kanban hook tests

import { ProjectId, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  clicked: "delete" as string,
  showContextMenu: vi.fn(),
  confirm: vi.fn(),
  clearOptimisticDispatch: vi.fn(),
  clearComposerContent: vi.fn(),
  clearDraftThread: vi.fn(),
  clearProjectDraftThreadById: vi.fn(),
  clearTerminalState: vi.fn(),
  deleteActiveThread: vi.fn(),
  archiveThread: vi.fn(),
  toast: vi.fn(),
  sendAsGoal: vi.fn(),
  setGoal: vi.fn(),
  dispatchCommand: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: <T>(initial: T) => [initial, vi.fn()] as const,
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutateAsync: vi.fn() }),
  useQueryClient: () => ({}),
}));
vi.mock("~/appSettings", () => ({
  useAppSettings: () => ({
    settings: {
      confirmThreadArchive: false,
      confirmThreadDelete: false,
      defaultProvider: "codex",
      enableAssistantStreaming: false,
    },
  }),
  resolveAssistantDeliveryMode: () => "buffered" as const,
  getProviderStartOptions: () => undefined,
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyPathToClipboard: () => vi.fn(),
  useCopyThreadIdToClipboard: () => vi.fn(),
}));
vi.mock("~/lib/activeThreadDelete", () => ({
  deleteActiveThreadFromClient: harness.deleteActiveThread,
}));
vi.mock("~/lib/gitReactQuery", () => ({ gitRemoveWorktreeMutationOptions: () => ({}) }));
vi.mock("~/lib/threadArchive", () => ({ archiveThreadFromClient: harness.archiveThread }));
vi.mock("~/lib/threadRename", () => ({ dispatchThreadRename: vi.fn() }));
vi.mock("~/threadGoal", () => ({ dispatchThreadGoal: harness.setGoal }));
vi.mock("~/lib/kanbanDispatch", () => ({
  dispatchKanbanDraftCardAsGoal: harness.sendAsGoal,
  kanbanDispatchFailureToast: vi.fn().mockReturnValue({
    type: "error",
    title: "Mock toast",
    description: "mock",
  }),
}));
vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: (selector: (state: unknown) => unknown) =>
    selector({
      clearComposerContent: harness.clearComposerContent,
      clearDraftThread: harness.clearDraftThread,
      clearProjectDraftThreadById: harness.clearProjectDraftThreadById,
    }),
}));
vi.mock("../../kanbanUiStore", () => ({
  useKanbanUiStore: {
    getState: () => ({ clearOptimisticDispatch: harness.clearOptimisticDispatch }),
  },
}));
vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({
    contextMenu: { show: harness.showContextMenu },
    dialogs: { confirm: harness.confirm },
    orchestration: { dispatchCommand: harness.dispatchCommand },
  }),
}));
vi.mock("../../store", () => ({
  useStore: {
    getState: () => ({ projects: [{ id: ProjectId.makeUnsafe("project-kanban"), cwd: "/repo" }] }),
  },
}));
vi.mock("../../terminalStateStore", () => ({
  useTerminalStateStore: (selector: (state: unknown) => unknown) =>
    selector({ clearTerminalState: harness.clearTerminalState }),
}));
vi.mock("../../threadDerivation", () => ({
  getThreadFromState: () => ({ id: ThreadId.makeUnsafe("thread-kanban") }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: harness.toast } }));
vi.mock("../RenameThreadDialog", () => ({ RenameThreadDialog: () => null }));

import type { SidebarThreadSummary } from "../../types";
import type { KanbanCard } from "./kanban.logic";
import { useKanbanCardContextMenu } from "./useKanbanCardContextMenu";

const THREAD_ID = ThreadId.makeUnsafe("thread-kanban");
const PROJECT_ID = ProjectId.makeUnsafe("project-kanban");
const CARD = {
  cardId: `thread:${THREAD_ID}`,
  threadId: THREAD_ID,
  projectId: PROJECT_ID,
  column: "done",
  title: "Kanban thread",
  provider: "codex",
  isTerminal: false,
  branch: null,
  envMode: "local",
  worktreePath: null,
  thread: {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Kanban thread",
    isPinned: false,
  } as SidebarThreadSummary,
  draftPrompt: "",
  draftHasAttachments: false,
  sortTimestamp: 0,
  timestamp: null,
  activeWorkStartedAt: null,
  isOptimisticDispatch: false,
} as KanbanCard;

const EVENT = {
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  clientX: 12,
  clientY: 18,
} as never;

beforeEach(() => {
  harness.clicked = "delete";
  for (const mock of [
    harness.showContextMenu,
    harness.confirm,
    harness.clearOptimisticDispatch,
    harness.clearComposerContent,
    harness.clearDraftThread,
    harness.clearProjectDraftThreadById,
    harness.clearTerminalState,
    harness.deleteActiveThread,
    harness.archiveThread,
    harness.toast,
    harness.sendAsGoal,
    harness.setGoal,
    harness.dispatchCommand,
  ]) {
    mock.mockReset();
  }
  harness.showContextMenu.mockImplementation(async () => harness.clicked);
  harness.confirm.mockResolvedValue(true);
  harness.archiveThread.mockResolvedValue(undefined);
  harness.setGoal.mockResolvedValue(undefined);
  harness.sendAsGoal.mockResolvedValue({ kind: "dispatched" });
  harness.deleteActiveThread.mockImplementation(async (input: unknown) => {
    const action = input as {
      onDeleted: (input: { thread: { id: ThreadId; projectId: ProjectId } }) => void;
    };
    action.onDeleted({ thread: { id: THREAD_ID, projectId: PROJECT_ID } });
  });
});

describe("useKanbanCardContextMenu", () => {
  it("delegates server-backed deletion and preserves Kanban-local cleanup", async () => {
    useKanbanCardContextMenu().onCardContextMenu(CARD, EVENT);
    await vi.waitFor(() => expect(harness.deleteActiveThread).toHaveBeenCalled());

    expect(harness.clearOptimisticDispatch).toHaveBeenCalledWith(THREAD_ID);
    expect(harness.clearDraftThread).toHaveBeenCalledWith(THREAD_ID);
    expect(harness.clearProjectDraftThreadById).toHaveBeenCalledWith(PROJECT_ID, THREAD_ID);
    expect(harness.clearTerminalState).toHaveBeenCalledWith(THREAD_ID);
  });

  it("uses the shared archive command while server-side cleanup owns active sessions", async () => {
    harness.clicked = "archive";

    useKanbanCardContextMenu().onCardContextMenu(CARD, EVENT);
    await vi.waitFor(() => expect(harness.archiveThread).toHaveBeenCalled());

    expect(harness.clearOptimisticDispatch).toHaveBeenCalledWith(THREAD_ID);
    expect(harness.archiveThread).toHaveBeenCalledWith(expect.any(Object), THREAD_ID);
  });

  it("deletes a local-only draft without invoking active-thread deletion", async () => {
    const draftCard = {
      ...CARD,
      cardId: `draft:${THREAD_ID}`,
      column: "draft",
      thread: null,
    } as KanbanCard;

    useKanbanCardContextMenu().onCardContextMenu(draftCard, EVENT);
    await vi.waitFor(() => expect(harness.clearDraftThread).toHaveBeenCalledWith(THREAD_ID));

    expect(harness.deleteActiveThread).not.toHaveBeenCalled();
    expect(harness.clearComposerContent).not.toHaveBeenCalled();
  });

  it("deletes only composer content for a thread-backed draft card", async () => {
    const draftCard = {
      ...CARD,
      cardId: `draft:${THREAD_ID}`,
      column: "draft",
    } as KanbanCard;

    useKanbanCardContextMenu().onCardContextMenu(draftCard, EVENT);
    await vi.waitFor(() => expect(harness.clearComposerContent).toHaveBeenCalledWith(THREAD_ID));

    expect(harness.deleteActiveThread).not.toHaveBeenCalled();
    expect(harness.clearDraftThread).not.toHaveBeenCalled();
  });

  it("shows 'Set as goal' for a thread-backed non-draft card and writes the goal without starting a turn", async () => {
    harness.clicked = "set-as-goal";

    useKanbanCardContextMenu().onCardContextMenu(CARD, EVENT);
    await vi.waitFor(() => expect(harness.setGoal).toHaveBeenCalled());

    const menu = harness.showContextMenu.mock.calls[0]?.[0] as Array<{ id?: string }>;
    expect(menu.some((item) => item.id === "set-as-goal")).toBe(true);
    expect(harness.setGoal).toHaveBeenCalledWith(THREAD_ID, "Kanban thread", {
      startBehavior: "defer",
    });
    expect(harness.dispatchCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.turn.start" }),
    );
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Goal set" }),
    );
  });

  it("does not show 'Set as goal' for thread-less cards", async () => {
    const localDraftCard = {
      ...CARD,
      cardId: `draft:${THREAD_ID}`,
      column: "draft",
      thread: null,
    } as KanbanCard;

    useKanbanCardContextMenu().onCardContextMenu(localDraftCard, EVENT);
    await vi.waitFor(() => expect(harness.showContextMenu).toHaveBeenCalled());

    const menu = harness.showContextMenu.mock.calls[0]?.[0] as Array<{ id?: string }>;
    expect(menu.some((item) => item.id === "set-as-goal")).toBe(false);
    expect(harness.setGoal).not.toHaveBeenCalled();
  });
});
