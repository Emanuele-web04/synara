import {
  type NativeApi,
  type OrchestrationShellSnapshot,
  type ProjectId,
  type ProviderKind,
  ThreadId,
} from "@synara/contracts";
import { workspaceRootsEqual } from "@synara/shared/threadWorkspace";
import type { RefObject } from "react";
import { useCallback } from "react";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { type DraftThreadEnvMode, useComposerDraftStore } from "../../composerDraftStore";
import { ensureHomeChatProject } from "../../lib/chatProjects";
import {
  PROJECT_CREATE_EXISTING_SYNC_ERROR,
  PROJECT_CREATE_SYNC_ERROR,
  createOrRecoverProjectFromPath,
} from "../../lib/projectCreation";
import { useProjectEnvironmentStore } from "../../projectEnvironmentStore";
import { useStore } from "../../store";
import type { Project, Thread } from "../../types";
import { useWorkspacePathsStore } from "../../workspacePathsStore";
import { type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
const LOCAL_PROJECT_DRAFT_CONTEXT = {
  envMode: "local",
  worktreePath: null,
  branch: null,
  lastKnownPr: null,
} as const;
const DRAFT_PROJECT_SYNC_MAX_ATTEMPTS = 6;
const DRAFT_PROJECT_SYNC_DELAY_MS = 50;
function waitForDraftProjectSyncDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

// Waits for a project to appear in the shell snapshot before a local draft points at it.
async function waitForShellProjectById(
  api: NativeApi,
  projectId: ProjectId,
): Promise<{
  project: OrchestrationShellSnapshot["projects"][number] | null;
  snapshot: OrchestrationShellSnapshot | null;
}> {
  let latestSnapshot: OrchestrationShellSnapshot | null = null;
  for (let attempt = 1; attempt <= DRAFT_PROJECT_SYNC_MAX_ATTEMPTS; attempt += 1) {
    const snapshot = await api.orchestration.getShellSnapshot().catch(() => null);
    if (snapshot) {
      latestSnapshot = snapshot;
      const project = snapshot.projects.find((candidate) => candidate.id === projectId) ?? null;
      if (project) {
        return { project, snapshot };
      }
    }
    if (attempt < DRAFT_PROJECT_SYNC_MAX_ATTEMPTS) {
      await waitForDraftProjectSyncDelay(DRAFT_PROJECT_SYNC_DELAY_MS * attempt);
    }
  }
  return { project: null, snapshot: latestSnapshot };
}
interface ChatWorkspaceSelectionInput {
  threadId: ThreadId;
  activeThread: Thread | undefined;
  activeProject: Project | undefined;
  activeRootBranch: string | null;
  isServerThread: boolean;
  isLocalDraftThread: boolean;
  isHomeChatContainer: boolean;
  isStudioContainer: boolean;
  hasNativeUserMessages: boolean;
  composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  scheduleComposerFocus: () => void;
  defaultProvider: ProviderKind;
}

export function useChatWorkspaceSelection({
  threadId,
  activeThread,
  activeProject,
  activeRootBranch,
  isServerThread,
  isLocalDraftThread,
  isHomeChatContainer,
  isStudioContainer,
  hasNativeUserMessages,
  composerEditorRef,
  scheduleComposerFocus,
  defaultProvider,
}: ChatWorkspaceSelectionInput) {
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const setStoreThreadWorkspace = useStore((store) => store.setThreadWorkspace);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const moveDraftThreadToProject = useComposerDraftStore((store) => store.moveDraftThreadToProject);
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      if (activeProject) {
        useProjectEnvironmentStore.getState().setProjectEnvMode(activeProject.id, mode);
      }
      const nextBranch =
        mode === "worktree"
          ? (activeThread?.branch ?? draftThread?.branch ?? activeRootBranch ?? null)
          : (activeThread?.branch ?? draftThread?.branch ?? null);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, {
          envMode: mode,
          ...(mode === "local" ? { worktreePath: null } : {}),
          ...(nextBranch ? { branch: nextBranch } : {}),
        });
      }
      if (isServerThread && activeThread && !hasNativeUserMessages && !activeThread.session) {
        const api = readNativeApi();
        if (api) {
          void api.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId,
            envMode: mode,
            ...(nextBranch ? { branch: nextBranch } : {}),
            ...(mode === "local" ? { worktreePath: null } : {}),
          });
        }
      }
      scheduleComposerFocus();
    },
    [
      activeProject,
      activeThread,
      activeRootBranch,
      draftThread?.branch,
      hasNativeUserMessages,
      isLocalDraftThread,
      isServerThread,
      scheduleComposerFocus,
      setDraftThreadContext,
      threadId,
    ],
  );

  const moveEmptyDraftToLocalProject = useCallback(
    (
      projectId: ProjectId,
      options?: {
        restoreComposerFocus?: boolean;
      },
    ) => {
      // Project moves reset branch; the previous project's current branch may not exist here.
      moveDraftThreadToProject(threadId, projectId, LOCAL_PROJECT_DRAFT_CONTEXT);
      if (options?.restoreComposerFocus ?? true) {
        scheduleComposerFocus();
      }
    },
    [moveDraftThreadToProject, scheduleComposerFocus, threadId],
  );

  const handleResetWorkspaceToHome = useCallback(() => {
    // The inline reset action prevents pointer-down from stealing editor focus. Avoid refocusing
    // an already-focused editor: focusAtEnd would move its cursor and schedule a redundant frame.
    // Picker-menu resets still restore focus because the editor is no longer active in that path.
    const restoreComposerFocus = !composerEditorRef.current?.isFocused();
    if (isLocalDraftThread) {
      if (isStudioContainer) {
        setDraftThreadContext(threadId, {
          envMode: "local",
          branch: null,
          worktreePath: null,
          workingDirectory: null,
          lastKnownPr: null,
        });
        if (restoreComposerFocus) {
          scheduleComposerFocus();
        }
        return;
      }
      if (!isHomeChatContainer) {
        return (async () => {
          if (!homeDir) {
            throw new Error("Home folder is not available yet.");
          }
          const homeProjectId = await ensureHomeChatProject({ homeDir, chatWorkspaceRoot });
          if (!homeProjectId) {
            throw new Error("Unable to prepare a normal chat.");
          }
          const api = readNativeApi();
          if (!api) {
            throw new Error("App is still connecting. Try again in a moment.");
          }
          const hasHomeProjectInStore = useStore
            .getState()
            .projects.some((project) => project.id === homeProjectId);
          if (!hasHomeProjectInStore) {
            const { project, snapshot } = await waitForShellProjectById(api, homeProjectId);
            if (!project || !snapshot) {
              throw new Error(PROJECT_CREATE_SYNC_ERROR);
            }
            syncServerShellSnapshot(snapshot);
          }
          moveEmptyDraftToLocalProject(homeProjectId, { restoreComposerFocus });
        })();
      }
      setDraftThreadContext(threadId, {
        envMode: "local",
        worktreePath: null,
        workingDirectory: null,
        branch: null,
        lastKnownPr: null,
      });
      if (restoreComposerFocus) {
        scheduleComposerFocus();
      }
      return;
    }

    if (activeThread) {
      setStoreThreadWorkspace(activeThread.id, {
        envMode: "local",
        worktreePath: null,
        ...(isStudioContainer ? { workingDirectory: null } : {}),
      });
      const api = readNativeApi();
      if (api && !hasNativeUserMessages && !activeThread.session) {
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThread.id,
          envMode: "local",
          worktreePath: null,
          ...(isStudioContainer ? { workingDirectory: null } : {}),
        });
      }
    }
    if (restoreComposerFocus) {
      scheduleComposerFocus();
    }
  }, [
    composerEditorRef,
    activeThread,
    chatWorkspaceRoot,
    hasNativeUserMessages,
    homeDir,
    isHomeChatContainer,
    isLocalDraftThread,
    isStudioContainer,
    moveEmptyDraftToLocalProject,
    scheduleComposerFocus,
    setDraftThreadContext,
    setStoreThreadWorkspace,
    syncServerShellSnapshot,
    threadId,
  ]);

  const handleSelectWorkspaceRoot = useCallback(
    (workspaceRoot: string) => {
      if (isStudioContainer) {
        if (isLocalDraftThread) {
          setDraftThreadContext(threadId, {
            envMode: "local",
            branch: null,
            worktreePath: null,
            workingDirectory: workspaceRoot,
          });
        } else if (activeThread) {
          setStoreThreadWorkspace(activeThread.id, {
            envMode: "local",
            branch: null,
            worktreePath: null,
            workingDirectory: workspaceRoot,
          });
          if (!hasNativeUserMessages && !activeThread.session) {
            const api = readNativeApi();
            if (api) {
              void api.orchestration.dispatchCommand({
                type: "thread.meta.update",
                commandId: newCommandId(),
                threadId: activeThread.id,
                envMode: "local",
                branch: null,
                worktreePath: null,
                workingDirectory: workspaceRoot,
              });
            }
          }
        }
        scheduleComposerFocus();
        return;
      }
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, {
          envMode: "worktree",
          worktreePath: workspaceRoot,
        });
        scheduleComposerFocus();
        return;
      }

      if (activeThread) {
        setStoreThreadWorkspace(activeThread.id, {
          envMode: "worktree",
          worktreePath: workspaceRoot,
        });
      }
      scheduleComposerFocus();
    },
    [
      activeThread,
      hasNativeUserMessages,
      isLocalDraftThread,
      isStudioContainer,
      scheduleComposerFocus,
      setDraftThreadContext,
      setStoreThreadWorkspace,
      threadId,
    ],
  );

  const handleSelectProjectForEmptyDraft = useCallback(
    (projectId: ProjectId) => {
      if (!isLocalDraftThread) {
        return;
      }
      const project = useStore
        .getState()
        .projects.find((candidate) => candidate.id === projectId && candidate.kind === "project");
      if (!project) {
        throw new Error("Selected project is not available.");
      }
      if (draftThread?.projectId === projectId) {
        scheduleComposerFocus();
        return;
      }
      moveEmptyDraftToLocalProject(projectId);
    },
    [
      draftThread?.projectId,
      isLocalDraftThread,
      moveEmptyDraftToLocalProject,
      scheduleComposerFocus,
    ],
  );

  const handleCreateProjectFromPickerPath = useCallback(
    async (workspaceRoot: string) => {
      if (!isLocalDraftThread) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        throw new Error("App is still connecting. Try again in a moment.");
      }

      const existingProject = useStore
        .getState()
        .projects.find(
          (project) =>
            project.kind === "project" && workspaceRootsEqual(project.cwd, workspaceRoot),
        );
      if (existingProject) {
        handleSelectProjectForEmptyDraft(existingProject.id);
        return;
      }

      const creationResult = await createOrRecoverProjectFromPath({
        api,
        workspaceRoot,
        createIfMissing: false,
        defaultProvider: defaultProvider,
        loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
      });
      if (creationResult.snapshot) {
        syncServerShellSnapshot(creationResult.snapshot);
      }
      if (!creationResult.created && !creationResult.project) {
        throw new Error(PROJECT_CREATE_EXISTING_SYNC_ERROR);
      }
      if (!creationResult.project) {
        throw new Error(PROJECT_CREATE_SYNC_ERROR);
      }
      moveEmptyDraftToLocalProject(creationResult.project.id);
    },
    [
      handleSelectProjectForEmptyDraft,
      isLocalDraftThread,
      moveEmptyDraftToLocalProject,
      defaultProvider,
      syncServerShellSnapshot,
    ],
  );
  return {
    onEnvModeChange,
    handleResetWorkspaceToHome,
    handleSelectWorkspaceRoot,
    handleSelectProjectForEmptyDraft,
    handleCreateProjectFromPickerPath,
  };
}
