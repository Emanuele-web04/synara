import { DEFAULT_MODEL_BY_PROVIDER, ProjectId, ThreadId } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { Project, Thread } from "../../types";
import { prepareChatSendWorkspace } from "./prepareChatSendWorkspace";

const projectId = ProjectId.makeUnsafe("project");
const threadId = ThreadId.makeUnsafe("draft");
const project: Project = {
  id: projectId,
  kind: "project",
  name: "Project",
  remoteName: "Project",
  folderName: "project",
  localName: null,
  cwd: "/repo/project",
  defaultModelSelection: null,
  expanded: false,
  spaceId: null,
  scripts: [],
};

function prepare(branch: string | null, cachedBranch: string | null, queryClient: QueryClient) {
  return prepareChatSendWorkspace({
    activeThread: { id: threadId, branch, worktreePath: null } as Thread,
    isServerThread: false,
    hasNativeUserMessages: false,
    composerImagesForSend: [],
    trimmedPromptForSend: "start a thread",
    composerFilesForSend: [],
    composerAssistantSelectionsForSend: [],
    composerBrowserAnnotationsForSend: [],
    sendableComposerTerminalContexts: [],
    composerFileCommentsForSend: [],
    sendableComposerPastedTexts: [],
    selectedModelSelectionForSend: { provider: "codex", model: DEFAULT_MODEL_BY_PROVIDER.codex },
    selectedModelForSend: DEFAULT_MODEL_BY_PROVIDER.codex,
    activeProject: project,
    chatWorkspaceRoot: null,
    isHomeChatContainer: false,
    isGroupContainer: false,
    resolvedThreadWorktreePath: null,
    runtimeModeForSend: "full-access",
    envModeForSend: "worktree",
    resolvedThreadWorkingDirectory: null,
    currentActiveGitBranch: cachedBranch,
    isContainerLandingProject: false,
    api: {} as Parameters<typeof prepareChatSendWorkspace>[0]["api"],
    syncServerShellSnapshot: vi.fn(),
    clearProjectDraftThreadId: vi.fn(),
    setDraftThreadContext: vi.fn(),
    gitBranchSourceCwd: project.cwd,
    setStoreThreadError: vi.fn(),
    queryClient,
  });
}

describe("preparing a new worktree chat", () => {
  it("copies checkout changes when Git status supplies the base before the branch list loads", async () => {
    const queryClient = new QueryClient();
    const gitStatus = vi.spyOn(queryClient, "fetchQuery").mockResolvedValue({ branch: "main" });

    await expect(prepare(null, null, queryClient)).resolves.toMatchObject({
      baseBranchForWorktree: "main",
      worktreeCopiesLocalChanges: true,
    });
    expect(gitStatus).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ staleTime: 0 }));
  });

  it("does not copy checkout changes for an explicitly different branch", async () => {
    const queryClient = new QueryClient();
    vi.spyOn(queryClient, "fetchQuery").mockResolvedValue({ branch: "main" });

    await expect(prepare("topic", "main", queryClient)).resolves.toMatchObject({
      baseBranchForWorktree: "topic",
      worktreeCopiesLocalChanges: false,
    });
  });

  it("uses the current checkout rather than a stale branch list for an unselected base", async () => {
    const queryClient = new QueryClient();
    vi.spyOn(queryClient, "fetchQuery").mockResolvedValue({ branch: "topic" });

    await expect(prepare(null, "main", queryClient)).resolves.toMatchObject({
      baseBranchForWorktree: "topic",
      worktreeCopiesLocalChanges: true,
    });
  });

  it("keeps an explicit base but does not copy edits from a different current checkout", async () => {
    const queryClient = new QueryClient();
    vi.spyOn(queryClient, "fetchQuery").mockResolvedValue({ branch: "main" });

    await expect(prepare("topic", "topic", queryClient)).resolves.toMatchObject({
      baseBranchForWorktree: "topic",
      worktreeCopiesLocalChanges: false,
    });
  });

  it("copies edits for an explicit current base even when the branch list has not loaded", async () => {
    const queryClient = new QueryClient();
    vi.spyOn(queryClient, "fetchQuery").mockResolvedValue({ branch: "main" });

    await expect(prepare("main", null, queryClient)).resolves.toMatchObject({
      baseBranchForWorktree: "main",
      worktreeCopiesLocalChanges: true,
    });
  });

  it("does not proceed without a base when the checkout status is unavailable", async () => {
    const queryClient = new QueryClient();
    vi.spyOn(queryClient, "fetchQuery").mockRejectedValue(new Error("disconnected"));

    await expect(prepare(null, "main", queryClient)).resolves.toBe(false);
  });

  it("proceeds without copying edits when the base is explicit and status is unavailable", async () => {
    const queryClient = new QueryClient();
    vi.spyOn(queryClient, "fetchQuery").mockRejectedValue(new Error("disconnected"));

    await expect(prepare("main", "main", queryClient)).resolves.toMatchObject({
      baseBranchForWorktree: "main",
      worktreeCopiesLocalChanges: false,
    });
  });
});
