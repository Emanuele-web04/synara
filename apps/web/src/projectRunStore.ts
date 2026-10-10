import type { ProjectDevServer, ProjectId } from "@synara/contracts";

// the client no longer owns thread/terminal identifiers — dev servers are first-class server processes
export type ProjectRunState = ProjectDevServer;

interface ProjectRunStoreState {
  runsByProjectId: Record<ProjectId, ProjectRunState>;
  replaceAll: (servers: ReadonlyArray<ProjectDevServer>) => void;
  upsertRun: (server: ProjectDevServer) => void;
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
