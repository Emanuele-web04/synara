// FILE: sidebarSubagentDetachStore.ts
// Purpose: Persists which subagent threads stay detached from their parent row in the sidebar.
// Layer: UI state store
// Exports: useSidebarSubagentDetachStore and detached-id helpers.

import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface SidebarSubagentDetachState {
  detachedThreadIds: Record<string, true>;
  detachSubagent: (threadId: ThreadId) => void;
  attachSubagent: (threadId: ThreadId) => void;
}

const STORAGE_KEY = "synara:sidebar-subagent-detach:v1";
const unavailableStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

function sanitizeDetachedRecord(value: unknown): Record<string, true> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => key.length > 0 && entry === true)
      .map(([key]) => [key, true] as const),
  );
}

// A detached subagent renders as a top-level row: it survives navigation, can be
// moved into a thread folder, and is only auto-hidden once its turn settles.
export function detachedThreadIdSet(
  detachedThreadIds: Readonly<Record<string, true>>,
): ReadonlySet<ThreadId> {
  return new Set(Object.keys(detachedThreadIds) as ThreadId[]);
}

export const useSidebarSubagentDetachStore = create<SidebarSubagentDetachState>()(
  persist(
    (set) => ({
      detachedThreadIds: {},
      detachSubagent: (threadId) =>
        set((state) => ({
          detachedThreadIds: { ...state.detachedThreadIds, [threadId]: true },
        })),
      attachSubagent: (threadId) =>
        set((state) => {
          if (state.detachedThreadIds[threadId] === undefined) return state;
          const next = { ...state.detachedThreadIds };
          delete next[threadId];
          return { detachedThreadIds: next };
        }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() =>
        typeof localStorage === "undefined" ? unavailableStorage : localStorage,
      ),
      partialize: (state) => ({ detachedThreadIds: state.detachedThreadIds }),
      merge: (persisted, current) => {
        const candidate = (persisted ?? {}) as Record<string, unknown>;
        return {
          ...current,
          detachedThreadIds: sanitizeDetachedRecord(candidate.detachedThreadIds),
        };
      },
    },
  ),
);
