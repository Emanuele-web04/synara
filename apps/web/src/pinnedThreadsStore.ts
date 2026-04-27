// FILE: pinnedThreadsStore.ts
// Purpose: Persists the globally pinned chat thread ids used by the sidebar.
// Layer: UI state store
// Exports: usePinnedThreadsStore

import { type ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface PinnedThreadsStoreState {
  pinnedThreadIds: ThreadId[];
  pinThread: (threadId: ThreadId) => void;
  unpinThread: (threadId: ThreadId) => void;
  togglePinnedThread: (threadId: ThreadId) => void;
  prunePinnedThreads: (threadIds: readonly ThreadId[]) => void;
}

const PINNED_THREADS_STORAGE_KEY = "dpcode:pinned-threads:v1";

function normalizePinnedThreadIds(threadIds: readonly ThreadId[]): ThreadId[] {
  const seen = new Set<ThreadId>();
  const normalized: ThreadId[] = [];

  for (const threadId of threadIds) {
    if (threadId.length === 0 || seen.has(threadId)) {
      continue;
    }
    seen.add(threadId);
    normalized.push(threadId);
  }

  return normalized;
}

export const usePinnedThreadsStore = create<PinnedThreadsStoreState>()(
  persist(
    (set) => ({
      pinnedThreadIds: [],
      pinThread: (threadId) => {
        if (threadId.length === 0) return;
        set((state) => {
          if (state.pinnedThreadIds.includes(threadId)) {
            return state;
          }
          return {
            pinnedThreadIds: [threadId, ...state.pinnedThreadIds],
          };
        });
      },
      unpinThread: (threadId) => {
        if (threadId.length === 0) return;
        set((state) => {
          if (!state.pinnedThreadIds.includes(threadId)) {
            return state;
          }
          return {
            pinnedThreadIds: state.pinnedThreadIds.filter((candidate) => candidate !== threadId),
          };
        });
      },
      togglePinnedThread: (threadId) => {
        if (threadId.length === 0) return;
        set((state) => {
          if (state.pinnedThreadIds.includes(threadId)) {
            return {
              pinnedThreadIds: state.pinnedThreadIds.filter((candidate) => candidate !== threadId),
            };
          }
          return {
            pinnedThreadIds: [threadId, ...state.pinnedThreadIds],
          };
        });
      },
      prunePinnedThreads: (threadIds) => {
        const allowedThreadIds = new Set(threadIds);
        set((state) => {
          const nextPinnedThreadIds = state.pinnedThreadIds.filter((threadId) =>
            allowedThreadIds.has(threadId),
          );
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
        pinnedThreadIds: normalizePinnedThreadIds(state.pinnedThreadIds),
      }),
      merge: (persistedState, currentState) => {
        const candidate =
          (persistedState as Partial<Pick<PinnedThreadsStoreState, "pinnedThreadIds">> | undefined)
            ?.pinnedThreadIds ?? [];
        return {
          ...currentState,
          pinnedThreadIds: normalizePinnedThreadIds(candidate),
        };
      },
    },
  ),
);
