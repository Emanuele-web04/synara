// Purpose: Add-project / projection-lag recovery flow extracted from Sidebar.tsx.
// Layer: web hook (client-side orchestration). Owns add-project UI state; navigation/store mutations are passed in.
// Exports: useSidebarProjectActions, SidebarProjectActionsDeps, SidebarProjectActions.

import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { useNavigate } from "@tanstack/react-router";
import { type OrchestrationShellSnapshot, ProjectId } from "@t3tools/contracts";
import { isNonEmpty as isNonEmptyString } from "effect/String";
import { getDefaultModel } from "@t3tools/shared/model";
import { readNativeApi } from "../nativeApi";
import { newCommandId, newProjectId } from "../lib/utils";
import {
  waitForRecoverableProjectForDuplicateCreate,
  waitForRecoverableProjectInReadModel,
} from "../lib/projectCreateRecovery";
import type { AppSettings } from "../appSettings";
import type { Project } from "../types";
import type { useHandleNewThread } from "../hooks/useHandleNewThread";
import { toastManager } from "./ui/toast";
import {
  extractDuplicateProjectCreateProjectId,
  findWorkspaceRootMatch,
  isDuplicateProjectCreateError,
  recoverExistingAddProjectTarget,
  sortThreadsForSidebar,
} from "./Sidebar.logic";

const ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS = 6;
const ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS = 50;
const ADD_PROJECT_EXISTING_SYNC_ERROR =
  "This folder is already linked, but the existing project has not synced into the sidebar yet. Try again in a moment.";

type HandleNewThread = ReturnType<typeof useHandleNewThread>["handleNewThread"];

export interface SidebarProjectActionsDeps {
  projects: readonly Project[];
  appSettings: Pick<AppSettings, "defaultThreadEnvMode" | "sidebarThreadSortOrder">;
  navigate: ReturnType<typeof useNavigate>;
  setProjectExpanded: (projectId: Project["id"], expanded: boolean) => void;
  handleNewThread: HandleNewThread;
  syncServerShellSnapshot: (snapshot: OrchestrationShellSnapshot) => void;
}

export interface SidebarProjectActions {
  newCwd: string;
  setNewCwd: Dispatch<SetStateAction<string>>;
  addProjectError: string | null;
  setAddProjectError: Dispatch<SetStateAction<string | null>>;
  addingProject: boolean;
  setAddingProject: Dispatch<SetStateAction<boolean>>;
  isAddingProject: boolean;
  setIsAddingProject: Dispatch<SetStateAction<boolean>>;
  isPickingFolder: boolean;
  setIsPickingFolder: Dispatch<SetStateAction<boolean>>;
  showManualPathInput: boolean;
  setShowManualPathInput: Dispatch<SetStateAction<boolean>>;
  addProjectFromPath: (rawCwd: string, options?: { createIfMissing?: boolean }) => Promise<void>;
  handleAddProject: () => void;
  canAddProject: boolean;
  handlePickFolder: () => Promise<void>;
  handleStartAddProject: () => void;
}

export function useSidebarProjectActions(deps: SidebarProjectActionsDeps): SidebarProjectActions {
  const {
    projects,
    appSettings,
    navigate,
    setProjectExpanded,
    handleNewThread,
    syncServerShellSnapshot,
  } = deps;

  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [showManualPathInput, setShowManualPathInput] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);

  const openOrCreateProjectThreadFromSnapshot = useCallback(
    async (projectId: ProjectId, snapshot: OrchestrationShellSnapshot) => {
      const latestThread = sortThreadsForSidebar(
        snapshot.threads
          .filter(
            (thread) => thread.projectId === projectId && (thread.archivedAt ?? null) === null,
          )
          .map((thread) => ({
            id: thread.id,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            latestUserMessageAt: thread.latestUserMessageAt,
          })),
        appSettings.sidebarThreadSortOrder,
      )[0];
      if (latestThread) {
        await navigate({
          to: "/$threadId",
          params: { threadId: latestThread.id },
        });
        return;
      }

      void handleNewThread(projectId, {
        envMode: appSettings.defaultThreadEnvMode,
      }).catch(() => undefined);
    },
    [
      appSettings.defaultThreadEnvMode,
      appSettings.sidebarThreadSortOrder,
      handleNewThread,
      navigate,
    ],
  );

  const openExistingProjectFromSnapshot = useCallback(
    async (projectId: ProjectId, snapshot: OrchestrationShellSnapshot): Promise<boolean> => {
      const existingProject =
        snapshot.projects.find((candidate) => candidate.id === projectId) ?? null;
      if (!existingProject) {
        return false;
      }

      const latestThread = sortThreadsForSidebar(
        snapshot.threads
          .filter(
            (thread) => thread.projectId === projectId && (thread.archivedAt ?? null) === null,
          )
          .map((thread) => ({
            id: thread.id,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            latestUserMessageAt: thread.latestUserMessageAt,
          })),
        appSettings.sidebarThreadSortOrder,
      )[0];
      if (latestThread) {
        await navigate({
          to: "/$threadId",
          params: { threadId: latestThread.id },
        });
        return true;
      }

      setProjectExpanded(projectId, true);
      void handleNewThread(projectId, {
        envMode: appSettings.defaultThreadEnvMode,
      }).catch(() => undefined);
      return true;
    },
    [
      appSettings.defaultThreadEnvMode,
      appSettings.sidebarThreadSortOrder,
      handleNewThread,
      navigate,
      setProjectExpanded,
    ],
  );

  // Poll the server read model briefly after project.create so we only recover from fresh state.
  const waitForProjectInSnapshot = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      projectId: ProjectId,
    ): Promise<{
      project: OrchestrationShellSnapshot["projects"][number] | null;
      snapshot: OrchestrationShellSnapshot | null;
    }> =>
      waitForRecoverableProjectInReadModel({
        projectId,
        loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
        maxAttempts: ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS,
        delayMs: ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS,
      }),
    [],
  );

  const waitForProjectWorkspaceRootInSnapshot = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      workspaceRoot: string,
    ): Promise<{
      project: OrchestrationShellSnapshot["projects"][number] | null;
      snapshot: OrchestrationShellSnapshot | null;
    }> =>
      waitForRecoverableProjectInReadModel({
        workspaceRoot,
        loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
        maxAttempts: ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS,
        delayMs: ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS,
      }),
    [],
  );

  // Keep add-project recovery on the same fresh-snapshot path for create, duplicate, and existing-project flows.
  const recoverProjectThreadFromServer = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      projectId: ProjectId,
    ): Promise<boolean> => {
      const { project, snapshot } = await waitForProjectInSnapshot(api, projectId);
      if (snapshot) {
        syncServerShellSnapshot(snapshot);
      }
      if (!project || !snapshot) {
        return false;
      }

      await openOrCreateProjectThreadFromSnapshot(project.id, snapshot);
      return true;
    },
    [openOrCreateProjectThreadFromSnapshot, syncServerShellSnapshot, waitForProjectInSnapshot],
  );

  const recoverExistingProjectFromServer = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      projectId: ProjectId,
    ): Promise<boolean> => {
      const { project, snapshot } = await waitForProjectInSnapshot(api, projectId);
      if (snapshot) {
        syncServerShellSnapshot(snapshot);
      }
      if (!project || !snapshot) {
        return false;
      }

      return openExistingProjectFromSnapshot(project.id, snapshot);
    },
    [openExistingProjectFromSnapshot, syncServerShellSnapshot, waitForProjectInSnapshot],
  );

  const recoverExistingProjectByWorkspaceRootFromServer = useCallback(
    async (
      api: NonNullable<ReturnType<typeof readNativeApi>>,
      workspaceRoot: string,
    ): Promise<boolean> => {
      const { project, snapshot } = await waitForProjectWorkspaceRootInSnapshot(api, workspaceRoot);
      if (snapshot) {
        syncServerShellSnapshot(snapshot);
      }
      if (!project || !snapshot) {
        return false;
      }

      return openExistingProjectFromSnapshot(project.id, snapshot);
    },
    [
      openExistingProjectFromSnapshot,
      syncServerShellSnapshot,
      waitForProjectWorkspaceRootInSnapshot,
    ],
  );

  const addProjectFromPath = useCallback(
    async (rawCwd: string, options: { createIfMissing?: boolean } = {}) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return;
      const api = readNativeApi();
      if (!api) return;

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
        setNewCwd("");
        setAddProjectError(null);
        setAddingProject(false);
      };

      try {
        const existing = findWorkspaceRootMatch(projects, cwd, (project) => project.cwd);
        const existingRecovery = await recoverExistingAddProjectTarget({
          existingProjectId: existing?.id,
          workspaceRoot: cwd,
          recoverByProjectId: (projectId) => recoverExistingProjectFromServer(api, projectId),
          recoverByWorkspaceRoot: (workspaceRoot) =>
            recoverExistingProjectByWorkspaceRootFromServer(api, workspaceRoot),
        });
        if (existingRecovery === "recovered") {
          finishAddingProject();
          return;
        }
        if (existing) {
          // Local project state can briefly outlive a server-side project.deleted event.
          // Continue to project.create so re-adding the folder revives it instead of opening a dead shell.
        }

        const projectId = newProjectId();
        const createdAt = new Date().toISOString();
        const title = cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd;
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          kind: "project",
          title,
          workspaceRoot: cwd,
          createWorkspaceRootIfMissing: options.createIfMissing === true,
          defaultModelSelection: {
            provider: "codex",
            model: getDefaultModel("codex"),
          },
          createdAt,
        });
        const recovered = await recoverProjectThreadFromServer(api, projectId);
        if (recovered) {
          finishAddingProject();
          return;
        }

        // The command already committed successfully at this point. If the projection
        // snapshot is just slow to catch up, continue with the local new-thread flow
        // instead of surfacing a false-negative sidebar sync error.
        setProjectExpanded(projectId, true);
        void handleNewThread(projectId, {
          envMode: appSettings.defaultThreadEnvMode,
        }).catch(() => undefined);
        finishAddingProject();
        return;
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        if (isDuplicateProjectCreateError(description)) {
          try {
            const { project, snapshot } = await waitForRecoverableProjectForDuplicateCreate({
              message: description,
              workspaceRoot: cwd,
              loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
              maxAttempts: ADD_PROJECT_SNAPSHOT_CATCH_UP_MAX_ATTEMPTS,
              delayMs: ADD_PROJECT_SNAPSHOT_CATCH_UP_DELAY_MS,
            });
            if (snapshot) {
              syncServerShellSnapshot(snapshot);
            }
            if (project && snapshot) {
              const recovered = await openExistingProjectFromSnapshot(project.id, snapshot);
              if (recovered) {
                finishAddingProject();
                return;
              }
            }

            const duplicateProjectId = extractDuplicateProjectCreateProjectId(description);
            const recovered = duplicateProjectId
              ? await recoverExistingProjectFromServer(
                  api,
                  ProjectId.makeUnsafe(duplicateProjectId),
                )
              : await recoverExistingProjectByWorkspaceRootFromServer(api, cwd);
            if (recovered) {
              finishAddingProject();
              return;
            }

            setIsAddingProject(false);
            throw new Error(ADD_PROJECT_EXISTING_SYNC_ERROR);
          } catch (recoveryError) {
            setIsAddingProject(false);
            throw recoveryError;
          }
        }
        setIsAddingProject(false);
        throw error instanceof Error ? error : new Error(description);
      }
    },
    [
      appSettings.defaultThreadEnvMode,
      handleNewThread,
      isAddingProject,
      projects,
      recoverExistingProjectFromServer,
      recoverExistingProjectByWorkspaceRootFromServer,
      recoverProjectThreadFromServer,
      openExistingProjectFromSnapshot,
      setProjectExpanded,
      syncServerShellSnapshot,
    ],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd, { createIfMissing: true }).catch((error: unknown) => {
      const description =
        error instanceof Error ? error.message : "An error occurred while adding the project.";
      setAddProjectError(description);
    });
  };

  const canAddProject = newCwd.trim().length > 0 && !isAddingProject;

  // Keep the native folder picker and project creation in one awaited flow so
  // the UI can show whether we're still opening the dialog or creating the project.
  const handlePickFolder = useCallback(async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    try {
      const pickedPath = await api.dialogs.pickFolder();
      setIsPickingFolder(false);
      if (pickedPath) {
        setAddProjectError(null);
        await addProjectFromPath(pickedPath).catch((error: unknown) => {
          const description =
            error instanceof Error ? error.message : "An error occurred while adding the project.";
          setAddProjectError(description);
          toastManager.add({
            type: "error",
            title: "Unable to add project",
            description,
          });
        });
      }
    } catch (error) {
      const description =
        error instanceof Error ? error.message : "Unable to open the folder picker.";
      setAddProjectError(description);
      toastManager.add({
        type: "error",
        title: "Unable to open folder picker",
        description,
      });
      setIsPickingFolder(false);
    }
  }, [isPickingFolder, addProjectFromPath]);

  const handleStartAddProject = useCallback(() => {
    setAddProjectError(null);
    setShowManualPathInput(false);
    setAddingProject((prev) => !prev);
  }, []);

  return {
    newCwd,
    setNewCwd,
    addProjectError,
    setAddProjectError,
    addingProject,
    setAddingProject,
    isAddingProject,
    setIsAddingProject,
    isPickingFolder,
    setIsPickingFolder,
    showManualPathInput,
    setShowManualPathInput,
    addProjectFromPath,
    handleAddProject,
    canAddProject,
    handlePickFolder,
    handleStartAddProject,
  };
}
