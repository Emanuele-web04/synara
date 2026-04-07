import { type ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

interface TemporaryThreadStoreState {
  temporaryThreadIds: Record<ThreadId, true | undefined>;
  markTemporaryThread: (threadId: ThreadId) => void;
  clearTemporaryThread: (threadId: ThreadId) => void;
}

export const useTemporaryThreadStore = create<TemporaryThreadStoreState>((set) => ({
  temporaryThreadIds: {},
  markTemporaryThread: (threadId) => {
    if (threadId.length === 0) return;
    set((state) => {
      if (state.temporaryThreadIds[threadId]) {
        return state;
      }
      return {
        temporaryThreadIds: {
          ...state.temporaryThreadIds,
          [threadId]: true,
        },
      };
    });
  },
  clearTemporaryThread: (threadId) => {
    if (threadId.length === 0) return;
    set((state) => {
      if (!state.temporaryThreadIds[threadId]) {
        return state;
      }
      const nextTemporaryThreadIds = { ...state.temporaryThreadIds };
      delete nextTemporaryThreadIds[threadId];
      return { temporaryThreadIds: nextTemporaryThreadIds };
    });
  },
}));
