// FILE: bottomTerminalStore.ts
// Purpose: Zustand store owning the per-thread compact bottom terminal drawer and its tiled tabs.
// Layer: Web UI state store

import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { executionStorage } from "./lib/hosts/executionStorage";
import { randomUUID } from "./lib/utils";
import { randomTerminalId } from "./components/terminal/terminalIds";
import {
  type BottomTerminalThreadState,
  type TerminalTileDirection,
  type TerminalTileNavigationDirection,
  clampBottomTerminalHeight,
  closeTerminalTileInState,
  collectTerminalTileLeaves,
  createBottomTerminalTab,
  createDefaultBottomTerminalState,
  cycleBottomTerminalTabInState,
  findDirectionalTerminalTile,
  findTerminalTileLeafById,
  findTerminalTileLeafByTerminalId,
  resizeTerminalTileInTree,
  resolveActiveBottomTerminalTab,
  sanitizeBottomTerminalStateByThreadId,
  setTerminalSplitRatioInTree,
  splitTerminalTileInTree,
} from "./bottomTerminalStore.logic";

const BOTTOM_TERMINAL_STORAGE_KEY = "synara:bottom-terminal:v1";
const DEFAULT_BOTTOM_TERMINAL_STATE: BottomTerminalThreadState = Object.freeze(
  createDefaultBottomTerminalState(),
);

interface BottomTerminalStoreState {
  byThreadId: Record<string, BottomTerminalThreadState>;
  focusNonce: number;
  openDrawer: (threadId: ThreadId) => { tabId: string; paneId: string; terminalId: string };
  toggleDrawer: (threadId: ThreadId) => boolean;
  setDrawerOpen: (threadId: ThreadId, open: boolean) => void;
  setDrawerHeight: (threadId: ThreadId, heightPx: number) => void;
  toggleMaximized: (threadId: ThreadId) => void;
  addTab: (
    threadId: ThreadId,
    options?: { terminalId?: string },
  ) => { tabId: string; paneId: string; terminalId: string };
  selectTab: (threadId: ThreadId, tabId: string) => void;
  cycleTab: (threadId: ThreadId, delta: 1 | -1) => void;
  splitFocusedPane: (
    threadId: ThreadId,
    direction: TerminalTileDirection,
    options?: { terminalId?: string },
  ) => { paneId: string; terminalId: string } | null;
  focusPane: (threadId: ThreadId, tabId: string, paneId: string) => void;
  focusDirectionalPane: (
    threadId: ThreadId,
    direction: TerminalTileNavigationDirection,
  ) => string | null;
  resizeFocusedPane: (
    threadId: ThreadId,
    direction: TerminalTileNavigationDirection,
    step?: number,
  ) => void;
  setSplitRatio: (threadId: ThreadId, tabId: string, splitNodeId: string, ratio: number) => void;
  toggleZoomFocusedPane: (threadId: ThreadId) => void;
  closePane: (threadId: ThreadId, tabId: string, paneId: string) => string | null;
  closeTerminalById: (threadId: ThreadId, terminalId: string) => boolean;
  replacePaneTerminalId: (
    threadId: ThreadId,
    tabId: string,
    paneId: string,
    terminalId: string,
  ) => void;
  bumpFocusNonce: () => void;
  clearThread: (threadId: ThreadId) => void;
  pruneThreads: (activeThreadIds: ReadonlySet<string>) => void;
}

function readThreadState(
  byThreadId: Record<string, BottomTerminalThreadState>,
  threadId: ThreadId,
): BottomTerminalThreadState {
  return byThreadId[threadId] ?? DEFAULT_BOTTOM_TERMINAL_STATE;
}

export function selectBottomTerminalState(threadId: ThreadId | null) {
  return (state: BottomTerminalStoreState): BottomTerminalThreadState =>
    threadId ? readThreadState(state.byThreadId, threadId) : DEFAULT_BOTTOM_TERMINAL_STATE;
}

export const useBottomTerminalStore = create<BottomTerminalStoreState>()(
  persist(
    (set, get) => ({
      byThreadId: {},
      focusNonce: 0,

      openDrawer: (threadId) => {
        const current = readThreadState(get().byThreadId, threadId);
        const existingTab = resolveActiveBottomTerminalTab(current);
        if (existingTab) {
          const leaf =
            findTerminalTileLeafById(existingTab.root, existingTab.focusedPaneId) ??
            collectTerminalTileLeaves(existingTab.root)[0]!;
          set((state) => ({
            byThreadId: {
              ...state.byThreadId,
              [threadId]: {
                ...current,
                open: true,
                activeTabId: existingTab.id,
              },
            },
            focusNonce: state.focusNonce + 1,
          }));
          return { tabId: existingTab.id, paneId: leaf.id, terminalId: leaf.terminalId };
        }

        const tabId = randomUUID();
        const paneId = randomUUID();
        const terminalId = randomTerminalId();
        const tab = createBottomTerminalTab({ tabId, paneId, terminalId });
        set((state) => ({
          byThreadId: {
            ...state.byThreadId,
            [threadId]: {
              ...current,
              open: true,
              tabs: [tab],
              activeTabId: tab.id,
            },
          },
          focusNonce: state.focusNonce + 1,
        }));
        return { tabId, paneId, terminalId };
      },

      toggleDrawer: (threadId) => {
        const current = readThreadState(get().byThreadId, threadId);
        if (current.open) {
          set((state) => ({
            byThreadId: {
              ...state.byThreadId,
              [threadId]: { ...current, open: false },
            },
          }));
          return false;
        }
        get().openDrawer(threadId);
        return true;
      },

      setDrawerOpen: (threadId, open) => {
        if (open) {
          get().openDrawer(threadId);
          return;
        }
        const current = readThreadState(get().byThreadId, threadId);
        if (!current.open) return;
        set((state) => ({
          byThreadId: {
            ...state.byThreadId,
            [threadId]: { ...current, open: false },
          },
        }));
      },

      setDrawerHeight: (threadId, heightPx) => {
        const current = readThreadState(get().byThreadId, threadId);
        const clamped = clampBottomTerminalHeight(heightPx);
        if (current.heightPx === clamped) return;
        set((state) => ({
          byThreadId: {
            ...state.byThreadId,
            [threadId]: { ...current, heightPx: clamped, maximized: false },
          },
        }));
      },

      toggleMaximized: (threadId) => {
        const current = readThreadState(get().byThreadId, threadId);
        if (!current.open) return;
        set((state) => ({
          byThreadId: {
            ...state.byThreadId,
            [threadId]: { ...current, maximized: !current.maximized },
          },
        }));
      },

      addTab: (threadId, options) => {
        const current = readThreadState(get().byThreadId, threadId);
        const tabId = randomUUID();
        const paneId = randomUUID();
        const terminalId = options?.terminalId ?? randomTerminalId();
        const tab = createBottomTerminalTab({ tabId, paneId, terminalId });
        set((state) => ({
          byThreadId: {
            ...state.byThreadId,
            [threadId]: {
              ...current,
              open: true,
              tabs: [...current.tabs, tab],
              activeTabId: tab.id,
            },
          },
          focusNonce: state.focusNonce + 1,
        }));
        return { tabId, paneId, terminalId };
      },

      selectTab: (threadId, tabId) => {
        const current = readThreadState(get().byThreadId, threadId);
        if (!current.tabs.some((tab) => tab.id === tabId)) return;
        set((state) => ({
          byThreadId: {
            ...state.byThreadId,
            [threadId]: { ...current, open: true, activeTabId: tabId },
          },
          focusNonce: state.focusNonce + 1,
        }));
      },

      cycleTab: (threadId, delta) => {
        const current = readThreadState(get().byThreadId, threadId);
        const next = cycleBottomTerminalTabInState(current, delta);
        if (next === current) return;
        set((state) => ({
          byThreadId: { ...state.byThreadId, [threadId]: next },
          focusNonce: state.focusNonce + 1,
        }));
      },

      splitFocusedPane: (threadId, direction, options) => {
        const current = readThreadState(get().byThreadId, threadId);
        const activeTab = resolveActiveBottomTerminalTab(current);
        if (!activeTab) {
          const opened = get().openDrawer(threadId);
          return { paneId: opened.paneId, terminalId: opened.terminalId };
        }
        const splitNodeId = randomUUID();
        const newPaneId = randomUUID();
        const newTerminalId = options?.terminalId ?? randomTerminalId();
        const nextRoot = splitTerminalTileInTree({
          root: activeTab.root,
          targetPaneId: activeTab.focusedPaneId,
          direction,
          splitNodeId,
          newPaneId,
          newTerminalId,
        });
        if (!nextRoot) return null;

        set((state) => ({
          byThreadId: {
            ...state.byThreadId,
            [threadId]: {
              ...current,
              open: true,
              tabs: current.tabs.map((tab) =>
                tab.id === activeTab.id
                  ? {
                      ...tab,
                      root: nextRoot,
                      focusedPaneId: newPaneId,
                      zoomedPaneId: null,
                    }
                  : tab,
              ),
            },
          },
          focusNonce: state.focusNonce + 1,
        }));
        return { paneId: newPaneId, terminalId: newTerminalId };
      },

      focusPane: (threadId, tabId, paneId) => {
        const current = readThreadState(get().byThreadId, threadId);
        const tab = current.tabs.find((candidate) => candidate.id === tabId);
        if (!tab || !findTerminalTileLeafById(tab.root, paneId)) return;
        if (tab.focusedPaneId === paneId && current.activeTabId === tabId) return;
        set((state) => ({
          byThreadId: {
            ...state.byThreadId,
            [threadId]: {
              ...current,
              activeTabId: tabId,
              tabs: current.tabs.map((candidate) =>
                candidate.id === tabId
                  ? {
                      ...candidate,
                      focusedPaneId: paneId,
                      zoomedPaneId: candidate.zoomedPaneId === paneId ? paneId : null,
                    }
                  : candidate,
              ),
            },
          },
          focusNonce: state.focusNonce + 1,
        }));
      },

      focusDirectionalPane: (threadId, direction) => {
        const current = readThreadState(get().byThreadId, threadId);
        const activeTab = resolveActiveBottomTerminalTab(current);
        if (!activeTab) return null;
        const targetPaneId = findDirectionalTerminalTile(
          activeTab.root,
          activeTab.focusedPaneId,
          direction,
        );
        if (!targetPaneId) return null;
        set((state) => ({
          byThreadId: {
            ...state.byThreadId,
            [threadId]: {
              ...current,
              tabs: current.tabs.map((tab) =>
                tab.id === activeTab.id
                  ? { ...tab, focusedPaneId: targetPaneId, zoomedPaneId: null }
                  : tab,
              ),
            },
          },
          focusNonce: state.focusNonce + 1,
        }));
        return targetPaneId;
      },

      resizeFocusedPane: (threadId, direction, step) => {
        const current = readThreadState(get().byThreadId, threadId);
        const activeTab = resolveActiveBottomTerminalTab(current);
        if (!activeTab) return;
        const nextRoot = resizeTerminalTileInTree(
          activeTab.root,
          activeTab.focusedPaneId,
          direction,
          step,
        );
        if (nextRoot === activeTab.root) return;
        set((state) => ({
          byThreadId: {
            ...state.byThreadId,
            [threadId]: {
              ...current,
              tabs: current.tabs.map((tab) =>
                tab.id === activeTab.id ? { ...tab, root: nextRoot } : tab,
              ),
            },
          },
        }));
      },

      setSplitRatio: (threadId, tabId, splitNodeId, ratio) => {
        const current = readThreadState(get().byThreadId, threadId);
        const tab = current.tabs.find((candidate) => candidate.id === tabId);
        if (!tab) return;
        const nextRoot = setTerminalSplitRatioInTree(tab.root, splitNodeId, ratio);
        if (nextRoot === tab.root) return;
        set((state) => ({
          byThreadId: {
            ...state.byThreadId,
            [threadId]: {
              ...current,
              tabs: current.tabs.map((candidate) =>
                candidate.id === tabId ? { ...candidate, root: nextRoot } : candidate,
              ),
            },
          },
        }));
      },

      toggleZoomFocusedPane: (threadId) => {
        const current = readThreadState(get().byThreadId, threadId);
        const activeTab = resolveActiveBottomTerminalTab(current);
        if (!activeTab) return;
        if (collectTerminalTileLeaves(activeTab.root).length <= 1) {
          // With a single tile, zoom toggles the drawer's expanded height instead.
          get().toggleMaximized(threadId);
          return;
        }
        const nextZoomed =
          activeTab.zoomedPaneId === activeTab.focusedPaneId ? null : activeTab.focusedPaneId;
        set((state) => ({
          byThreadId: {
            ...state.byThreadId,
            [threadId]: {
              ...current,
              tabs: current.tabs.map((tab) =>
                tab.id === activeTab.id ? { ...tab, zoomedPaneId: nextZoomed } : tab,
              ),
            },
          },
          focusNonce: state.focusNonce + 1,
        }));
      },

      closePane: (threadId, tabId, paneId) => {
        const current = readThreadState(get().byThreadId, threadId);
        const { nextState, removedTerminalId } = closeTerminalTileInState(current, tabId, paneId);
        if (removedTerminalId === null) return null;
        set((state) => ({
          byThreadId: { ...state.byThreadId, [threadId]: nextState },
          focusNonce: state.focusNonce + 1,
        }));
        return removedTerminalId;
      },

      closeTerminalById: (threadId, terminalId) => {
        const current = readThreadState(get().byThreadId, threadId);
        for (const tab of current.tabs) {
          const leaf = findTerminalTileLeafByTerminalId(tab.root, terminalId);
          if (leaf) {
            const { nextState } = closeTerminalTileInState(current, tab.id, leaf.id);
            set((state) => ({
              byThreadId: { ...state.byThreadId, [threadId]: nextState },
              focusNonce: state.focusNonce + 1,
            }));
            return true;
          }
        }
        return false;
      },

      replacePaneTerminalId: (threadId, tabId, paneId, terminalId) => {
        const current = readThreadState(get().byThreadId, threadId);
        const tab = current.tabs.find((candidate) => candidate.id === tabId);
        if (!tab) return;
        const replaceLeaf = (node: typeof tab.root): typeof tab.root => {
          if (node.kind === "leaf") {
            return node.id === paneId ? { ...node, terminalId } : node;
          }
          const first = replaceLeaf(node.first);
          const second = replaceLeaf(node.second);
          if (first === node.first && second === node.second) return node;
          return { ...node, first, second };
        };
        const nextRoot = replaceLeaf(tab.root);
        if (nextRoot === tab.root) return;
        set((state) => ({
          byThreadId: {
            ...state.byThreadId,
            [threadId]: {
              ...current,
              open: true,
              activeTabId: tabId,
              tabs: current.tabs.map((candidate) =>
                candidate.id === tabId
                  ? { ...candidate, root: nextRoot, focusedPaneId: paneId }
                  : candidate,
              ),
            },
          },
          focusNonce: state.focusNonce + 1,
        }));
      },

      bumpFocusNonce: () => {
        set((state) => ({ focusNonce: state.focusNonce + 1 }));
      },

      clearThread: (threadId) => {
        set((state) => {
          if (!(threadId in state.byThreadId)) return state;
          const next = { ...state.byThreadId };
          delete next[threadId];
          return { byThreadId: next };
        });
      },

      pruneThreads: (activeThreadIds) => {
        set((state) => {
          let changed = false;
          const next: Record<string, BottomTerminalThreadState> = {};
          for (const [threadId, entry] of Object.entries(state.byThreadId)) {
            if (activeThreadIds.has(threadId)) {
              next[threadId] = entry;
            } else {
              changed = true;
            }
          }
          return changed ? { byThreadId: next } : state;
        });
      },
    }),
    {
      name: BOTTOM_TERMINAL_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => executionStorage),
      partialize: (state) => ({ byThreadId: state.byThreadId }),
      merge: (persisted, current) => {
        const raw =
          persisted && typeof persisted === "object" && "byThreadId" in persisted
            ? (persisted as { byThreadId?: unknown }).byThreadId
            : undefined;
        return {
          ...current,
          byThreadId: sanitizeBottomTerminalStateByThreadId(raw),
        };
      },
    },
  ),
);
