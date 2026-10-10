import type { ProjectId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { normalizePinnedIds, pinId, prunePinnedIds, unpinId } from "./pinning.logic";

interface PinnedProjectAgentsStoreState {
  pinnedProjectAgentIds: ProjectId[];
  pinProjectAgent: (projectId: ProjectId) => boolean;
  unpinProjectAgent: (projectId: ProjectId) => void;
  toggleProjectAgentPinned: (projectId: ProjectId) => void;
  prunePinnedProjectAgents: (projectIds: readonly ProjectId[]) => void;
}

const PINNED_PROJECT_AGENTS_STORAGE_KEY = "synara:pinned-project-agents:v1";

export const usePinnedProjectAgentsStore = create<PinnedProjectAgentsStoreState>()(
  persist(
    (set, get) => ({
      pinnedProjectAgentIds: [],
      pinProjectAgent: (projectId) => {
        if (projectId.length === 0) return false;
        const result = pinId(get().pinnedProjectAgentIds, projectId);
        if (result.rejected) return false;
        if (result.changed) {
          set({ pinnedProjectAgentIds: result.pinnedIds });
        }
        return true;
      },
      unpinProjectAgent: (projectId) => {
        if (projectId.length === 0) return;
        set((state) => {
          const result = unpinId(state.pinnedProjectAgentIds, projectId);
          if (!result.changed) return state;
          return { pinnedProjectAgentIds: result.pinnedIds };
        });
      },
      toggleProjectAgentPinned: (projectId) => {
        if (get().pinnedProjectAgentIds.includes(projectId)) {
          get().unpinProjectAgent(projectId);
          return;
        }
        get().pinProjectAgent(projectId);
      },
      prunePinnedProjectAgents: (projectIds) => {
        set((state) => {
          const nextPinnedProjectAgentIds = prunePinnedIds(state.pinnedProjectAgentIds, projectIds);
          return nextPinnedProjectAgentIds.length === state.pinnedProjectAgentIds.length &&
            nextPinnedProjectAgentIds.every(
              (id, index) => id === state.pinnedProjectAgentIds[index],
            )
            ? state
            : { pinnedProjectAgentIds: nextPinnedProjectAgentIds };
        });
      },
    }),
    {
      name: PINNED_PROJECT_AGENTS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        pinnedProjectAgentIds: normalizePinnedIds(state.pinnedProjectAgentIds),
      }),
      merge: (persistedState, currentState) => {
        const candidate =
          (
            persistedState as
              | Partial<Pick<PinnedProjectAgentsStoreState, "pinnedProjectAgentIds">>
              | undefined
          )?.pinnedProjectAgentIds ?? [];
        return {
          ...currentState,
          pinnedProjectAgentIds: normalizePinnedIds(candidate),
        };
      },
    },
  ),
);
