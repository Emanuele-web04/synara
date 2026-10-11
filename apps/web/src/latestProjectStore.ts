import type { ProjectId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const LATEST_PROJECT_STORAGE_KEY = "synara:latest-project:v1";

interface LatestProjectStore {
  latestProjectId: ProjectId | null;
  setLatestProjectId: (projectId: ProjectId) => void;
  clearLatestProjectId: (projectId?: ProjectId) => void;
}

export const useLatestProjectStore = create<LatestProjectStore>()(
  persist(
    (set) => ({
      latestProjectId: null,
      setLatestProjectId: (projectId) => set({ latestProjectId: projectId }),
      clearLatestProjectId: (projectId) =>
        set((state) => {
          if (projectId && state.latestProjectId !== projectId) {
            return state;
          }
          if (state.latestProjectId === null) {
            return state;
          }
          return { latestProjectId: null };
        }),
    }),
    {
      name: LATEST_PROJECT_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // Guard against a corrupt persisted value (non-string) reaching consumers
      // that treat it as a project id.
      merge: (persisted, current) => {
        const persistedId = (persisted as { latestProjectId?: unknown } | undefined)
          ?.latestProjectId;
        return {
          ...current,
          latestProjectId: typeof persistedId === "string" ? (persistedId as ProjectId) : null,
        };
      },
    },
  ),
);
