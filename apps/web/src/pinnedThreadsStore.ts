// FILE: pinnedThreadsStore.ts
// Purpose: Persists the globally pinned chat thread ids used by the sidebar.
// Layer: UI state store
// Exports: usePinnedThreadsStore

import { type ThreadId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { normalizePinnedIds, pinId, prunePinnedIds, unpinId } from "./pinning.logic";

interface PinnedThreadsStoreState {
  pinnedThreadIds: ThreadId[];
  pinThread: (threadId: ThreadId) => void;
  unpinThread: (threadId: ThreadId) => void;
  togglePinnedThread: (threadId: ThreadId) => void;
  prunePinnedThreads: (threadIds: readonly ThreadId[]) => void;
}

const PINNED_THREADS_STORAGE_KEY = "synara:pinned-threads:v1";

export const usePinnedThreadsStore = create<PinnedThreadsStoreState>()(
  persist(
    (set) => ({
      pinnedThreadIds: [],
      pinThread: (threadId) => {
        if (threadId.length === 0) return;
        set((state) => {
          const result = pinId(state.pinnedThreadIds, threadId);
          if (!result.changed) {
            return state;
          }
          return {
            pinnedThreadIds: result.pinnedIds,
          };
        });
      },
      unpinThread: (threadId) => {
        if (threadId.length === 0) return;
        set((state) => {
          const result = unpinId(state.pinnedThreadIds, threadId);
          if (!result.changed) {
            return state;
          }
          return {
            pinnedThreadIds: result.pinnedIds,
          };
        });
      },
      togglePinnedThread: (threadId) => {
        if (threadId.length === 0) return;
        set((state) => {
          if (state.pinnedThreadIds.includes(threadId)) {
            return { pinnedThreadIds: unpinId(state.pinnedThreadIds, threadId).pinnedIds };
          }
          return { pinnedThreadIds: pinId(state.pinnedThreadIds, threadId).pinnedIds };
        });
      },
      prunePinnedThreads: (threadIds) => {
        set((state) => {
          const nextPinnedThreadIds = prunePinnedIds(state.pinnedThreadIds, threadIds);
          return nextPinnedThreadIds.length === state.pinnedThreadIds.length
            ? state
            : { pinnedThreadIds: nextPinnedThreadIds };
        });
      },
    }),
    {
      name: PINNED_THREADS_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        pinnedThreadIds: normalizePinnedIds(state.pinnedThreadIds),
      }),
      merge: (persistedState, currentState) => {
        const candidate =
          (persistedState as Partial<Pick<PinnedThreadsStoreState, "pinnedThreadIds">> | undefined)
            ?.pinnedThreadIds ?? [];
        return {
          ...currentState,
          pinnedThreadIds: normalizePinnedIds(candidate),
        };
      },
    },
  ),
);
