// Purpose: Workspace rows, rename state, and create/delete/reorder handlers extracted from Sidebar.tsx.
// Layer: web hook (client-side orchestration). Owns workspace-specific state; navigation is passed in.
// Exports: useSidebarWorkspaces, SidebarWorkspacesDeps, SidebarWorkspaces.

import { useCallback, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { readNativeApi } from "../nativeApi";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useWorkspaceStore, workspaceThreadId } from "../workspaceStore";
import { terminalRuntimeRegistry } from "./terminal/terminalRuntimeRegistry";
import { terminalStatusFromThreadState } from "./Sidebar.logic";

type TerminalStatus = ReturnType<typeof terminalStatusFromThreadState>;

type WorkspacePage = ReturnType<typeof useWorkspaceStore.getState>["workspacePages"][number];

export interface SidebarWorkspaceRow extends WorkspacePage {
  terminalCount: number;
  terminalStatus: TerminalStatus;
  runningTerminalIds: readonly string[];
}

export interface SidebarWorkspacesDeps {
  routeWorkspaceId: string | null;
  navigateToWorkspace: (workspaceId: string, options?: { replace?: boolean }) => void;
}

export interface SidebarWorkspaces {
  workspaceRows: SidebarWorkspaceRow[];
  renamingWorkspaceId: string | null;
  renamingWorkspaceTitle: string;
  setRenamingWorkspaceId: Dispatch<SetStateAction<string | null>>;
  setRenamingWorkspaceTitle: Dispatch<SetStateAction<string>>;
  handleCreateWorkspace: () => void;
  beginWorkspaceRename: (workspaceId: string, title: string) => void;
  commitWorkspaceRename: () => void;
  handleDeleteWorkspace: (workspaceId: string) => Promise<void>;
  handleWorkspaceDragEnd: (event: DragEndEvent) => void;
}

export function useSidebarWorkspaces(deps: SidebarWorkspacesDeps): SidebarWorkspaces {
  const { routeWorkspaceId, navigateToWorkspace } = deps;

  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const workspacePages = useWorkspaceStore((store) => store.workspacePages);
  const createWorkspace = useWorkspaceStore((store) => store.createWorkspace);
  const renameWorkspace = useWorkspaceStore((store) => store.renameWorkspace);
  const deleteWorkspace = useWorkspaceStore((store) => store.deleteWorkspace);
  const reorderWorkspace = useWorkspaceStore((store) => store.reorderWorkspace);

  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null);
  const [renamingWorkspaceTitle, setRenamingWorkspaceTitle] = useState("");

  const workspaceRows = useMemo(
    () =>
      workspacePages.map((workspace) => {
        const terminalState = selectThreadTerminalState(
          terminalStateByThreadId,
          workspaceThreadId(workspace.id),
        );
        return {
          ...workspace,
          terminalCount: terminalState.terminalOpen ? terminalState.terminalIds.length : 0,
          terminalStatus: terminalStatusFromThreadState({
            runningTerminalIds: terminalState.runningTerminalIds,
            terminalAttentionStatesById: terminalState.terminalAttentionStatesById,
          }),
          runningTerminalIds: terminalState.runningTerminalIds,
        };
      }),
    [terminalStateByThreadId, workspacePages],
  );

  const handleCreateWorkspace = useCallback(() => {
    const workspaceId = createWorkspace();
    navigateToWorkspace(workspaceId);
  }, [createWorkspace, navigateToWorkspace]);

  const beginWorkspaceRename = useCallback((workspaceId: string, title: string) => {
    setRenamingWorkspaceId(workspaceId);
    setRenamingWorkspaceTitle(title);
  }, []);

  const commitWorkspaceRename = useCallback(() => {
    if (!renamingWorkspaceId) {
      return;
    }
    renameWorkspace(renamingWorkspaceId, renamingWorkspaceTitle);
    setRenamingWorkspaceId(null);
  }, [renameWorkspace, renamingWorkspaceId, renamingWorkspaceTitle]);

  const handleDeleteWorkspace = useCallback(
    async (workspaceId: string) => {
      const workspaceThread = workspaceThreadId(workspaceId);
      const api = readNativeApi();
      const terminalState = selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadId,
        workspaceThread,
      );

      if (api && typeof api.terminal.close === "function") {
        terminalRuntimeRegistry.disposeThread(workspaceThread);
        await Promise.allSettled(
          terminalState.terminalIds.map((terminalId) =>
            api.terminal.close({
              threadId: workspaceThread,
              terminalId,
              deleteHistory: true,
            }),
          ),
        );
      }

      clearTerminalState(workspaceThread);
      deleteWorkspace(workspaceId);

      const nextWorkspaceId = useWorkspaceStore.getState().workspacePages[0]?.id ?? null;
      if (routeWorkspaceId === workspaceId && nextWorkspaceId) {
        navigateToWorkspace(nextWorkspaceId, { replace: true });
      }
    },
    [clearTerminalState, deleteWorkspace, navigateToWorkspace, routeWorkspaceId],
  );

  const handleWorkspaceDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }
      const nextIndex = workspacePages.findIndex((workspace) => workspace.id === String(over.id));
      if (nextIndex < 0) {
        return;
      }
      reorderWorkspace(String(active.id), nextIndex);
    },
    [reorderWorkspace, workspacePages],
  );

  return {
    workspaceRows,
    renamingWorkspaceId,
    renamingWorkspaceTitle,
    setRenamingWorkspaceId,
    setRenamingWorkspaceTitle,
    handleCreateWorkspace,
    beginWorkspaceRename,
    commitWorkspaceRename,
    handleDeleteWorkspace,
    handleWorkspaceDragEnd,
  };
}
