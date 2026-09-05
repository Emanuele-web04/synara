import type {
  ComputerEvent,
  ComputerWindow,
  ThreadComputerState,
  ThreadId,
} from "@synara/contracts";
import { create } from "zustand";

type ComputerActionEvent = Extract<ComputerEvent, { type: "computer.action" }>;

interface ComputerStateStore {
  threadStatesByThreadId: Record<string, ThreadComputerState | undefined>;
  /** Newest desktop action from any source, including unattributed pane input. */
  lastAction: ComputerActionEvent | null;
  /** Newest desktop action per thread, so one thread never reads another's. */
  lastActionByThreadId: Record<string, ComputerActionEvent | undefined>;
  upsertThreadState: (state: ThreadComputerState) => void;
  applyWindowsChanged: (windows: readonly ComputerWindow[]) => void;
  recordAction: (action: ComputerActionEvent) => void;
  removeThreadState: (threadId: ThreadId) => void;
  clear: () => void;
}

export const useComputerStateStore = create<ComputerStateStore>()((set) => ({
  threadStatesByThreadId: {},
  lastAction: null,
  lastActionByThreadId: {},
  upsertThreadState: (state) =>
    set((current) => {
      const previousState = current.threadStatesByThreadId[state.threadId];
      if (previousState && previousState.version >= state.version) {
        return current;
      }
      return {
        ...current,
        threadStatesByThreadId: {
          ...current.threadStatesByThreadId,
          [state.threadId]: state,
        },
      };
    }),
  applyWindowsChanged: (windows) =>
    set((current) => {
      let changed = false;
      const nextStates = { ...current.threadStatesByThreadId };
      for (const [threadId, state] of Object.entries(current.threadStatesByThreadId)) {
        if (!state || state.windows === windows) {
          continue;
        }
        nextStates[threadId] = { ...state, windows: [...windows] };
        changed = true;
      }
      return changed ? { ...current, threadStatesByThreadId: nextStates } : current;
    }),
  recordAction: (action) =>
    set((current) => ({
      ...current,
      lastAction: action,
      ...(action.threadId
        ? {
            lastActionByThreadId: {
              ...current.lastActionByThreadId,
              [action.threadId]: action,
            },
          }
        : {}),
    })),
  removeThreadState: (threadId) =>
    set((current) => {
      const hasState = Object.hasOwn(current.threadStatesByThreadId, threadId);
      const hasAction = Object.hasOwn(current.lastActionByThreadId, threadId);
      if (!hasState && !hasAction) {
        return current;
      }
      const nextThreadStatesByThreadId = { ...current.threadStatesByThreadId };
      delete nextThreadStatesByThreadId[threadId];
      const nextLastActionByThreadId = { ...current.lastActionByThreadId };
      delete nextLastActionByThreadId[threadId];
      return {
        ...current,
        threadStatesByThreadId: nextThreadStatesByThreadId,
        lastActionByThreadId: nextLastActionByThreadId,
      };
    }),
  clear: () => set({ threadStatesByThreadId: {}, lastAction: null, lastActionByThreadId: {} }),
}));

export function selectThreadComputerState(
  threadId: ThreadId,
): (store: ComputerStateStore) => ThreadComputerState | undefined {
  return (store) => store.threadStatesByThreadId[threadId];
}

export function selectThreadComputerAction(
  threadId: ThreadId,
): (store: ComputerStateStore) => ComputerActionEvent | undefined {
  return (store) => store.lastActionByThreadId[threadId];
}
