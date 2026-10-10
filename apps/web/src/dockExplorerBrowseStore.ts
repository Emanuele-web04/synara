// FILE: dockExplorerBrowseStore.ts
// Purpose: Per-thread browse state for the right-dock Explorer pane — the
//          selected file, expanded directories, and search query. The pane's
//          subtree unmounts when the user switches threads, so component-local
//          state was destroyed on every switch even though the dock's pane list
//          (persisted per thread in rightDockStore) restores the Explorer tab.
//          Keying the browse state by thread here lets a remounted pane reopen
//          exactly where the user left it.
// Layer: Web UI state store

import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";

export interface DockExplorerBrowseState {
  selectedFilePath: string | null;
  expandedDirectories: ReadonlySet<string>;
  searchQuery: string;
}

// Shared immutable snapshot returned for threads with no recorded state, so a
// selector never hands React a fresh object per render.
export const EMPTY_DOCK_EXPLORER_BROWSE_STATE: DockExplorerBrowseState = {
  selectedFilePath: null,
  expandedDirectories: new Set<string>(),
  searchQuery: "",
};
Object.freeze(EMPTY_DOCK_EXPLORER_BROWSE_STATE);
Object.freeze(EMPTY_DOCK_EXPLORER_BROWSE_STATE.expandedDirectories);

interface DockExplorerBrowseStore {
  browseStateByThreadId: Record<string, DockExplorerBrowseState>;
  selectFile: (threadId: ThreadId, path: string | null) => void;
  setSearchQuery: (threadId: ThreadId, query: string) => void;
  toggleDirectory: (threadId: ThreadId, path: string) => void;
  expandDirectories: (threadId: ThreadId, paths: readonly string[]) => void;
}

export const useDockExplorerBrowseStore = create<DockExplorerBrowseStore>()((set) => {
  const update = (
    threadId: ThreadId,
    patch: (state: DockExplorerBrowseState) => Partial<DockExplorerBrowseState>,
  ) =>
    set((store) => {
      const previous = store.browseStateByThreadId[threadId] ?? EMPTY_DOCK_EXPLORER_BROWSE_STATE;
      const next = patch(previous);
      const changed = (Object.keys(next) as (keyof DockExplorerBrowseState)[]).some(
        (key) => next[key] !== previous[key],
      );
      if (!changed) {
        return {};
      }
      return {
        browseStateByThreadId: {
          ...store.browseStateByThreadId,
          [threadId]: { ...previous, ...next },
        },
      };
    });

  return {
    browseStateByThreadId: {},
    selectFile: (threadId, path) => update(threadId, () => ({ selectedFilePath: path })),
    setSearchQuery: (threadId, query) => update(threadId, () => ({ searchQuery: query })),
    toggleDirectory: (threadId, path) =>
      update(threadId, (current) => {
        const expandedDirectories = new Set(current.expandedDirectories);
        if (expandedDirectories.has(path)) {
          expandedDirectories.delete(path);
        } else {
          expandedDirectories.add(path);
        }
        return { expandedDirectories };
      }),
    expandDirectories: (threadId, paths) => {
      if (paths.length === 0) {
        return;
      }
      update(threadId, (current) => ({
        expandedDirectories: new Set([...current.expandedDirectories, ...paths]),
      }));
    },
  };
});

// Selector for a single thread's browse state; falls back to the frozen shared
// snapshot so untouched threads do not subscribe to store writes at all.
export function selectDockExplorerBrowseState(
  threadId: ThreadId,
): (store: DockExplorerBrowseStore) => DockExplorerBrowseState {
  return (store) => store.browseStateByThreadId[threadId] ?? EMPTY_DOCK_EXPLORER_BROWSE_STATE;
}
