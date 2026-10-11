// FILE: composerFocusRequestStore.ts
// Purpose: Lets panels outside ChatView (diff headers, file explorer, preview)
//          ask the active thread's composer to take focus after inserting text.
// Layer: Web UI state store

import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";

interface ComposerFocusRequestState {
  // Monotonic nonce per thread; ChatView focuses its composer when it changes.
  requestsByThreadId: Record<string, number>;
  requestFocus: (threadId: ThreadId) => void;
}

export const useComposerFocusRequestStore = create<ComposerFocusRequestState>((set) => ({
  requestsByThreadId: {},
  requestFocus: (threadId) => {
    set((state) => ({
      requestsByThreadId: {
        ...state.requestsByThreadId,
        [threadId]: (state.requestsByThreadId[threadId] ?? 0) + 1,
      },
    }));
  },
}));

export function requestComposerFocus(threadId: ThreadId): void {
  useComposerFocusRequestStore.getState().requestFocus(threadId);
}
