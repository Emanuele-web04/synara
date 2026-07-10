// FILE: recentViewsStore.ts
// Purpose: Persist the Ctrl+Tab recent primary views MRU used by the chat shell.
// Layer: UI state store
// Exports: useRecentViewsStore

import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  type RecentView,
  type RecentViewAvailability,
  MAX_RECENT_VIEWS,
  pruneRecentViews,
  recentViewKey,
  upsertRecentView,
} from "./recentViews.logic";
import { createMemoryStorage } from "./lib/storage";

interface RecentViewsStoreState {
  recentViews: RecentView[];
  recordRecentView: (view: RecentView) => void;
  pruneRecentViews: (availability: RecentViewAvailability) => void;
}

const RECENT_VIEWS_STORAGE_KEY = "synara:recent-views:v1";

function normalizeOptionalId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeRecentView(input: unknown): RecentView | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;

  if (record.kind === "thread") {
    const threadId = normalizeOptionalId(record.threadId);
    if (!threadId) return null;
    const splitViewId = normalizeOptionalId(record.splitViewId);
    return {
      kind: "thread",
      threadId: threadId as ThreadId,
      ...(splitViewId ? { splitViewId } : {}),
    };
  }

  if (record.kind === "workspace") {
    const workspaceId = normalizeOptionalId(record.workspaceId);
    return workspaceId ? { kind: "workspace", workspaceId } : null;
  }

  if (record.kind === "settings") {
    const section = normalizeOptionalId(record.section);
    return { kind: "settings", ...(section ? { section } : {}) };
  }

  if (record.kind === "plugins") {
    return { kind: "plugins" };
  }

  return null;
}

function normalizeRecentViews(input: unknown): RecentView[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const nextViews: RecentView[] = [];
  for (const item of input) {
    const view = normalizeRecentView(item);
    if (!view) continue;
    const key = recentViewKey(view);
    if (seen.has(key)) continue;
    seen.add(key);
    nextViews.push(view);
  }
  return nextViews.slice(0, MAX_RECENT_VIEWS);
}

function recentViewsEqual(left: readonly RecentView[], right: readonly RecentView[]): boolean {
  return (
    left.length === right.length &&
    left.every((view, index) => {
      const other = right[index];
      return other !== undefined && recentViewKey(view) === recentViewKey(other);
    })
  );
}

export const useRecentViewsStore = create<RecentViewsStoreState>()(
  persist(
    (set) => ({
      recentViews: [],
      recordRecentView: (view) => {
        set((state) => {
          const nextRecentViews = upsertRecentView(state.recentViews, view);
          return recentViewsEqual(state.recentViews, nextRecentViews)
            ? state
            : { recentViews: nextRecentViews };
        });
      },
      pruneRecentViews: (availability) => {
        set((state) => {
          const nextRecentViews = pruneRecentViews(state.recentViews, availability);
          return recentViewsEqual(state.recentViews, nextRecentViews)
            ? state
            : { recentViews: nextRecentViews };
        });
      },
    }),
    {
      name: RECENT_VIEWS_STORAGE_KEY,
      storage: createJSONStorage(() =>
        typeof localStorage === "undefined" ? createMemoryStorage() : localStorage,
      ),
      partialize: (state) => ({
        recentViews: normalizeRecentViews(state.recentViews),
      }),
      merge: (persistedState, currentState) => {
        const candidate =
          (persistedState as Partial<Pick<RecentViewsStoreState, "recentViews">> | undefined)
            ?.recentViews ?? [];
        return {
          ...currentState,
          recentViews: normalizeRecentViews(candidate),
        };
      },
    },
  ),
);
