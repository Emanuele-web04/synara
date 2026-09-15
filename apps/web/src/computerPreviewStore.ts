// FILE: computerPreviewStore.ts
// Purpose: Per-thread session state behind the in-chat computer preview popover.
// Layer: Web UI state store
// Exports: useComputerPreviewStore, selectThreadComputerPreviewSession
// Depends on: ComputerPreviewPopover.logic phase transitions
//
// The session machine is the popover's memory: a surface request or a drive
// turn arms the owning thread whether or not its chat is on screen, so
// background agent work never steals the user's current chat: it only waits
// for that thread to be viewed.

import type { ThreadComputerState, ThreadId } from "@synara/contracts";
import { create } from "zustand";

import {
  computerPreviewAgentActive,
  computerPreviewPhaseOnAgentEdge,
  computerPreviewPhaseOnHide,
  computerPreviewPhaseOnSurfaceRequest,
  computerPreviewPhaseOnViewed,
  type ComputerPreviewPhase,
  type ComputerPreviewSession,
} from "./components/chat/ComputerPreviewPopover.logic";

interface ComputerPreviewStore {
  sessionsByThreadId: Record<string, ComputerPreviewSession | undefined>;
  /** Last observed drive state per thread; its edges arm and end sessions. */
  agentActiveByThreadId: Record<string, boolean | undefined>;
  /** `computer.open-pane-requested` arrived for this thread's own lease. */
  requestPreviewSurface: (threadId: ThreadId) => void;
  /** Any thread-state write (push or seed); edges are detected inside. */
  noteThreadComputerState: (state: ThreadComputerState) => void;
  /** Newest spoken action label; an action is itself evidence of driving. */
  noteThreadActionLabel: (threadId: ThreadId, label: string) => void;
  /** The owning thread's chat surface is rendering the popover. */
  markPreviewLive: (threadId: ThreadId) => void;
  /** The user closed the preview; it stays hidden until the task ends. */
  hidePreviewForTask: (threadId: ThreadId) => void;
  removePreviewSession: (threadId: ThreadId) => void;
  clear: () => void;
}

function sessionWithPhase(
  session: ComputerPreviewSession | undefined,
  threadId: ThreadId,
  phase: ComputerPreviewPhase,
): ComputerPreviewSession {
  if (!session) {
    return { threadId, phase };
  }
  return { ...session, phase };
}

function updateSessionPhase(
  current: ComputerPreviewStore,
  threadId: ThreadId,
  nextPhase: (phase: ComputerPreviewPhase | undefined) => ComputerPreviewPhase | undefined,
): ComputerPreviewStore {
  const session = current.sessionsByThreadId[threadId];
  const phase = nextPhase(session?.phase);
  if (phase === undefined || phase === session?.phase) {
    return current;
  }
  return {
    ...current,
    sessionsByThreadId: {
      ...current.sessionsByThreadId,
      [threadId]: sessionWithPhase(session, threadId, phase),
    },
  };
}

export const useComputerPreviewStore = create<ComputerPreviewStore>()((set) => ({
  sessionsByThreadId: {},
  agentActiveByThreadId: {},
  requestPreviewSurface: (threadId) =>
    set((current) => updateSessionPhase(current, threadId, computerPreviewPhaseOnSurfaceRequest)),
  noteThreadComputerState: (state) =>
    set((current) => {
      const threadId = state.threadId;
      const active = computerPreviewAgentActive(state);
      const wasActive = current.agentActiveByThreadId[threadId] ?? false;
      if (active === wasActive) {
        return current;
      }
      const next: ComputerPreviewStore = {
        ...current,
        agentActiveByThreadId: { ...current.agentActiveByThreadId, [threadId]: active },
      };
      return updateSessionPhase(next, threadId, (phase) =>
        computerPreviewPhaseOnAgentEdge(phase, active ? "rose" : "fell"),
      );
    }),
  noteThreadActionLabel: (threadId, label) =>
    set((current) => {
      const session = current.sessionsByThreadId[threadId];
      if (session?.lastActionLabel === label) {
        return current;
      }
      const nextSession: ComputerPreviewSession = session
        ? { ...session, lastActionLabel: label }
        : // An attributed action is itself proof the thread is driving, so it
          // arms like a surface request when nothing has arrived yet.
          { threadId, phase: "armed", lastActionLabel: label };
      return {
        ...current,
        sessionsByThreadId: { ...current.sessionsByThreadId, [threadId]: nextSession },
      };
    }),
  markPreviewLive: (threadId) =>
    set((current) => updateSessionPhase(current, threadId, computerPreviewPhaseOnViewed)),
  hidePreviewForTask: (threadId) =>
    set((current) => updateSessionPhase(current, threadId, computerPreviewPhaseOnHide)),
  removePreviewSession: (threadId) =>
    set((current) => {
      const hasSession = Object.hasOwn(current.sessionsByThreadId, threadId);
      const hasActive = Object.hasOwn(current.agentActiveByThreadId, threadId);
      if (!hasSession && !hasActive) {
        return current;
      }
      const sessionsByThreadId = { ...current.sessionsByThreadId };
      delete sessionsByThreadId[threadId];
      const agentActiveByThreadId = { ...current.agentActiveByThreadId };
      delete agentActiveByThreadId[threadId];
      return { ...current, sessionsByThreadId, agentActiveByThreadId };
    }),
  clear: () => set({ sessionsByThreadId: {}, agentActiveByThreadId: {} }),
}));

export function selectThreadComputerPreviewSession(
  threadId: ThreadId,
): (store: ComputerPreviewStore) => ComputerPreviewSession | undefined {
  return (store) => store.sessionsByThreadId[threadId];
}
