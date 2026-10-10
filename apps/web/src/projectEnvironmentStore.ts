import type { ProjectId, ThreadEnvironmentMode } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createMemoryStorage } from "./lib/storage";
import { isPlainObject, sanitizeStringKeyedRecord } from "./persistedRecord";

interface ProjectEnvironmentStoreState {
  envModeByProjectId: Partial<Record<ProjectId, ThreadEnvironmentMode>>;
  setProjectEnvMode: (projectId: ProjectId, envMode: ThreadEnvironmentMode) => void;
}

const storage = typeof localStorage !== "undefined" ? localStorage : createMemoryStorage();

export const useProjectEnvironmentStore = create<ProjectEnvironmentStoreState>()(
  persist(
    (set) => ({
      envModeByProjectId: {},
      setProjectEnvMode: (projectId, envMode) =>
        set((state) =>
          state.envModeByProjectId[projectId] === envMode
            ? state
            : { envModeByProjectId: { ...state.envModeByProjectId, [projectId]: envMode } },
        ),
    }),
    {
      name: "synara:project-environment:v1",
      storage: createJSONStorage(() => storage),
      partialize: (state) => ({ envModeByProjectId: state.envModeByProjectId }),
      merge: (persisted, current) => ({
        ...current,
        envModeByProjectId: sanitizeStringKeyedRecord(
          isPlainObject(persisted) ? persisted.envModeByProjectId : undefined,
          (value) => (value === "local" || value === "worktree" ? value : null),
        ),
      }),
    },
  ),
);
