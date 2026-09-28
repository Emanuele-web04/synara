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
import { spaceKey, toSpaceIconName } from "../lib/spaceGrouping";
import { resolveSpaceSelectionTarget } from "../lib/spaceNavigation";
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
import { useVoidSpaceStore } from "../voidSpaceStore";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { sortThreadsForSidebar } from "./Sidebar.logic";
import type { SpaceEditorMode, SpaceEditorValue } from "./SpaceEditorDialog";
import { useRouteSpaceSync } from "./useRouteSpaceSync";
import { toastManager } from "./ui/toast";

type SpaceEditorState =
  | { mode: "create"; projectIdAfterCreate: ProjectId | null }
  | { mode: "edit"; spaceId: SpaceId }
  // Void has no row to update, so its edit ends in a local preference rather than a command.
  | { mode: "void" };

/**
 * Whether the server's space order already equals the one we applied optimistically.
 *
 * Module scope because the caller checks this inside a `try`, and React Compiler cannot lower a
 * logical expression there — inlining it costs the whole controller its memoization.
 */
function spaceOrderMatches(
  confirmed: ReadonlyArray<SpaceId>,
  expected: ReadonlyArray<SpaceId>,
): boolean {
  return (
    confirmed.length === expected.length && confirmed.every((id, index) => id === expected[index])
  );
}

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
  const voidSpace = useVoidSpaceStore((store) => store.voidSpace);
  const setVoidSpace = useVoidSpaceStore((store) => store.setVoidSpace);
  const resetVoidSpace = useVoidSpaceStore((store) => store.resetVoidSpace);
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((store) => store.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((store) => store.studioWorkspaceRoot);
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

      const target = resolveSpaceSelectionTarget({
        spaceId,
        projects: ordinarySpaceProjects,
        projectById,
        threads: sidebarThreads,
        rememberedThreadId: getLastSpaceThreadId(spaceId),
        rememberedProjectId: getLastSpaceProjectId(spaceId),
        paths: workspacePaths,
        sortThreads: (threads) => sortThreadsForSidebar(threads, sidebarThreadSortOrder),
      });

      if (target.kind === "thread") {
        activateThreadFromSidebarIntent(target.threadId);
        return;
      }

      if (target.kind === "project") {
        startTransition(() => {
          void navigate({
            to: "/kanban/$projectId",
            params: { projectId: target.projectId },
          });
        });
        return;
      }

      // An empty Space still has to be entered. The landing has to say *which* Space it is
      // entering: a bare "/" restores the last remembered thread route, which belongs to the
      // Space being left, and useRouteSpaceSync would then adopt that thread's Space and undo
      // the click. On an upgraded install every project keeps `spaceId = null`, so every
      // user-created Space is empty and this is the only path a Space switch can take.
      startTransition(() => {
        void navigate({ to: "/", search: { space: spaceKey(target.spaceId) } });
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
      if (spaceEditorState?.mode === "void") {
        // Presentation only: no command, no server round trip, nothing to fail.
        setVoidSpace(value);
        return;
      }

      const api = readNativeApi();
      if (!api || !spaceEditorState) {
        throw new Error("The app server is unavailable.");
      }
      const icon = toSpaceIconName(value.icon);

      if (spaceEditorState.mode === "edit") {
        // Only actual changes are sent, so an icon-only edit cannot collide with a
        // concurrent rename; saving with nothing changed is a plain close, not a
        // command — the server rejects no-op metadata updates.
        const currentSpace = spaces.find((space) => space.id === spaceEditorState.spaceId);
        const nextName = currentSpace?.name === value.name ? undefined : value.name;
        const nextIcon = currentSpace?.icon === icon ? undefined : icon;
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

      const { spaceId, sequence } = await createSpace({ api, name: value.name, icon });
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
      setVoidSpace,
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

      // Resolved before the `try`: React Compiler cannot lower a `??` chain inside a try block.
      const activeContextProject =
        activeRouteProject ??
        (isOnKanban && routeProjectId ? (projectById.get(routeProjectId) ?? null) : null);

      try {
        await deleteSpace({ api, spaceId });
        if (activeSpaceId === spaceId) {
          selectSpaceForNavigation(null);
          if (!isOrdinarySpaceProject(activeContextProject, workspacePaths)) {
            // Same explicit landing as an empty-Space switch: we just selected Void, so the
            // restore must not reopen a thread that files into some other Space.
            void navigate({ to: "/", search: { space: spaceKey(null) } });
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

  const handleRenameVoid = useCallback(
    (name: string) => {
      setVoidSpace({ name });
    },
    [setVoidSpace],
  );

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
          if (spaceOrderMatches(confirmedSpaceIds, orderedSpaceIds)) {
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
      // Evaluated before the `try` (see `spaceOrderMatches`); none of these inputs can change
      // across the await anyway.
      const movesTheRoutedProject =
        activeRouteProjectId === projectId || (isOnKanban && routeProjectId === projectId);
      try {
        await moveProjectToSpace({ api, projectId, spaceId });
        if (movesTheRoutedProject) {
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
  const openVoidEditor = useCallback(() => setSpaceEditorState({ mode: "void" }), []);
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
  const editingVoid = spaceEditorState?.mode === "void";
  /**
   * Void shares one namespace with the stored spaces: two identically named groups in the
   * same strip are indistinguishable, so whichever one is not being edited is off limits.
   */
  const spaceEditorExistingNames = [
    ...spaces.filter((space) => space.id !== editedSpace?.id).map((space) => space.name),
    ...(editingVoid ? [] : [voidSpace.name]),
  ];
  const spaceEditorInitialValue: SpaceEditorValue | null = editingVoid
    ? voidSpace
    : editedSpace
      ? { name: editedSpace.name, icon: editedSpace.icon }
      : null;

  return {
    activeSpace,
    voidSpace,
    editedSpace,
    spaceEditorOpen:
      spaceEditorState?.mode === "create" ||
      editingVoid ||
      (spaceEditorState?.mode === "edit" && editedSpace !== null),
    spaceEditorMode: (spaceEditorState?.mode ?? "create") as SpaceEditorMode,
    spaceEditorInitialValue,
    spaceEditorExistingNames,
    spaceProjectPickerTarget,
    openSpaceCreator,
    openSpaceEditor,
    openVoidEditor,
    closeSpaceEditor,
    openSpaceProjectPicker,
    closeSpaceProjectPicker,
    handleSelectSpace,
    handleSelectSpaceForIncomingProject,
    handleReorderSpaces,
    handleRenameSpace,
    handleRenameVoid,
    resetVoidSpace,
    handleDeleteSpace,
    handleMoveProjectToSpace,
    handleSpaceEditorSubmit,
    handleBulkMoveProjects,
  };
}
