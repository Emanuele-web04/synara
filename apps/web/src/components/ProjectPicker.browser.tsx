import "../index.css";

import { ProjectId, ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProjectPicker } from "./chat/ProjectPicker";
import { useSpacesUiStore } from "../spacesUiStore";
import { useStore } from "../store";
import { initialState } from "../storeState";
import type { Project, SidebarThreadSummary } from "../types";
import { useWorkspacePathsStore } from "../workspacePathsStore";

const PROJECT_ID = ProjectId.makeUnsafe("project-picker-synara");
const PROJECT_ROOT = "/Users/tester/projects/synara";
const SELECTED_WORKTREE = "/Users/tester/worktrees/selected/synara";

const project: Project = {
  id: PROJECT_ID,
  kind: "project",
  name: "synara",
  remoteName: "synara",
  folderName: "synara",
  localName: null,
  cwd: PROJECT_ROOT,
  defaultModelSelection: null,
  expanded: true,
  spaceId: null,
  scripts: [],
};

function worktreeThread(id: string, worktreePath: string): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId: PROJECT_ID,
    title: "Work on synara",
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    interactionMode: "default",
    envMode: "worktree",
    branch: `feature/${id}`,
    worktreePath,
    session: null,
    createdAt: "2026-10-02T10:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingBackgroundWorkCount: 0,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
  };
}

function setThreads(threads: SidebarThreadSummary[]) {
  useStore.setState({
    threadIds: threads.map((thread) => thread.id),
    sidebarThreadSummaryById: Object.fromEntries(threads.map((thread) => [thread.id, thread])),
  });
}

const clients: QueryClient[] = [];

beforeEach(() => {
  useStore.setState({ ...initialState, projects: [project], threadsHydrated: true });
  useSpacesUiStore.setState({ activeSpaceId: null });
  // Home-directory discovery is independent of the registered-project list.
  useWorkspacePathsStore.setState({ homeDir: null });
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  useStore.setState(initialState);
});

async function mountPicker(props: ComponentProps<typeof ProjectPicker> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <ProjectPicker {...props} />
    </QueryClientProvider>,
  );
}

describe("ProjectPicker workspace choices", () => {
  it("lists a registered project once despite its active thread worktrees", async () => {
    setThreads([
      worktreeThread("first", "/Users/tester/worktrees/first/synara"),
      worktreeThread("second", "/Users/tester/worktrees/second/synara"),
      worktreeThread("third", "/Users/tester/worktrees/third/synara"),
    ]);
    const onSelectProject = vi.fn();
    const onSelectWorkspaceRoot = vi.fn();
    const screen = await mountPicker({ onSelectProject, onSelectWorkspaceRoot });

    try {
      await page.getByTestId("workspace-picker-trigger").click();
      await expect.element(page.getByPlaceholder("Search projects")).toBeVisible();
      expect(page.getByRole("option").elements()).toHaveLength(1);

      await page.getByRole("option", { name: "synara", exact: true }).click();
      expect(onSelectProject).toHaveBeenCalledExactlyOnceWith(PROJECT_ID);
      expect(onSelectWorkspaceRoot).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("does not add a project choice when a thread creates another worktree", async () => {
    const screen = await mountPicker();

    try {
      await page.getByTestId("workspace-picker-trigger").click();
      await expect.element(page.getByPlaceholder("Search projects")).toBeVisible();
      expect(page.getByRole("option").elements()).toHaveLength(1);

      setThreads([worktreeThread("new-worktree", "/Users/tester/worktrees/new/synara")]);
      // Reopen after the store update so the assertion observes the updated choices.
      await page.getByTestId("workspace-picker-trigger").click();
      await expect.element(page.getByPlaceholder("Search projects")).not.toBeInTheDocument();
      await page.getByTestId("workspace-picker-trigger").click();
      await expect.element(page.getByPlaceholder("Search projects")).toBeVisible();
      expect(page.getByRole("option").elements()).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the selected worktree available without listing other thread worktrees", async () => {
    setThreads([
      worktreeThread("selected", SELECTED_WORKTREE),
      worktreeThread("other", "/Users/tester/worktrees/other/synara"),
    ]);
    const onSelectProject = vi.fn();
    const onSelectWorkspaceRoot = vi.fn();
    const screen = await mountPicker({
      selectedWorkspaceRoot: SELECTED_WORKTREE,
      onSelectProject,
      onSelectWorkspaceRoot,
    });

    try {
      await expect
        .element(page.getByTestId("workspace-picker-trigger"))
        .toHaveTextContent("synara");
      await expect
        .element(page.getByTestId("workspace-picker-trigger"))
        .toHaveTextContent(SELECTED_WORKTREE);
      await page.getByTestId("workspace-picker-trigger").click();
      await expect.element(page.getByPlaceholder("Search projects")).toBeVisible();
      expect(page.getByRole("option").elements()).toHaveLength(2);
      await expect
        .element(page.getByRole("option", { name: `synara ${SELECTED_WORKTREE}`, exact: true }))
        .toBeVisible();

      // A raw workspace remains searchable and selectable by its exact path.
      await page.getByPlaceholder("Search projects").fill(SELECTED_WORKTREE);
      await vi.waitFor(() => expect(page.getByRole("option").elements()).toHaveLength(1));
      await page.getByRole("option").click();
      expect(onSelectWorkspaceRoot).toHaveBeenCalledExactlyOnceWith(SELECTED_WORKTREE);
      expect(onSelectProject).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
