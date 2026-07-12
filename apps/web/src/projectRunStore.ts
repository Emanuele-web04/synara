// FILE: projectRunStore.ts
// Purpose: Client-side projection of the server-owned dev-server registry, keyed by project id.
// Layer: Web UI state
// Exports: useProjectRunStore plus helpers for syncing dev-server lifecycle events.

import type { ProjectDevServer, ProjectId } from "@synara/contracts";

export type ProjectRunStatus = ProjectDevServer["status"];

/**
 * A tracked dev server as projected from the server. This mirrors the
 * `ProjectDevServer` contract exactly — the client no longer owns thread or
 * terminal identifiers, because dev servers are first-class server processes.
 */
export type ProjectRunState = ProjectDevServer;

interface ProjectRunStoreState {
  runsByProjectId: Record<ProjectId, ProjectRunState>;
  /** Replace the entire registry from an authoritative server snapshot. */
  replaceAll: (servers: ReadonlyArray<ProjectDevServer>) => void;
  /** Insert or update a single tracked dev server. */
  upsertRun: (server: ProjectDevServer) => void;
  /** Drop a tracked dev server by project id. */
  removeRun: (projectId: ProjectId) => void;
}

import { create } from "zustand";

function indexByProjectId(
  servers: ReadonlyArray<ProjectDevServer>,
): Record<ProjectId, ProjectRunState> {
  const next: Record<ProjectId, ProjectRunState> = {};
  for (const server of servers) {
    next[server.projectId] = server;
  }
  return next;
}

export const useProjectRunStore = create<ProjectRunStoreState>((set) => ({
  runsByProjectId: {},
  replaceAll: (servers) =>
    set(() => ({
      runsByProjectId: indexByProjectId(servers),
    })),
  upsertRun: (server) =>
    set((state) => ({
      runsByProjectId: {
        ...state.runsByProjectId,
        [server.projectId]: server,
      },
    })),
  removeRun: (projectId) =>
    set((state) => {
      if (!state.runsByProjectId[projectId]) {
        return state;
      }
      const nextRunsByProjectId = { ...state.runsByProjectId };
      delete nextRunsByProjectId[projectId];
      return { runsByProjectId: nextRunsByProjectId };
    }),
}));
