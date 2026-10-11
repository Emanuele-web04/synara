// FILE: rightDockStore.ts
// Purpose: Persist the tabbed right-dock state (open panes + active tab) per host: a chat
//          thread, or the GitHub inbox (GITHUB_INBOX_DOCK_HOST_ID).
// Layer: UI state store
// Exports: dock store hook, per-thread selector, and stable default snapshot.

import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { randomUUID } from "./lib/utils";
import {
  type OpenPaneInput,
  type RightDockHostId,
  type RightDockPane,
  type RightDockThreadState,
  closePaneInState,
  createDefaultRightDockState,
  movePaneInState,
  openPaneInState,
  sanitizeRightDockStateByThreadId,
  setActivePaneInState,
  setDockOpenInState,
  setSidechatPaneThreadInState,
  toggleSingletonPaneInState,
  updatePaneInState,
} from "./rightDockStore.logic";

const RIGHT_DOCK_STORAGE_KEY = "synara:right-dock-state:v1";

interface RightDockStore {
  dockStateByThreadId: Record<string, RightDockThreadState | undefined>;
  openPane: (
    threadId: RightDockHostId,
    input: Omit<OpenPaneInput, "paneId"> & { paneId?: string },
  ) => void;
  toggleSingletonPane: (
    threadId: RightDockHostId,
    input: Omit<OpenPaneInput, "paneId"> & { paneId?: string },
  ) => void;
  closePane: (threadId: RightDockHostId, paneId: string) => void;
  movePane: (threadId: RightDockHostId, paneId: string, overPaneId: string) => void;
  setActivePane: (threadId: RightDockHostId, paneId: string) => void;
  setDockOpen: (threadId: RightDockHostId, open: boolean) => void;
  updatePane: (
    threadId: RightDockHostId,
    paneId: string,
    patch: Partial<
      Pick<
        RightDockPane,
        | "diffTurnId"
        | "diffFilePath"
        | "filePath"
        | "threadId"
        | "pullRequestProjectId"
        | "pullRequestRepository"
        | "pullRequestNumber"
        | "pullRequestInitialTab"
      >
    >,
  ) => void;
  setSidechatPaneThread: (hostId: RightDockHostId, threadId: ThreadId | null) => void;
  clearThreadDockState: (threadId: ThreadId) => void;
}

// Frozen shared snapshot: it is handed back from `selectRightDockState` for any
// thread without persisted dock state, so it must stay a stable, immutable
// reference (transitions always build new objects rather than mutating it).
const DEFAULT_RIGHT_DOCK_STATE = createDefaultRightDockState();
Object.freeze(DEFAULT_RIGHT_DOCK_STATE);
Object.freeze(DEFAULT_RIGHT_DOCK_STATE.panes);

function commit(
  set: (fn: (store: RightDockStore) => Partial<RightDockStore>) => void,
  threadId: RightDockHostId,
  transform: (state: RightDockThreadState) => RightDockThreadState,
): void {
  set((store) => {
    const previous = store.dockStateByThreadId[threadId] ?? DEFAULT_RIGHT_DOCK_STATE;
    const next = transform(previous);
    if (next === previous) {
      return {};
    }
    return {
      dockStateByThreadId: {
        ...store.dockStateByThreadId,
        [threadId]: next,
      },
    };
  });
}

export const useRightDockStore = create<RightDockStore>()(
  persist(
    (set) => ({
      dockStateByThreadId: {},
      openPane: (threadId, input) =>
        commit(set, threadId, (state) =>
          openPaneInState(state, { ...input, paneId: input.paneId ?? randomUUID() }),
        ),
      toggleSingletonPane: (threadId, input) =>
        commit(set, threadId, (state) =>
          toggleSingletonPaneInState(state, { ...input, paneId: input.paneId ?? randomUUID() }),
        ),
      closePane: (threadId, paneId) =>
        commit(set, threadId, (state) => closePaneInState(state, paneId)),
      movePane: (threadId, paneId, overPaneId) =>
        commit(set, threadId, (state) => movePaneInState(state, paneId, overPaneId)),
      setActivePane: (threadId, paneId) =>
        commit(set, threadId, (state) => setActivePaneInState(state, paneId)),
      setDockOpen: (threadId, open) =>
        commit(set, threadId, (state) => setDockOpenInState(state, open)),
      updatePane: (threadId, paneId, patch) =>
        commit(set, threadId, (state) => updatePaneInState(state, paneId, patch)),
      setSidechatPaneThread: (hostId, threadId) =>
        commit(set, hostId, (state) =>
          setSidechatPaneThreadInState(state, { paneId: randomUUID(), threadId }),
        ),
      clearThreadDockState: (threadId) =>
        set((store) => {
          if (!Object.hasOwn(store.dockStateByThreadId, threadId)) {
            return {};
          }
          const next = { ...store.dockStateByThreadId };
          delete next[threadId];
          return { dockStateByThreadId: next };
        }),
    }),
    {
      name: RIGHT_DOCK_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // Validate persisted panes on rehydrate so a stale/unknown pane kind from
      // an older app version can never crash the dock during render.
      merge: (persisted, current) => ({
        ...current,
        dockStateByThreadId: sanitizeRightDockStateByThreadId(
          (persisted as { dockStateByThreadId?: unknown } | undefined)?.dockStateByThreadId,
        ),
      }),
    },
  ),
);

export function selectRightDockState(threadId: RightDockHostId | null) {
  // Keep the fallback snapshot stable so React does not observe phantom store
  // changes while mounting a thread that has no persisted dock state yet.
  return (store: RightDockStore) =>
    (threadId ? store.dockStateByThreadId[threadId] : undefined) ?? DEFAULT_RIGHT_DOCK_STATE;
}
