// FILE: openThreadTabsStore.ts
// Purpose: Persist which threads are open as tabs, in tab order. The single source of
//          truth for "open threads": the chat header strip and the editor rail both read
//          it; the active tab is never stored (it is always the thread on screen).
// Layer: UI state store
// Exports: useOpenThreadTabsStore

import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { createMemoryStorage } from "./lib/storage";
import {
  addOpenThreadTab,
  moveOpenThreadTab,
  normalizeOpenThreadTabIds,
  pruneOpenThreadTabs,
  removeOpenThreadTab,
} from "./openThreadTabs.logic";

interface OpenThreadTabsStoreState {
  threadIds: readonly ThreadId[];
  openThreadTab: (threadId: ThreadId) => void;
  closeThreadTab: (threadId: ThreadId) => void;
  moveThreadTab: (threadId: ThreadId, overThreadId: ThreadId) => void;
  pruneThreadTabs: (isKept: (threadId: ThreadId) => boolean) => void;
}

const OPEN_THREAD_TABS_STORAGE_KEY = "synara:open-thread-tabs:v1";
// The editor rail's own per-project chat tabs, which this store replaced. Not migrated
// (the rail's tabs were a subset of the threads on screen); dropped on the first write.
const LEGACY_EDITOR_RAIL_CHAT_TABS_STORAGE_KEY = "synara.editor.railChatTabsByProjectId";

function createOpenThreadTabsStorage(): StateStorage {
  return {
    getItem: (name) => localStorage.getItem(name),
    setItem: (name, value) => {
      localStorage.setItem(name, value);
      localStorage.removeItem(LEGACY_EDITOR_RAIL_CHAT_TABS_STORAGE_KEY);
    },
    removeItem: (name) => {
      localStorage.removeItem(name);
      localStorage.removeItem(LEGACY_EDITOR_RAIL_CHAT_TABS_STORAGE_KEY);
    },
  };
}

export const useOpenThreadTabsStore = create<OpenThreadTabsStoreState>()(
  persist(
    (set, get) => ({
      threadIds: [],
      // Zustand persist writes even when set returns the same state. Skip set
      // entirely for unchanged tabs, especially on the layout-effect navigation path.
      openThreadTab: (threadId) => {
        const current = get().threadIds;
        const threadIds = addOpenThreadTab(current, threadId);
        if (threadIds !== current) set({ threadIds });
      },
      closeThreadTab: (threadId) => {
        const current = get().threadIds;
        const threadIds = removeOpenThreadTab(current, threadId);
        if (threadIds !== current) set({ threadIds });
      },
      moveThreadTab: (threadId, overThreadId) => {
        const current = get().threadIds;
        const threadIds = moveOpenThreadTab(current, threadId, overThreadId);
        if (threadIds !== current) set({ threadIds });
      },
      pruneThreadTabs: (isKept) => {
        const current = get().threadIds;
        const threadIds = pruneOpenThreadTabs(current, isKept);
        if (threadIds !== current) set({ threadIds });
      },
    }),
    {
      name: OPEN_THREAD_TABS_STORAGE_KEY,
      storage: createJSONStorage(() =>
        typeof localStorage === "undefined" ? createMemoryStorage() : createOpenThreadTabsStorage(),
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
