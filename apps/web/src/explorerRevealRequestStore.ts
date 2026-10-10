import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";

export interface ExplorerRevealRequest {
  path: string;
  /** Monotonic per thread so re-revealing the same path still fires the effect. */
  nonce: number;
}

interface ExplorerRevealRequestState {
  requestsByThreadId: Record<string, ExplorerRevealRequest>;
  requestReveal: (threadId: ThreadId, path: string) => void;
}

export const useExplorerRevealRequestStore = create<ExplorerRevealRequestState>((set) => ({
  requestsByThreadId: {},
  requestReveal: (threadId, path) => {
    set((state) => ({
      requestsByThreadId: {
        ...state.requestsByThreadId,
        [threadId]: { path, nonce: (state.requestsByThreadId[threadId]?.nonce ?? 0) + 1 },
      },
    }));
  },
}));

export function requestExplorerReveal(threadId: ThreadId, path: string): void {
  useExplorerRevealRequestStore.getState().requestReveal(threadId, path);
}

export function directoryChain(path: string): string[] {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const chain: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    chain.push(segments.slice(0, index + 1).join("/"));
  }
  return chain;
}
