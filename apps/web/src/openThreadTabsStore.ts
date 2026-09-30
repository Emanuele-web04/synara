// FILE: openThreadTabsStore.ts
// Purpose: Persist which threads are open as tabs, in tab order. The single source of
//          truth for "open threads": the chat header strip and the editor rail both read
//          it; the active tab is never stored (it is always the thread on screen).
// Layer: UI state store
// Exports: useOpenThreadTabsStore

import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createMemoryStorage } from "./lib/storage";
import {
  addOpenThreadTab,
  normalizeOpenThreadTabIds,
  pruneOpenThreadTabs,
  removeOpenThreadTab,
} from "./openThreadTabs.logic";

interface OpenThreadTabsStoreState {
  threadIds: readonly ThreadId[];
  openThreadTab: (threadId: ThreadId) => void;
  closeThreadTab: (threadId: ThreadId) => void;
  pruneThreadTabs: (isKept: (threadId: ThreadId) => boolean) => void;
}

const OPEN_THREAD_TABS_STORAGE_KEY = "synara:open-thread-tabs:v1";

export const useOpenThreadTabsStore = create<OpenThreadTabsStoreState>()(
  persist(
    (set) => ({
      threadIds: [],
      openThreadTab: (threadId) => {
        set((state) => {
          const threadIds = addOpenThreadTab(state.threadIds, threadId);
          return threadIds === state.threadIds ? state : { threadIds };
        });
      },
      closeThreadTab: (threadId) => {
        set((state) => {
          const threadIds = removeOpenThreadTab(state.threadIds, threadId);
          return threadIds === state.threadIds ? state : { threadIds };
        });
      },
      pruneThreadTabs: (isKept) => {
        set((state) => {
          const threadIds = pruneOpenThreadTabs(state.threadIds, isKept);
          return threadIds === state.threadIds ? state : { threadIds };
        });
      },
    }),
    {
      name: OPEN_THREAD_TABS_STORAGE_KEY,
      storage: createJSONStorage(() =>
        typeof localStorage === "undefined" ? createMemoryStorage() : localStorage,
      ),
      partialize: (state) => ({ threadIds: state.threadIds }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        threadIds: normalizeOpenThreadTabIds(
          (persistedState as { threadIds?: unknown } | undefined)?.threadIds,
        ),
      }),
    },
  ),
);
