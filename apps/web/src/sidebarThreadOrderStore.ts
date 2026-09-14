// FILE: sidebarThreadOrderStore.ts
// Purpose: Persists the user's manual conversation order across sidebar surfaces.
// Layer: UI state store
// Exports: useSidebarThreadOrderStore

import { type ThreadId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  moveSidebarThreadWithinScope,
  normalizeSidebarThreadOrder,
  pruneSidebarThreadOrder,
} from "./sidebarThreadOrdering";

interface SidebarThreadOrderStoreState {
  orderedThreadIds: ThreadId[];
  moveThread: (input: {
    scopeThreadIds: readonly ThreadId[];
    activeThreadId: ThreadId;
    overThreadId: ThreadId;
  }) => boolean;
  pruneThreads: (threadIds: readonly ThreadId[]) => void;
}

const SIDEBAR_THREAD_ORDER_STORAGE_KEY = "synara:sidebar-thread-order:v1";

export const useSidebarThreadOrderStore = create<SidebarThreadOrderStoreState>()(
  persist(
    (set) => ({
      orderedThreadIds: [],
      moveThread: (input) => {
        let changed = false;
        set((state) => {
          const result = moveSidebarThreadWithinScope({
            orderedIds: state.orderedThreadIds,
            scopeIds: input.scopeThreadIds,
            activeId: input.activeThreadId,
            overId: input.overThreadId,
          });
          changed = result.changed;
          return result.changed ? { orderedThreadIds: result.orderedIds } : state;
        });
        return changed;
      },
      pruneThreads: (threadIds) => {
        set((state) => {
          const nextOrderedThreadIds = pruneSidebarThreadOrder(state.orderedThreadIds, threadIds);
          return nextOrderedThreadIds.length === state.orderedThreadIds.length
            ? state
            : { orderedThreadIds: nextOrderedThreadIds };
        });
      },
    }),
    {
      name: SIDEBAR_THREAD_ORDER_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        orderedThreadIds: normalizeSidebarThreadOrder(state.orderedThreadIds),
      }),
      merge: (persistedState, currentState) => {
        const candidate =
          (
            persistedState as
              | Partial<Pick<SidebarThreadOrderStoreState, "orderedThreadIds">>
              | undefined
          )?.orderedThreadIds ?? [];
        return {
          ...currentState,
          orderedThreadIds: normalizeSidebarThreadOrder(candidate),
        };
      },
    },
  ),
);
