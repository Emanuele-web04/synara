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

function prepare(branch: string | null, activeRootBranch: string | null, queryClient: QueryClient) {
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
    currentActiveGitBranch: activeRootBranch,
    isContainerLandingProject: false,
    api: {} as Parameters<typeof prepareChatSendWorkspace>[0]["api"],
    syncServerShellSnapshot: vi.fn(),
    clearProjectDraftThreadId: vi.fn(),
    setDraftThreadContext: vi.fn(),
    activeRootBranch,
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

    await expect(prepare("topic", "main", queryClient)).resolves.toMatchObject({
      baseBranchForWorktree: "topic",
      worktreeCopiesLocalChanges: false,
    });
  });
});
