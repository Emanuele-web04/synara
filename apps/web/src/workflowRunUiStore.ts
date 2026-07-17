// FILE: workflowRunUiStore.ts
// Purpose: Persist per-thread workflow-run UI flags (Claude dynamic workflows):
// which settled workflow task ids the user paused (vs. a plain stop) and which
// the user dismissed. Neither is derivable from persisted activities — pause is
// encoded as an ordinary stop, dismissal has no domain event — so this store is
// the source of truth across reloads.
// Layer: UI state store
// Exports: useWorkflowRunUiStore, useWorkflowRunUiThreadState, default-state helper

import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { isPlainObject, sanitizeStringKeyedRecord } from "./persistedRecord";

export interface WorkflowRunUiThreadState {
  pausedByUser: readonly string[];
  dismissed: readonly string[];
}

interface WorkflowRunUiStoreState {
  stateByThreadId: Record<string, WorkflowRunUiThreadState | undefined>;
  markPaused: (threadId: ThreadId, workflowTaskId: string) => void;
  unmarkPaused: (threadId: ThreadId, workflowTaskId: string) => void;
  markDismissed: (threadId: ThreadId, workflowTaskId: string) => void;
  // Drops all tracked flags for a thread (e.g. once the thread itself is deleted).
  clearThread: (threadId: ThreadId) => void;
}

const WORKFLOW_RUN_UI_STORAGE_KEY = "synara:workflow-run-ui:v1";
// Workflow task ids accumulate one per run; a thread re-running workflows for
// months should still not grow this without bound. Keep the newest entries.
const MAX_ENTRIES_PER_LIST = 50;

const EMPTY_LIST: readonly string[] = Object.freeze([]);

export function createDefaultWorkflowRunUiThreadState(): WorkflowRunUiThreadState {
  return { pausedByUser: EMPTY_LIST, dismissed: EMPTY_LIST };
}

const DEFAULT_WORKFLOW_RUN_UI_THREAD_STATE = createDefaultWorkflowRunUiThreadState();

function getDefaultWorkflowRunUiThreadState(): WorkflowRunUiThreadState {
  return DEFAULT_WORKFLOW_RUN_UI_THREAD_STATE;
}

// Appends `id` if absent, capping the list to the newest MAX_ENTRIES_PER_LIST
// entries (oldest dropped first). Returns the same array reference when `id`
// is already present, so callers can skip a state update.
function withAppendedId(list: readonly string[], id: string): readonly string[] {
  if (list.includes(id)) {
    return list;
  }
  const next = [...list, id];
  return next.length > MAX_ENTRIES_PER_LIST ? next.slice(next.length - MAX_ENTRIES_PER_LIST) : next;
}

function withRemovedId(list: readonly string[], id: string): readonly string[] {
  return list.includes(id) ? list.filter((entry) => entry !== id) : list;
}

function sanitizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    ids.push(entry);
    if (ids.length >= MAX_ENTRIES_PER_LIST) {
      break;
    }
  }
  return ids;
}

function sanitizeWorkflowRunUiThreadState(rawState: unknown): WorkflowRunUiThreadState | null {
  if (!isPlainObject(rawState)) {
    return null;
  }
  const pausedByUser = sanitizeIdList(rawState.pausedByUser);
  const dismissed = sanitizeIdList(rawState.dismissed);
  if (pausedByUser.length === 0 && dismissed.length === 0) {
    return null;
  }
  return { pausedByUser, dismissed };
}

// Validates persisted per-thread workflow-run flags so a malformed entry
// degrades to defaults instead of flowing into the UI.
export function sanitizeWorkflowRunUiStateByThreadId(
  value: unknown,
): Record<string, WorkflowRunUiThreadState> {
  return sanitizeStringKeyedRecord(value, sanitizeWorkflowRunUiThreadState);
}

export const useWorkflowRunUiStore = create<WorkflowRunUiStoreState>()(
  persist(
    (set) => ({
      stateByThreadId: {},
      markPaused: (threadId, workflowTaskId) =>
        set((state) => {
          const previous = state.stateByThreadId[threadId] ?? getDefaultWorkflowRunUiThreadState();
          const pausedByUser = withAppendedId(previous.pausedByUser, workflowTaskId);
          if (pausedByUser === previous.pausedByUser) {
            return state;
          }
          return {
            stateByThreadId: {
              ...state.stateByThreadId,
              [threadId]: { ...previous, pausedByUser },
            },
          };
        }),
      unmarkPaused: (threadId, workflowTaskId) =>
        set((state) => {
          const previous = state.stateByThreadId[threadId];
          if (!previous) {
            return state;
          }
          const pausedByUser = withRemovedId(previous.pausedByUser, workflowTaskId);
          if (pausedByUser === previous.pausedByUser) {
            return state;
          }
          return {
            stateByThreadId: {
              ...state.stateByThreadId,
              [threadId]: { ...previous, pausedByUser },
            },
          };
        }),
      markDismissed: (threadId, workflowTaskId) =>
        set((state) => {
          const previous = state.stateByThreadId[threadId] ?? getDefaultWorkflowRunUiThreadState();
          const dismissed = withAppendedId(previous.dismissed, workflowTaskId);
          if (dismissed === previous.dismissed) {
            return state;
          }
          return {
            stateByThreadId: {
              ...state.stateByThreadId,
              [threadId]: { ...previous, dismissed },
            },
          };
        }),
      clearThread: (threadId) =>
        set((state) => {
          if (!Object.hasOwn(state.stateByThreadId, threadId)) {
            return state;
          }
          const nextStateByThreadId = { ...state.stateByThreadId };
          delete nextStateByThreadId[threadId];
          return { stateByThreadId: nextStateByThreadId };
        }),
    }),
    {
      name: WORKFLOW_RUN_UI_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => ({
        ...current,
        stateByThreadId: sanitizeWorkflowRunUiStateByThreadId(
          (persisted as { stateByThreadId?: unknown } | undefined)?.stateByThreadId,
        ),
      }),
    },
  ),
);

export function selectWorkflowRunUiThreadState(threadId: ThreadId | null) {
  return (store: WorkflowRunUiStoreState): WorkflowRunUiThreadState =>
    // Keep the fallback snapshot stable so React does not observe a phantom store
    // change while mounting a thread that has no tracked workflow-run flags yet.
    (threadId ? store.stateByThreadId[threadId] : undefined) ??
    getDefaultWorkflowRunUiThreadState();
}

export function useWorkflowRunUiThreadState(threadId: ThreadId | null): WorkflowRunUiThreadState {
  return useWorkflowRunUiStore(selectWorkflowRunUiThreadState(threadId));
}
