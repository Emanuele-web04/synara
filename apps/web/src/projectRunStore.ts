// FILE: projectRunStore.ts
// Purpose: Client-side projection of the server-owned dev-server registry by runtime target.
// Layer: Web UI state
// Exports: useProjectRunStore plus exact workspace and aggregate project selectors.

import type {
  ProjectDevServer,
  ProjectDevServerTarget,
  ProjectId,
  WorktreeWorkspaceId,
} from "@synara/contracts";
import {
  projectDevServerTargetKey,
  type ProjectDevServerTargetKey,
} from "@synara/shared/projectDevServers";
import { create } from "zustand";

export type ProjectRunStatus = ProjectDevServer["status"];
export type ProjectRunState = ProjectDevServer;
export type ProjectRunsByTargetKey = Record<ProjectDevServerTargetKey, ProjectRunState>;

type RemoveProjectRun = (
  targetOrProjectId: ProjectDevServerTarget | ProjectId,
  workspaceId?: WorktreeWorkspaceId | null,
) => void;

export interface ProjectRunStoreState {
  /** Canonical projection. A project may own multiple concurrent workspace runs. */
  runsByTargetKey: ProjectRunsByTargetKey;
  /**
   * Transitional aggregate for project-only UI. Repository-root runs win, otherwise
   * the first workspace run represents the project's running indicator.
   */
  runsByProjectId: Record<ProjectId, ProjectRunState>;
  replaceAll: (servers: ReadonlyArray<ProjectDevServer>) => void;
  upsertRun: (server: ProjectDevServer) => void;
  removeRun: RemoveProjectRun;
}

export function indexProjectRunsByTargetKey(
  servers: ReadonlyArray<ProjectDevServer>,
): ProjectRunsByTargetKey {
  const next: ProjectRunsByTargetKey = {};
  for (const server of servers) {
    next[projectDevServerTargetKey(server)] = server;
  }
  return next;
}

export function selectProjectRunForTarget(
  runsByTargetKey: ProjectRunsByTargetKey,
  target: ProjectDevServerTarget,
): ProjectRunState | null {
  return runsByTargetKey[projectDevServerTargetKey(target)] ?? null;
}

export function selectWorkspaceProjectRun(
  runsByTargetKey: ProjectRunsByTargetKey,
  projectId: ProjectId,
  workspaceId: WorktreeWorkspaceId,
): ProjectRunState | null {
  return selectProjectRunForTarget(runsByTargetKey, { projectId, workspaceId });
}

export function selectProjectRuns(
  runsByTargetKey: ProjectRunsByTargetKey,
  projectId: ProjectId,
): ProjectRunState[] {
  return Object.values(runsByTargetKey).filter((run) => run.projectId === projectId);
}

function aggregateProjectRuns(
  runsByTargetKey: ProjectRunsByTargetKey,
): Record<ProjectId, ProjectRunState> {
  const next: Record<ProjectId, ProjectRunState> = {};
  for (const run of Object.values(runsByTargetKey)) {
    const existing = next[run.projectId];
    if (!existing || run.workspaceId === null) {
      next[run.projectId] = run;
    }
  }
  return next;
}

function projectRunProjection(runsByTargetKey: ProjectRunsByTargetKey) {
  return {
    runsByTargetKey,
    runsByProjectId: aggregateProjectRuns(runsByTargetKey),
  };
}

function normalizeRunTarget(
  targetOrProjectId: ProjectDevServerTarget | ProjectId,
  workspaceId: WorktreeWorkspaceId | null = null,
): ProjectDevServerTarget {
  return typeof targetOrProjectId === "string"
    ? { projectId: targetOrProjectId, workspaceId }
    : targetOrProjectId;
}

export const useProjectRunStore = create<ProjectRunStoreState>((set) => ({
  runsByTargetKey: {},
  runsByProjectId: {},
  replaceAll: (servers) => set(() => projectRunProjection(indexProjectRunsByTargetKey(servers))),
  upsertRun: (server) =>
    set((state) =>
      projectRunProjection({
        ...state.runsByTargetKey,
        [projectDevServerTargetKey(server)]: server,
      }),
    ),
  removeRun: (targetOrProjectId, workspaceId) =>
    set((state) => {
      const target = normalizeRunTarget(targetOrProjectId, workspaceId ?? null);
      const key = projectDevServerTargetKey(target);
      if (!state.runsByTargetKey[key]) {
        return state;
      }
      const nextRunsByTargetKey = { ...state.runsByTargetKey };
      delete nextRunsByTargetKey[key];
      return projectRunProjection(nextRunsByTargetKey);
    }),
}));
