import { executionStorage } from "./lib/hosts/executionStorage";
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
    (set, get) => ({
      latestProjectId: null,
      setLatestProjectId: (projectId) => {
        if (get().latestProjectId === projectId) return;
        set({ latestProjectId: projectId });
      },
      clearLatestProjectId: (projectId) => {
        const current = get().latestProjectId;
        if (current === null || (projectId && current !== projectId)) {
          return;
        }
        set({ latestProjectId: null });
      },
    }),
    {
      name: LATEST_PROJECT_STORAGE_KEY,
      storage: createJSONStorage(() => executionStorage),
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
