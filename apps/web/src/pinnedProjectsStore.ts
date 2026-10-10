// FILE: pinnedProjectsStore.ts
// Purpose: Persists sidebar project pin ids with the shared pin ordering cap.
// Layer: UI state store
// Exports: usePinnedProjectsStore

import { MAX_PINNED_PROJECTS, type ProjectId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { normalizePinnedIds, pinId, prunePinnedIds, unpinId } from "./pinning.logic";

interface PinnedProjectsStoreState {
  pinnedProjectIds: ProjectId[];
  pinProject: (projectId: ProjectId) => boolean;
  unpinProject: (projectId: ProjectId) => void;
  prunePinnedProjects: (projectIds: readonly ProjectId[]) => void;
}

const PINNED_PROJECTS_STORAGE_KEY = "synara:pinned-projects:v1";
const PINNED_PROJECTS_OPTIONS = { maxCount: MAX_PINNED_PROJECTS } as const;

export const usePinnedProjectsStore = create<PinnedProjectsStoreState>()(
  persist(
    (set, get) => ({
      pinnedProjectIds: [],
      pinProject: (projectId) => {
        if (projectId.length === 0) return false;
        const result = pinId(get().pinnedProjectIds, projectId, PINNED_PROJECTS_OPTIONS);
        if (result.rejected) {
          return false;
        }
        if (result.changed) {
          set({ pinnedProjectIds: result.pinnedIds });
        }
        return true;
      },
      unpinProject: (projectId) => {
        if (projectId.length === 0) return;
        set((state) => {
          const result = unpinId(state.pinnedProjectIds, projectId);
          if (!result.changed) {
            return state;
          }
          return {
            pinnedProjectIds: result.pinnedIds,
          };
        });
      },
      prunePinnedProjects: (projectIds) => {
        set((state) => {
          const nextPinnedProjectIds = prunePinnedIds(state.pinnedProjectIds, projectIds).slice(
            0,
            MAX_PINNED_PROJECTS,
          );
          return nextPinnedProjectIds.length === state.pinnedProjectIds.length &&
            nextPinnedProjectIds.every((id, index) => id === state.pinnedProjectIds[index])
            ? state
            : { pinnedProjectIds: nextPinnedProjectIds };
        });
      },
    }),
    {
      name: PINNED_PROJECTS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        pinnedProjectIds: normalizePinnedIds(state.pinnedProjectIds, PINNED_PROJECTS_OPTIONS),
      }),
      merge: (persistedState, currentState) => {
        const candidate =
          (
            persistedState as
              | Partial<Pick<PinnedProjectsStoreState, "pinnedProjectIds">>
              | undefined
          )?.pinnedProjectIds ?? [];
        return {
          ...currentState,
          pinnedProjectIds: normalizePinnedIds(candidate, PINNED_PROJECTS_OPTIONS),
        };
      },
    },
  ),
);
