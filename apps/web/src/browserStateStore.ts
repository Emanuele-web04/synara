// the live browser surface stays in Electron; the web app keeps only enough state to render tabs/toolbars across thread switches

import type { ThreadBrowserState, ThreadId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { isPlainObject, sanitizeStringKeyedRecord } from "./persistedRecord";

const BROWSER_STATE_STORAGE_KEY = "synara:browser-state:v1";
const BROWSER_HISTORY_LIMIT = 12;
const EMPTY_BROWSER_HISTORY: BrowserHistoryEntry[] = [];

interface StringStorage {
  getItem: (name: string) => string | null;
  setItem: (name: string, value: string) => void;
  removeItem: (name: string) => void;
}

export interface BrowserHistoryEntry {
  url: string;
  title: string;
  tabId: string;
}

interface BrowserStateStore {
  threadStatesByThreadId: Record<string, ThreadBrowserState | undefined>;
  recentHistoryByThreadId: Record<string, BrowserHistoryEntry[] | undefined>;
  upsertThreadState: (state: ThreadBrowserState) => void;
  removeThreadState: (threadId: ThreadId) => void;
}

function normalizeHistoryUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed === "about:blank" ? "" : trimmed;
}

function upsertRecentHistoryEntry(
  entries: BrowserHistoryEntry[] | undefined,
  nextEntry: BrowserHistoryEntry,
): BrowserHistoryEntry[] {
  const normalizedUrl = normalizeHistoryUrl(nextEntry.url);
  if (normalizedUrl.length === 0) {
    return entries ?? [];
  }

  const nextEntries = (entries ?? []).filter(
    (entry) => normalizeHistoryUrl(entry.url) !== normalizedUrl,
  );
  nextEntries.unshift({
    ...nextEntry,
    url: normalizedUrl,
  });
  return nextEntries.slice(0, BROWSER_HISTORY_LIMIT);
}

function sameBrowserHistoryEntries(
  previousEntries: BrowserHistoryEntry[] | undefined,
  nextEntries: BrowserHistoryEntry[],
): boolean {
  if (previousEntries === nextEntries) {
    return true;
  }

  if (previousEntries == null || previousEntries.length !== nextEntries.length) {
    return false;
  }

  return previousEntries.every((entry, index) => {
    const nextEntry = nextEntries[index];
    if (!nextEntry) {
      return false;
    }
    return (
      entry.url === nextEntry.url &&
      entry.title === nextEntry.title &&
      entry.tabId === nextEntry.tabId
    );
  });
}

function sanitizeBrowserHistoryEntry(rawEntry: unknown): BrowserHistoryEntry | null {
  if (!isPlainObject(rawEntry)) {
    return null;
  }
  const { url, title, tabId } = rawEntry;
  if (typeof url !== "string" || typeof title !== "string" || typeof tabId !== "string") {
    return null;
  }
  return { url, title, tabId };
}

// drop malformed persisted history so a corrupt entry can't reach the upsert path or render as a broken tab
export function sanitizeRecentHistoryByThreadId(
  value: unknown,
): Record<string, BrowserHistoryEntry[]> {
  return sanitizeStringKeyedRecord(value, (rawEntries) => {
    if (!Array.isArray(rawEntries)) {
      return null;
    }
    const entries = rawEntries
      .map(sanitizeBrowserHistoryEntry)
      .filter((entry): entry is BrowserHistoryEntry => entry !== null)
      .slice(0, BROWSER_HISTORY_LIMIT);
    return entries.length > 0 ? entries : null;
  });
}

export function createDedupedBrowserStateStorage(
  resolveStorage: () => StringStorage,
): StringStorage {
  const lastWrittenValueByName = new Map<string, string>();

  return {
    getItem: (name) => resolveStorage().getItem(name),
    setItem: (name, value) => {
      const previousValue = lastWrittenValueByName.get(name) ?? resolveStorage().getItem(name);
      if (previousValue === value) {
        lastWrittenValueByName.set(name, value);
        return;
      }
      lastWrittenValueByName.set(name, value);
      resolveStorage().setItem(name, value);
    },
    removeItem: (name) => {
      lastWrittenValueByName.delete(name);
      resolveStorage().removeItem(name);
    },
  };
}

const browserStateStorage = createDedupedBrowserStateStorage(() => localStorage);

export const useBrowserStateStore = create<BrowserStateStore>()(
  persist(
    (set) => ({
      threadStatesByThreadId: {},
      recentHistoryByThreadId: {},
      upsertThreadState: (state) =>
        set((current) => {
          const previousState = current.threadStatesByThreadId[state.threadId];
          // main pushes state before some invoke promises resolve — a delayed response must never roll chrome back to an older tab/runtime generation
          if (previousState && previousState.version >= state.version) {
            return current;
          }
          const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
          const orderedTabs = activeTab
            ? [activeTab, ...state.tabs.filter((tab) => tab.id !== activeTab.id)]
            : state.tabs;
          const previousHistory =
            current.recentHistoryByThreadId[state.threadId] ?? EMPTY_BROWSER_HISTORY;
          const nextHistory = orderedTabs.reduce(
            (entries, tab) =>
              upsertRecentHistoryEntry(entries, {
                url: tab.lastCommittedUrl ?? tab.url,
                title: tab.title,
                tabId: tab.id,
              }),
            previousHistory,
          );
          const historyChanged = !sameBrowserHistoryEntries(previousHistory, nextHistory);

          return {
            threadStatesByThreadId: {
              ...current.threadStatesByThreadId,
              [state.threadId]: state,
            },
            recentHistoryByThreadId: historyChanged
              ? {
                  ...current.recentHistoryByThreadId,
                  [state.threadId]: nextHistory,
                }
              : current.recentHistoryByThreadId,
          };
        }),
      removeThreadState: (threadId) =>
        set((current) => {
          if (!Object.hasOwn(current.threadStatesByThreadId, threadId)) {
            return current;
          }
          const nextThreadStatesByThreadId = {
            ...current.threadStatesByThreadId,
          };
          const nextRecentHistoryByThreadId = {
            ...current.recentHistoryByThreadId,
          };
          delete nextThreadStatesByThreadId[threadId];
          delete nextRecentHistoryByThreadId[threadId];
          return {
            threadStatesByThreadId: nextThreadStatesByThreadId,
            recentHistoryByThreadId: nextRecentHistoryByThreadId,
          };
        }),
    }),
    {
      name: BROWSER_STATE_STORAGE_KEY,
      storage: createJSONStorage(() => browserStateStorage),
      partialize: (state) => ({
        recentHistoryByThreadId: state.recentHistoryByThreadId,
      }),
      merge: (persisted, current) => ({
        ...current,
        recentHistoryByThreadId: sanitizeRecentHistoryByThreadId(
          (persisted as { recentHistoryByThreadId?: unknown } | undefined)?.recentHistoryByThreadId,
        ),
      }),
    },
  ),
);

export function selectThreadBrowserState(
  threadId: ThreadId,
): (store: BrowserStateStore) => ThreadBrowserState | undefined {
  return (store) => store.threadStatesByThreadId[threadId];
}

export function selectThreadBrowserHistory(
  threadId: ThreadId,
): (store: BrowserStateStore) => BrowserHistoryEntry[] {
  return (store) => store.recentHistoryByThreadId[threadId] ?? EMPTY_BROWSER_HISTORY;
}
