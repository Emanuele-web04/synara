// Chat send state survives navigation so both the mounted composer and the
// background queue observe the same dispatch lifecycle.
import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";
import type { LocalDispatchSnapshot } from "../components/ChatView.logic";
import type { WorktreeSetupResolutionAction } from "../types";

interface ThreadDispatchState {
  localDispatch: LocalDispatchSnapshot | null;
  pendingAction: WorktreeSetupResolutionAction | null;
  serverAcknowledged?: boolean;
}

export const useThreadDispatchStore = create<{
  threads: Partial<Record<ThreadId, ThreadDispatchState>>;
}>(() => ({ threads: {} }));

export function updateThreadDispatch(
  threadId: ThreadId,
  patch: (current: ThreadDispatchState) => ThreadDispatchState,
): void {
  useThreadDispatchStore.setState((state) => {
    const current = state.threads[threadId] ?? { localDispatch: null, pendingAction: null };
    const next = patch(current);
    const threads = { ...state.threads };
    if (next.localDispatch === null && next.pendingAction === null) delete threads[threadId];
    else threads[threadId] = next;
    return { threads };
  });
}
