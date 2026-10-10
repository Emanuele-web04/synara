import type {
  ComputerEvent,
  ComputerWindow,
  ThreadComputerState,
  ThreadId,
} from "@synara/contracts";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

type ComputerActionEvent = Extract<ComputerEvent, { type: "computer.action" }>;

interface ComputerStateStore {
  threadStatesByThreadId: Record<string, ThreadComputerState | undefined>;
  /** Newest desktop action per thread, so one thread never reads another's. */
  lastActionByThreadId: Record<string, ComputerActionEvent | undefined>;
  /**
   * Host-wide physical-Escape kill latch, true after a `computer.input-stopped`
   * push until the user's explicit re-arm. Kept beside the per-thread states
   * because the press belongs to no thread — a conversation with no pane state
   * still has to see input is stopped.
   */
  inputStopped: boolean;
  upsertThreadState: (state: ThreadComputerState) => void;
  applyWindowsChanged: (windows: readonly ComputerWindow[]) => void;
  setInputStopped: (stopped: boolean) => void;
  recordAction: (action: ComputerActionEvent) => void;
  removeThreadState: (threadId: ThreadId) => void;
  clear: () => void;
}

export const useComputerStateStore = create<ComputerStateStore>()((set) => ({
  threadStatesByThreadId: {},
  lastActionByThreadId: {},
  inputStopped: false,
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
        nextStates[threadId] = { ...state, windows };
        changed = true;
      }
      return changed ? { ...current, threadStatesByThreadId: nextStates } : current;
    }),
  setInputStopped: (stopped) =>
    set((current) => {
      if (current.inputStopped === stopped) return current;
      // Stamp the flag onto every cached thread state too, so a pane reading
      // only `ThreadComputerState.inputStopped` sees the transition without
      // waiting for the server's republish — and a republish arriving first
      // cannot leave the two disagreeing.
      const nextStates: Record<string, ThreadComputerState | undefined> = {};
      for (const [threadId, state] of Object.entries(current.threadStatesByThreadId)) {
        nextStates[threadId] = state ? { ...state, inputStopped: stopped } : state;
      }
      return { ...current, inputStopped: stopped, threadStatesByThreadId: nextStates };
    }),
  recordAction: (action) =>
    set((current) => {
      // Unattributed pane input belongs to no thread, and nothing reads a
      // cross-thread "newest action": keeping the state identical leaves every
      // subscriber unnotified instead of re-rendering them for nobody.
      const threadId = action.threadId;
      if (!threadId) {
        return current;
      }
      return {
        ...current,
        lastActionByThreadId: {
          ...current.lastActionByThreadId,
          [threadId]: action,
        },
      };
    }),
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
  clear: () =>
    set({
      threadStatesByThreadId: {},
      lastActionByThreadId: {},
      // A wholesale reset (server restart) cannot inherit the old latch: the
      // new server's own `computer.input-stopped` state is the truth.
      inputStopped: false,
    }),
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

/** Composer availability does not change with desktop activity or geometry. */
export function useThreadComputerAvailability(threadId: ThreadId) {
  return useComputerStateStore(
    useShallow((state) => state.threadStatesByThreadId[threadId]?.availability),
  );
}

/** Observe revocation only, without rerendering the composer for desktop actions. */
export function useThreadComputerControlGeneration(threadId: ThreadId) {
  return useComputerStateStore(
    (state) => state.threadStatesByThreadId[threadId]?.controlGeneration,
  );
}
