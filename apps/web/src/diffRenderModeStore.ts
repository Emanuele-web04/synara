// FILE: diffRenderModeStore.ts
// Purpose: Persists per-thread stacked/split diff layout choices separately from the
//          Settings default, so in-panel toggles survive thread switches without
//          overwriting the configurable default.
// Layer: Web UI state store
// Exports: per-thread diff render mode store helpers

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { DiffRenderMode } from "./diffRenderMode";
import { sanitizeStringKeyedRecord } from "./persistedRecord";

export const THREAD_DIFF_RENDER_MODE_STORAGE_KEY = "synara:diff-render-mode-by-thread:v1";
export const MAX_SAVED_THREAD_DIFF_LAYOUTS = 512;

function isDiffRenderMode(value: unknown): value is DiffRenderMode {
  return value === "stacked" || value === "split";
}

function retainRecentModes(modes: Record<string, DiffRenderMode>): Record<string, DiffRenderMode> {
  return Object.fromEntries(Object.entries(modes).slice(-MAX_SAVED_THREAD_DIFF_LAYOUTS));
}

interface DiffRenderModeStore {
  modeByThreadId: Record<string, DiffRenderMode>;
  getModeForThread: (threadId: string | null, fallback: DiffRenderMode) => DiffRenderMode;
  setModeForThread: (threadId: string, mode: DiffRenderMode) => void;
  removeThread: (threadId: string) => void;
}

export const useDiffRenderModeStore = create<DiffRenderModeStore>()(
  persist(
    (set, get) => ({
      modeByThreadId: {},
      getModeForThread: (threadId, fallback) => {
        if (!threadId) {
          return fallback;
        }
        const modes = get().modeByThreadId;
        return Object.hasOwn(modes, threadId) ? modes[threadId]! : fallback;
      },
      setModeForThread: (threadId, mode) => {
        if (!threadId || !isDiffRenderMode(mode)) return;
        set((state) => {
          const { [threadId]: _previous, ...rest } = state.modeByThreadId;
          return { modeByThreadId: retainRecentModes({ ...rest, [threadId]: mode }) };
        });
      },
      removeThread: (threadId) => {
        if (!Object.hasOwn(get().modeByThreadId, threadId)) return;
        set((state) => {
          const { [threadId]: _removed, ...modeByThreadId } = state.modeByThreadId;
          return { modeByThreadId };
        });
      },
    }),
    {
      name: THREAD_DIFF_RENDER_MODE_STORAGE_KEY,
      // Resolve storage through globalThis on each call so tests can replace
      // localStorage after this module has already been evaluated.
      storage: createJSONStorage(() => ({
        getItem: (name) => {
          try {
            return globalThis.localStorage?.getItem(name) ?? null;
          } catch {
            return null;
          }
        },
        setItem: (name, value) => {
          try {
            globalThis.localStorage?.setItem(name, value);
          } catch {
            // Keep the active layout usable when browser storage is unavailable.
          }
        },
        removeItem: (name) => {
          try {
            globalThis.localStorage?.removeItem(name);
          } catch {
            // In-memory cleanup must still complete if storage has been disabled.
          }
        },
      })),
      partialize: (state) => ({ modeByThreadId: state.modeByThreadId }),
      merge: (persisted, current) => {
        const persistedModes = (persisted as { modeByThreadId?: unknown } | undefined)
          ?.modeByThreadId;
        return {
          ...current,
          modeByThreadId: retainRecentModes(
            sanitizeStringKeyedRecord(persistedModes, (value) =>
              isDiffRenderMode(value) ? value : null,
            ),
          ),
        };
      },
    },
  ),
);
