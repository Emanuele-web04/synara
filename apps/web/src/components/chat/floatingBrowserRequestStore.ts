// a background agent can open a page while another chat is focused; the request survives that visit and a temporarily visible dock browser

import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";

interface FloatingBrowserRequestStore {
  requestedByThreadId: Record<string, true | undefined>;
  request: (threadId: ThreadId) => void;
  dismiss: (threadId: ThreadId) => void;
}

export const useFloatingBrowserRequestStore = create<FloatingBrowserRequestStore>((set) => ({
  requestedByThreadId: {},
  request: (threadId) =>
    set((current) => {
      if (current.requestedByThreadId[threadId]) {
        return current;
      }
      return {
        requestedByThreadId: {
          ...current.requestedByThreadId,
          [threadId]: true,
        },
      };
    }),
  dismiss: (threadId) =>
    set((current) => {
      if (!current.requestedByThreadId[threadId]) {
        return current;
      }
      const requestedByThreadId = { ...current.requestedByThreadId };
      delete requestedByThreadId[threadId];
      return { requestedByThreadId };
    }),
}));

export function selectFloatingBrowserRequested(
  threadId: ThreadId,
): (store: FloatingBrowserRequestStore) => boolean {
  return (store) => store.requestedByThreadId[threadId] === true;
}
