// FILE: ConversationStorageSettingsPanels.browser.tsx
// Purpose: Browser characterization for worktree association and archived-thread grouping.
// Layer: Browser UI test

import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  worktrees: [
    {
      workspaceRoot: "/repo",
      path: "/repo/.worktrees/feature",
    },
  ],
  threadShells: [] as Array<Record<string, unknown>>,
  projects: [{ id: "project-1", name: "Project One" }],
  removeDeletedThreadFromClientState: vi.fn(),
  mutateAsync: vi.fn(),
  invalidateQueries: vi.fn(),
  confirm: vi.fn(async (_message: string) => true),
  deleteArchivedThreadsFromClient: vi.fn(async (_input: { threadIds: string[] }) => {}),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { worktrees: harness.worktrees }, isLoading: false, isError: false }),
  useMutation: () => ({ isPending: false, mutateAsync: harness.mutateAsync }),
  useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
}));

vi.mock("~/lib/serverReactQuery", () => ({
  serverQueryKeys: { worktrees: () => ["worktrees"] },
  serverWorktreesQueryOptions: () => ({ queryKey: ["worktrees"] }),
}));

vi.mock("~/lib/gitReactQuery", () => ({
  gitRemoveWorktreeMutationOptions: () => ({}),
}));

vi.mock("~/storeSelectors", () => ({
  createThreadShellsSelector: () => () => harness.threadShells,
}));

vi.mock("~/store", () => ({
  useStore: (selector: (store: Record<string, unknown>) => unknown) =>
    selector({
      projects: harness.projects,
      removeDeletedThreadFromClientState: harness.removeDeletedThreadFromClientState,
    }),
}));

vi.mock("~/nativeApi", () => {
  const api = { dialogs: { confirm: harness.confirm }, orchestration: {} };
  return { readNativeApi: () => api, ensureNativeApi: () => api };
});

vi.mock("~/lib/archivedThreadDelete", () => ({
  deleteArchivedThreadsFromClient: harness.deleteArchivedThreadsFromClient,
}));

import { ArchivedSettingsPanel, WorktreesSettingsPanel } from "./ConversationStorageSettingsPanels";

function thread(overrides: Record<string, unknown>) {
  return {
    id: "thread",
    title: "Thread",
    projectId: "project-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    worktreePath: null,
    associatedWorktreePath: null,
    ...overrides,
  };
}

describe("ConversationStorageSettingsPanels", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    harness.threadShells = [];
    harness.confirm.mockClear();
    harness.deleteArchivedThreadsFromClient.mockClear();
  });

  it("uses one association rule for direct and associated worktree paths", async () => {
    harness.threadShells = [
      thread({
        id: "direct",
        title: "Direct link",
        worktreePath: "/repo/.worktrees/feature",
      }),
      thread({
        id: "associated",
        title: "Associated link",
        associatedWorktreePath: "/repo/.worktrees/feature",
      }),
      thread({ id: "other", title: "Other worktree", worktreePath: "/repo/.worktrees/other" }),
    ];

    await render(<WorktreesSettingsPanel active />);

    expect(document.body.textContent).toContain("Direct link");
    expect(document.body.textContent).toContain("Associated link");
    expect(document.body.textContent).not.toContain("Other worktree");
  });

  it("sorts archived threads once and keeps orphaned projects visible", async () => {
    harness.threadShells = [
      thread({
        id: "older",
        title: "Older archived",
        archivedAt: "2026-01-02T00:00:00.000Z",
      }),
      thread({
        id: "newer",
        title: "Newer archived",
        archivedAt: "2026-01-03T00:00:00.000Z",
      }),
      thread({
        id: "orphan",
        title: "Orphan archived",
        projectId: "missing-project",
        archivedAt: "2026-01-04T00:00:00.000Z",
      }),
    ];

    await render(<ArchivedSettingsPanel active />);

    const text = document.body.textContent ?? "";
    expect(text.indexOf("Newer archived")).toBeLessThan(text.indexOf("Older archived"));
    expect(text).toContain("Unknown project");
    expect(text).toContain("Orphan archived");
  });

  it("lists each archived subtree once and exposes a child archived without its parent", async () => {
    harness.threadShells = [
      thread({ id: "active-parent", title: "Active parent" }),
      thread({
        id: "recoverable-child",
        title: "Recoverable archived child",
        parentThreadId: "active-parent",
        archivedAt: "2026-01-02T00:00:00.000Z",
      }),
      thread({
        id: "archived-parent",
        title: "Archived parent",
        archivedAt: "2026-01-03T00:00:00.000Z",
      }),
      thread({
        id: "represented-child",
        title: "Represented archived child",
        parentThreadId: "archived-parent",
        archivedAt: "2026-01-03T00:00:00.000Z",
      }),
    ];

    await render(<ArchivedSettingsPanel active />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("Recoverable archived child");
    expect(text).toContain("Archived parent");
    expect(text).not.toContain("Represented archived child");
  });

  it("deletes every archived subtree, children before parents, after one confirmation", async () => {
    harness.threadShells = [
      thread({ id: "active", title: "Active thread" }),
      thread({ id: "first", title: "First archived", archivedAt: "2026-01-02T00:00:00.000Z" }),
      thread({
        id: "first-child",
        title: "First child",
        parentThreadId: "first",
        archivedAt: "2026-01-02T00:00:00.000Z",
      }),
      thread({
        id: "second",
        title: "Second archived",
        projectId: "missing-project",
        archivedAt: "2026-01-03T00:00:00.000Z",
      }),
    ];

    const screen = await render(<ArchivedSettingsPanel active />);
    await expect.element(screen.getByText("2 archived threads")).toBeVisible();
    await screen.getByRole("button", { name: "Delete all" }).click();

    await vi.waitFor(() => expect(harness.deleteArchivedThreadsFromClient).toHaveBeenCalledOnce());
    expect(harness.confirm).toHaveBeenCalledOnce();
    expect(harness.confirm.mock.calls[0]?.[0]).toContain("all 2 archived threads");
    expect(harness.deleteArchivedThreadsFromClient.mock.calls[0]?.[0]).toMatchObject({
      threadIds: ["first-child", "first", "second"],
    });
  });

  it("does not delete anything when delete all is cancelled", async () => {
    harness.threadShells = [
      thread({ id: "only", title: "Only archived", archivedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    harness.confirm.mockResolvedValueOnce(false);

    const screen = await render(<ArchivedSettingsPanel active />);
    await screen.getByRole("button", { name: "Delete all" }).click();

    await vi.waitFor(() => expect(harness.confirm).toHaveBeenCalledOnce());
    expect(harness.deleteArchivedThreadsFromClient).not.toHaveBeenCalled();
  });
});
