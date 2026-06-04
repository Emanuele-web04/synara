// FILE: runtimePlanDraftStore.ts
// Purpose: Holds the in-progress execution-runtime plan a draft thread will carry
// into `thread.create`. Kept separate from the persisted composer draft store so
// the existing draft schema/migrations stay untouched and default (local) thread
// creation is unaffected — no entry here means no `runtimePlan` on create.
// Layer: Web UI state store (non-persisted, ephemeral per draft thread)

import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { DEFAULT_RUNTIME_PLAN_DRAFT, type RuntimePlanDraft } from "./lib/runtimePresentation";

interface RuntimePlanDraftStore {
  draftByThreadId: Record<ThreadId, RuntimePlanDraft>;
  getDraft: (threadId: ThreadId) => RuntimePlanDraft;
  setDraft: (threadId: ThreadId, patch: Partial<RuntimePlanDraft>) => void;
  clearDraft: (threadId: ThreadId) => void;
}

export const useRuntimePlanDraftStore = create<RuntimePlanDraftStore>()((set, get) => ({
  draftByThreadId: {},
  getDraft: (threadId) => get().draftByThreadId[threadId] ?? DEFAULT_RUNTIME_PLAN_DRAFT,
  setDraft: (threadId, patch) =>
    set((state) => {
      const current = state.draftByThreadId[threadId] ?? DEFAULT_RUNTIME_PLAN_DRAFT;
      return {
        draftByThreadId: {
          ...state.draftByThreadId,
          [threadId]: { ...current, ...patch },
        },
      };
    }),
  clearDraft: (threadId) =>
    set((state) => {
      if (!(threadId in state.draftByThreadId)) {
        return state;
      }
      const next = { ...state.draftByThreadId };
      delete next[threadId];
      return { draftByThreadId: next };
    }),
}));

/** Read the current runtime plan draft outside React (creation flow). */
export function readRuntimePlanDraft(threadId: ThreadId): RuntimePlanDraft {
  return useRuntimePlanDraftStore.getState().getDraft(threadId);
}

/** Drop the draft once the thread is created so it never leaks into a reused id. */
export function clearRuntimePlanDraft(threadId: ThreadId): void {
  useRuntimePlanDraftStore.getState().clearDraft(threadId);
}
