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
  /**
   * Live layout footprint per thread, published by the mounted card: whether
   * a real frame or a first-frame error is visible, plus the fitted card width
   * (so the content inset matches the card).
   */
  previewLayoutByThreadId: Record<string, ComputerPreviewLayout | undefined>;
  /**
   * Detached card position per thread, in viewport CSS pixels. A thread with
   * an entry renders the preview as a draggable floating card instead of in
   * the rail; the rail then reserves no gutter for it.
   */
  floatingByThreadId: Record<string, ComputerPreviewFloatingPosition | undefined>;
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
  /** The mounted card's live footprint; identity-stable when unchanged. */
  notePreviewLayout: (threadId: ThreadId, layout: ComputerPreviewLayout) => void;
  /**
   * Detach the card at `position` (viewport px), or re-dock it in the rail
   * when `position` is null. Clearing also happens on session removal.
   */
  setPreviewFloating: (
    threadId: ThreadId,
    position: ComputerPreviewFloatingPosition | null,
  ) => void;
  /** Drag update for a detached card; a no-op while the thread is docked. */
  movePreviewFloating: (threadId: ThreadId, position: ComputerPreviewFloatingPosition) => void;
  removePreviewSession: (threadId: ThreadId) => void;
  clear: () => void;
}

export interface ComputerPreviewLayout {
  readonly hasFrame: boolean;
  /** A first-frame error is visible content too, without claiming a decoded frame. */
  readonly hasVisibleStatus?: boolean | undefined;
  readonly width: number;
  /** True while the card floats detached; the rail reserves no inset for it. */
  readonly floating?: boolean | undefined;
}

/** Top-left of a detached card in viewport CSS pixels. */
export interface ComputerPreviewFloatingPosition {
  readonly x: number;
  readonly y: number;
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
  previewLayoutByThreadId: {},
  floatingByThreadId: {},
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
  notePreviewLayout: (threadId, layout) =>
    set((current) => {
      const previous = current.previewLayoutByThreadId[threadId];
      if (
        previous?.hasFrame === layout.hasFrame &&
        previous?.hasVisibleStatus === layout.hasVisibleStatus &&
        previous?.width === layout.width &&
        previous?.floating === layout.floating
      ) {
        return current;
      }
      return {
        ...current,
        previewLayoutByThreadId: { ...current.previewLayoutByThreadId, [threadId]: layout },
      };
    }),
  setPreviewFloating: (threadId, position) =>
    set((current) => {
      if (position === null) {
        if (!Object.hasOwn(current.floatingByThreadId, threadId)) {
          return current;
        }
        const floatingByThreadId = { ...current.floatingByThreadId };
        delete floatingByThreadId[threadId];
        return { ...current, floatingByThreadId };
      }
      const previous = current.floatingByThreadId[threadId];
      if (previous?.x === position.x && previous?.y === position.y) {
        return current;
      }
      return {
        ...current,
        floatingByThreadId: { ...current.floatingByThreadId, [threadId]: position },
      };
    }),
  movePreviewFloating: (threadId, position) =>
    set((current) => {
      const previous = current.floatingByThreadId[threadId];
      if (previous === undefined || (previous.x === position.x && previous.y === position.y)) {
        return current;
      }
      return {
        ...current,
        floatingByThreadId: { ...current.floatingByThreadId, [threadId]: position },
      };
    }),
  removePreviewSession: (threadId) =>
    set((current) => {
      const hasSession = Object.hasOwn(current.sessionsByThreadId, threadId);
      const hasActive = Object.hasOwn(current.agentActiveByThreadId, threadId);
      const hasLayout = Object.hasOwn(current.previewLayoutByThreadId, threadId);
      const hasFloating = Object.hasOwn(current.floatingByThreadId, threadId);
      if (!hasSession && !hasActive && !hasLayout && !hasFloating) {
        return current;
      }
      const sessionsByThreadId = { ...current.sessionsByThreadId };
      delete sessionsByThreadId[threadId];
      const agentActiveByThreadId = { ...current.agentActiveByThreadId };
      delete agentActiveByThreadId[threadId];
      const previewLayoutByThreadId = { ...current.previewLayoutByThreadId };
      delete previewLayoutByThreadId[threadId];
      const floatingByThreadId = { ...current.floatingByThreadId };
      delete floatingByThreadId[threadId];
      return {
        ...current,
        sessionsByThreadId,
        agentActiveByThreadId,
        previewLayoutByThreadId,
        floatingByThreadId,
      };
    }),
  clear: () =>
    set({
      sessionsByThreadId: {},
      agentActiveByThreadId: {},
      previewLayoutByThreadId: {},
      floatingByThreadId: {},
    }),
}));

export function selectThreadComputerPreviewSession(
  threadId: ThreadId,
): (store: ComputerPreviewStore) => ComputerPreviewSession | undefined {
  return (store) => store.sessionsByThreadId[threadId];
}

export function selectThreadComputerPreviewLayout(
  threadId: ThreadId,
): (store: ComputerPreviewStore) => ComputerPreviewLayout | undefined {
  return (store) => store.previewLayoutByThreadId[threadId];
}

export function selectThreadComputerPreviewFloating(
  threadId: ThreadId,
): (store: ComputerPreviewStore) => ComputerPreviewFloatingPosition | undefined {
  return (store) => store.floatingByThreadId[threadId];
}
