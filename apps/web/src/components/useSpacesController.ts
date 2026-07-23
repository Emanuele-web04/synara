// FILE: useSpacesController.ts
// Purpose: All Space selection, editing, deletion, and assignment behavior behind the sidebar.
// Layer: Sidebar controller hook
// Why: Sidebar.tsx is the largest component in the app; the Spaces feature is a
//      self-contained unit of handlers, dialog state, and sync effects. One seam here
//      (inputs in, handlers out) keeps it reviewable instead of interleaved through an
//      8k-line component.

import type { ProjectId, SpaceId, ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { startTransition, useCallback, useEffect, useMemo, useState } from "react";

import type { SidebarThreadSortOrder } from "../appSettings";
import {
  createSpace,
  deleteSpace,
  isOrdinarySpaceProject,
  moveProjectToSpace,
  moveProjectsToSpace,
  reorderSpaces,
  updateSpace,
} from "../lib/spaces";
import { readNativeApi } from "../nativeApi";
import { useSpacesUiStore } from "../spacesUiStore";
import { useStore } from "../store";
import type { Project, SidebarThreadSummary, Space } from "../types";
import { useWorkspaceStore } from "../workspaceStore";
import { sortThreadsForSidebar } from "./Sidebar.logic";
import type { SpaceEditorValue } from "./SpaceEditorDialog";
import { useRouteSpaceSync } from "./useRouteSpaceSync";
import { toastManager } from "./ui/toast";

type SpaceEditorState =
  | { mode: "create"; projectIdAfterCreate: ProjectId | null }
  | { mode: "edit"; spaceId: SpaceId };

export function useSpacesController(input: {
  /** Ordinary (space-assignable) projects; computed by Sidebar because its own memos need it too. */
  ordinarySpaceProjects: readonly Project[];
  projectById: ReadonlyMap<ProjectId, Project>;
  sidebarThreads: readonly SidebarThreadSummary[];
  sidebarThreadSortOrder: SidebarThreadSortOrder;
  routeThreadId: ThreadId | null;
  routeProjectId: ProjectId | null;
  isOnKanban: boolean;
  activeRouteProject: Project | null;
  activeRouteProjectId: ProjectId | null;
  activateThreadFromSidebarIntent: (threadId: ThreadId) => void;
  /** Space moves are offered from the project context menu; the menu closes on action. */
  onCloseProjectContextMenu: () => void;
}) {
  const {
    activateThreadFromSidebarIntent,
    activeRouteProject,
    activeRouteProjectId,
    isOnKanban,
    onCloseProjectContextMenu,
    ordinarySpaceProjects,
    projectById,
    routeProjectId,
    routeThreadId,
    sidebarThreadSortOrder,
    sidebarThreads,
  } = input;

  const navigate = useNavigate();
  const spaces = useStore((store) => store.spaces);
  const reorderSpacesLocally = useStore((store) => store.reorderSpacesLocally);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const shellSnapshotSequence = useStore((store) => store.shellSnapshotSequence ?? 0);
  const activeSpaceId = useSpacesUiStore((store) => store.activeSpaceId);
  const setActiveSpaceId = useSpacesUiStore((store) => store.setActiveSpaceId);
  const setOptimisticActiveSpaceId = useSpacesUiStore((store) => store.setOptimisticActiveSpaceId);
  const rememberSpaceThread = useSpacesUiStore((store) => store.rememberThread);
  const rememberSpaceProject = useSpacesUiStore((store) => store.rememberProject);
  const getLastSpaceThreadId = useSpacesUiStore((store) => store.getLastThreadId);
  const getLastSpaceProjectId = useSpacesUiStore((store) => store.getLastProjectId);
  const reconcileSpacesUi = useSpacesUiStore((store) => store.reconcile);
  const homeDir = useWorkspaceStore((store) => store.homeDir);
  const chatWorkspaceRoot = useWorkspaceStore((store) => store.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspaceStore((store) => store.studioWorkspaceRoot);
  const workspacePaths = useMemo(
    () => ({ homeDir, chatWorkspaceRoot, studioWorkspaceRoot }),
    [chatWorkspaceRoot, homeDir, studioWorkspaceRoot],
  );

  const routeSpaceProject =
    isOnKanban && routeProjectId ? (projectById.get(routeProjectId) ?? null) : activeRouteProject;
  const routeSpaceContext = isOrdinarySpaceProject(routeSpaceProject, workspacePaths)
    ? { projectId: routeSpaceProject.id, spaceId: routeSpaceProject.spaceId ?? null }
    : null;
  const routeSpaceProjectId = routeSpaceContext?.projectId ?? null;
  const routeSpaceId = routeSpaceContext ? routeSpaceContext.spaceId : undefined;

  const [spaceEditorState, setSpaceEditorState] = useState<SpaceEditorState | null>(null);
  const [spaceProjectPickerTargetId, setSpaceProjectPickerTargetId] = useState<SpaceId | null>(
    null,
  );

  useEffect(() => {
    if (!threadsHydrated) return;
    reconcileSpacesUi({
      activeSpaceIds: new Set(spaces.map((space) => space.id)),
      snapshotSequence: shellSnapshotSequence,
      projectSpaceById: new Map(
        ordinarySpaceProjects.map((project) => [project.id, project.spaceId ?? null] as const),
      ),
      threadProjectById: new Map(
        sidebarThreads
          .filter((thread) => thread.archivedAt == null)
          .map((thread) => [thread.id, thread.projectId] as const),
      ),
    });
  }, [
    ordinarySpaceProjects,
    reconcileSpacesUi,
    shellSnapshotSequence,
    sidebarThreads,
    spaces,
    threadsHydrated,
  ]);

  useRouteSpaceSync({
    isOnKanban,
    routeProjectId: routeSpaceProjectId,
    routeSpaceId,
    routeThreadId,
  });

  const selectSpaceForNavigation = useCallback(
    (spaceId: SpaceId | null) => {
      setActiveSpaceId(spaceId);
    },
    [setActiveSpaceId],
  );

  // Bookmark the context being left so returning to that space restores it.
  const rememberDepartingSpaceContext = useCallback(() => {
    const currentRouteSpaceProject =
      isOnKanban && routeProjectId ? (projectById.get(routeProjectId) ?? null) : activeRouteProject;
    if (routeThreadId && isOrdinarySpaceProject(currentRouteSpaceProject, workspacePaths)) {
      rememberSpaceThread(currentRouteSpaceProject.spaceId ?? null, routeThreadId);
    } else if (isOnKanban && isOrdinarySpaceProject(currentRouteSpaceProject, workspacePaths)) {
      rememberSpaceProject(currentRouteSpaceProject.spaceId ?? null, currentRouteSpaceProject.id);
    }
  }, [
    activeRouteProject,
    isOnKanban,
    projectById,
    rememberSpaceProject,
    rememberSpaceThread,
    routeProjectId,
    routeThreadId,
    workspacePaths,
  ]);

  /**
   * Switch spaces without restoring the target space's last context. Used when the
   * caller is about to navigate itself (creating a project files it into the target
   * space and then opens its first thread) — the restore navigation would race it.
   */
  const handleSelectSpaceForIncomingProject = useCallback(
    (spaceId: SpaceId | null) => {
      // Read the live value so an async create flow can roll back a provisional
      // selection with the same callback instance it used to select it.
      if (spaceId === useSpacesUiStore.getState().activeSpaceId) return;
      rememberDepartingSpaceContext();
      selectSpaceForNavigation(spaceId);
    },
    [rememberDepartingSpaceContext, selectSpaceForNavigation],
  );

  const handleSelectSpace = useCallback(
    (spaceId: SpaceId | null) => {
      if (spaceId === activeSpaceId) return;

      rememberDepartingSpaceContext();

      selectSpaceForNavigation(spaceId);

      const availableThreads = sidebarThreads.filter((thread) => {
        if (thread.archivedAt != null) return false;
        const project = projectById.get(thread.projectId);
        return (
          isOrdinarySpaceProject(project, workspacePaths) && (project.spaceId ?? null) === spaceId
        );
      });
      const rememberedThreadId = getLastSpaceThreadId(spaceId);
      const rememberedThread = rememberedThreadId
        ? availableThreads.find((thread) => thread.id === rememberedThreadId)
        : null;
      if (rememberedThread) {
        activateThreadFromSidebarIntent(rememberedThread.id);
        return;
      }

      const rememberedProjectId = getLastSpaceProjectId(spaceId);
      const rememberedProject = rememberedProjectId
        ? ordinarySpaceProjects.find(
            (project) =>
              project.id === rememberedProjectId && (project.spaceId ?? null) === spaceId,
          )
        : null;
      if (rememberedProject) {
        startTransition(() => {
          void navigate({
            to: "/kanban/$projectId",
            params: { projectId: rememberedProject.id },
          });
        });
        return;
      }

      const targetThread =
        sortThreadsForSidebar(availableThreads, sidebarThreadSortOrder)[0] ?? null;
      if (targetThread) {
        activateThreadFromSidebarIntent(targetThread.id);
        return;
      }

      startTransition(() => {
        void navigate({ to: "/" });
      });
    },
    [
      activateThreadFromSidebarIntent,
      activeSpaceId,
      getLastSpaceProjectId,
      getLastSpaceThreadId,
      navigate,
      ordinarySpaceProjects,
      projectById,
      rememberDepartingSpaceContext,
      selectSpaceForNavigation,
      sidebarThreadSortOrder,
      sidebarThreads,
      workspacePaths,
    ],
  );

  const handleSpaceEditorSubmit = useCallback(
    async (value: SpaceEditorValue) => {
      const api = readNativeApi();
      if (!api || !spaceEditorState) {
        throw new Error("The app server is unavailable.");
      }

      if (spaceEditorState.mode === "edit") {
        // Only actual changes are sent, so an icon-only edit cannot collide with a
        // concurrent rename; saving with nothing changed is a plain close, not a
        // command — the server rejects no-op metadata updates.
        const currentSpace = spaces.find((space) => space.id === spaceEditorState.spaceId);
        const nextName = currentSpace?.name === value.name ? undefined : value.name;
        const nextIcon = currentSpace?.icon === value.icon ? undefined : value.icon;
        if (nextName === undefined && nextIcon === undefined) {
          return;
        }
        await updateSpace({
          api,
          spaceId: spaceEditorState.spaceId,
          name: nextName,
          icon: nextIcon,
        });
        return;
      }

      const { spaceId, sequence } = await createSpace({ api, name: value.name, icon: value.icon });
      const projectId = spaceEditorState.projectIdAfterCreate;
      if (projectId) {
        try {
          await moveProjectToSpace({ api, projectId, spaceId });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: `${value.name} was created, but the project was not moved`,
            description: error instanceof Error ? error.message : "Try moving the project again.",
          });
          return;
        }

        if (activeRouteProjectId === projectId || (isOnKanban && routeProjectId === projectId)) {
          selectSpaceForNavigation(spaceId);
          setOptimisticActiveSpaceId(spaceId, sequence);
        }
        return;
      }

      handleSelectSpace(spaceId);
      setOptimisticActiveSpaceId(spaceId, sequence);
      setSpaceProjectPickerTargetId(spaceId);
    },
    [
      activeRouteProjectId,
      handleSelectSpace,
      isOnKanban,
      routeProjectId,
      selectSpaceForNavigation,
      setOptimisticActiveSpaceId,
      spaceEditorState,
      spaces,
    ],
  );

  const handleDeleteSpace = useCallback(
    async (spaceId: SpaceId) => {
      const api = readNativeApi();
      const space = spaces.find((candidate) => candidate.id === spaceId);
      if (!api || !space) return;
      const projectCount = ordinarySpaceProjects.filter(
        (project) => (project.spaceId ?? null) === spaceId,
      ).length;
      const confirmed = await api.dialogs.confirm(
        projectCount > 0
          ? `Delete “${space.name}”?\n\n${projectCount} project${projectCount === 1 ? "" : "s"} will move to Void.`
          : `Delete “${space.name}”?`,
      );
      if (!confirmed) return;

      try {
        await deleteSpace({ api, spaceId });
        if (activeSpaceId === spaceId) {
          selectSpaceForNavigation(null);
          const activeContextProject =
            activeRouteProject ??
            (isOnKanban && routeProjectId ? (projectById.get(routeProjectId) ?? null) : null);
          if (!isOrdinarySpaceProject(activeContextProject, workspacePaths)) {
            void navigate({ to: "/" });
          }
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to delete space",
          description: error instanceof Error ? error.message : "Try again.",
        });
      }
    },
    [
      activeRouteProject,
      activeSpaceId,
      isOnKanban,
      navigate,
      ordinarySpaceProjects,
      projectById,
      routeProjectId,
      selectSpaceForNavigation,
      spaces,
      workspacePaths,
    ],
  );

  const handleRenameSpace = useCallback(async (space: Space, name: string) => {
    const api = readNativeApi();
    if (!api || space.name === name) return;
    try {
      await updateSpace({ api, spaceId: space.id, name });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to rename space",
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
  }, []);

  const handleReorderSpaces = useCallback(
    (orderedSpaceIds: ReadonlyArray<SpaceId>, movedSpaceId: SpaceId) => {
      const api = readNativeApi();
      if (!api) return;
      reorderSpacesLocally(orderedSpaceIds);
      void reorderSpaces({ api, movedSpaceId, orderedSpaceIds }).catch(async (error) => {
        try {
          // A transport error can arrive after the command committed. Re-read the authoritative
          // shell instead of blindly rolling back a reorder the server may already have stored.
          const snapshot = await api.orchestration.getShellSnapshot();
          useStore.getState().syncServerShellSnapshot(snapshot);
          const confirmedSpaceIds = snapshot.spaces.map((space) => space.id);
          if (
            confirmedSpaceIds.length === orderedSpaceIds.length &&
            confirmedSpaceIds.every((spaceId, index) => spaceId === orderedSpaceIds[index])
          ) {
            return;
          }
        } catch {
          // Keep the optimistic order when authority cannot be reached; the next shell snapshot
          // will reconcile it without risking a false rollback after a successful commit.
        }
        toastManager.add({
          type: "error",
          title: "Unable to confirm space order",
          description: error instanceof Error ? error.message : "Try again.",
        });
      });
    },
    [reorderSpacesLocally],
  );

  const handleBulkMoveProjects = useCallback(
    async (projectIds: ReadonlyArray<ProjectId>, spaceId: SpaceId) => {
      const api = readNativeApi();
      if (!api) throw new Error("The app server is unavailable.");
      const result = await moveProjectsToSpace({ api, projectIds, spaceId });
      return result.failedProjectIds;
    },
    [],
  );

  const handleMoveProjectToSpace = useCallback(
    async (projectId: ProjectId, spaceId: SpaceId | null) => {
      const api = readNativeApi();
      const project = projectById.get(projectId);
      if (!api || !project || (project.spaceId ?? null) === spaceId) return;
      onCloseProjectContextMenu();
      try {
        await moveProjectToSpace({ api, projectId, spaceId });
        if (activeRouteProjectId === projectId || (isOnKanban && routeProjectId === projectId)) {
          selectSpaceForNavigation(spaceId);
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to move project",
          description: error instanceof Error ? error.message : "Try again.",
        });
      }
    },
    [
      activeRouteProjectId,
      isOnKanban,
      onCloseProjectContextMenu,
      projectById,
      routeProjectId,
      selectSpaceForNavigation,
    ],
  );

  const openSpaceCreator = useCallback((projectIdAfterCreate: ProjectId | null = null) => {
    setSpaceEditorState({ mode: "create", projectIdAfterCreate });
  }, []);
  const openSpaceEditor = useCallback((spaceId: SpaceId) => {
    setSpaceEditorState({ mode: "edit", spaceId });
  }, []);
  const closeSpaceEditor = useCallback(() => setSpaceEditorState(null), []);
  const openSpaceProjectPicker = useCallback(
    (spaceId: SpaceId) => setSpaceProjectPickerTargetId(spaceId),
    [],
  );
  const closeSpaceProjectPicker = useCallback(() => setSpaceProjectPickerTargetId(null), []);

  const activeSpace: Space | null = activeSpaceId
    ? (spaces.find((space) => space.id === activeSpaceId) ?? null)
    : null;
  const editedSpace: Space | null =
    spaceEditorState?.mode === "edit"
      ? (spaces.find((space) => space.id === spaceEditorState.spaceId) ?? null)
      : null;
  const spaceProjectPickerTarget: Space | null = spaceProjectPickerTargetId
    ? (spaces.find((space) => space.id === spaceProjectPickerTargetId) ?? null)
    : null;
  const spaceEditorExistingNames = spaces
    .filter((space) => space.id !== editedSpace?.id)
    .map((space) => space.name);

  return {
    activeSpace,
    editedSpace,
    spaceEditorOpen:
      spaceEditorState?.mode === "create" ||
      (spaceEditorState?.mode === "edit" && editedSpace !== null),
    spaceEditorMode: spaceEditorState?.mode ?? ("create" as const),
    spaceEditorExistingNames,
    spaceProjectPickerTarget,
    openSpaceCreator,
    openSpaceEditor,
    closeSpaceEditor,
    openSpaceProjectPicker,
    closeSpaceProjectPicker,
    handleSelectSpace,
    handleSelectSpaceForIncomingProject,
    handleReorderSpaces,
    handleRenameSpace,
    handleDeleteSpace,
    handleMoveProjectToSpace,
    handleSpaceEditorSubmit,
    handleBulkMoveProjects,
  };
}
