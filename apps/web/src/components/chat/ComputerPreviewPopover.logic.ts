// FILE: ComputerPreviewPopover.logic.ts
// Purpose: Phase machine for the in-chat computer preview popover.
// Layer: Web chat surface logic
// Exports: ComputerPreviewSession phases, transitions, and labels
// Depends on: contracts types only (pure)
//
// The popover is the ambient computer surface: it appears inside the chat of
// the thread whose agent is driving the desktop, and the right-dock Computer
// pane stays the detailed surface opened on demand. Phases, not booleans:
//
//   armed           a surface request or a drive turn started; the owning
//                   thread may not be on screen yet.
//   live            armed and now being rendered by the viewed thread's chat
//                   surface (the only place the popover may draw).
//   hidden-for-task the user closed it; it stays closed until the task ends
//                   and re-arms on the next turn or lease.
//   ended           the drive turn ended (lease released, agent idle).
//
// Per-thread memory mirrors the pane rule: a session arms on the owning thread
// whether or not it is visible, so background agent work never steals the chat
// the user is reading.

import type { ThreadComputerState, ThreadId } from "@synara/contracts";

export type ComputerPreviewPhase = "armed" | "live" | "hidden-for-task" | "ended";

/** In-chat preview footprint. Compact is the default: small and glanceable. */
export type ComputerPreviewCardSize = "compact" | "large";

export interface ComputerPreviewCardCaps {
  readonly minWidthPx: number;
  readonly maxWidthPx: number;
}

/** Width bounds per footprint, shared by the card fit and the rail budget. */
export function computerPreviewCardCaps(size: ComputerPreviewCardSize): ComputerPreviewCardCaps {
  return size === "large"
    ? { minWidthPx: 240, maxWidthPx: 560 }
    : { minWidthPx: 240, maxWidthPx: 400 };
}

/**
 * Rail gutter budget: how wide the card may grow in this layout. Monotone in
 * the measured content width, so window resizes, sidebar toggles, split
 * leaves, and browser zoom (all of which change CSS layout and refire the
 * ResizeObservers feeding this) refit the card. Floors at 200px so a tiny
 * window still gets a usable card instead of collapsing it to zero.
 */
export function computerPreviewBudgetPx(input: {
  readonly mainContentWidthPx: number;
  readonly environmentInsetPx: number;
  readonly caps: ComputerPreviewCardCaps;
}): number {
  const available = input.mainContentWidthPx - input.environmentInsetPx - 520 - 24;
  return Math.max(200, Math.min(input.caps.maxWidthPx, available));
}

export interface ComputerPreviewSession {
  readonly threadId: ThreadId;
  readonly phase: ComputerPreviewPhase;
  readonly lastActionLabel?: string | undefined;
}

/**
 * Whether this thread is the one driving the desktop.
 *
 * Not the same question the pane's Stop asks: `controlOwnerThreadId` names the
 * lease holder on every thread's snapshot, so a bystander thread reports the
 * owner too. For the popover, only the owning thread is driving. `agentActive`
 * covers the in-flight call window before the lease shows up in the snapshot,
 * but a call refused because another thread owns the desktop
 * (`controlledByOtherThread`) is not driving.
 */
export function computerPreviewAgentActive(state: ThreadComputerState): boolean {
  return (
    state.controlOwnerThreadId === state.threadId ||
    (state.agentActive && !state.controlledByOtherThread)
  );
}

export type ComputerPreviewAgentEdge = "rose" | "fell";

/**
 * Phase after an agent-activity edge. A rising edge means a new drive turn:
 * it re-arms even a dismissed preview ("re-arms on the next turn"). A session
 * already on screen stays live rather than blinking closed and reopening. A
 * falling edge ends the task for every phase.
 */
export function computerPreviewPhaseOnAgentEdge(
  phase: ComputerPreviewPhase | undefined,
  edge: ComputerPreviewAgentEdge,
): ComputerPreviewPhase | undefined {
  if (edge === "fell") {
    return phase === undefined ? undefined : "ended";
  }
  return phase === "live" ? "live" : "armed";
}

/**
 * Phase after `computer.open-pane-requested`. The server emits it once per
 * desktop lease, so a request arriving while the preview is dismissed belongs
 * to a new task and re-arms it; a request for the live session is a no-op.
 */
export function computerPreviewPhaseOnSurfaceRequest(
  phase: ComputerPreviewPhase | undefined,
): ComputerPreviewPhase {
  if (phase === "live" || phase === "armed") return phase;
  return "armed";
}

/** Mounting is the visibility gate: an armed session goes live once rendered. */
export function computerPreviewPhaseOnViewed(
  phase: ComputerPreviewPhase | undefined,
): ComputerPreviewPhase | undefined {
  return phase === "armed" ? "live" : phase;
}

/** The close control hides for the rest of the task, from any visible phase. */
export function computerPreviewPhaseOnHide(
  phase: ComputerPreviewPhase | undefined,
): ComputerPreviewPhase | undefined {
  return phase === "armed" || phase === "live" ? "hidden-for-task" : phase;
}

/** Whether the card shows its open state; "armed" renders closed until viewed. */
export function computerPreviewCardOpen(phase: ComputerPreviewPhase | undefined): boolean {
  return phase === "live";
}

/**
 * The header's one-word status: what the agent is doing while it drives, a
 * plain "Live" before the first action label exists, or the last action after
 * the turn has ended.
 */
export function computerPreviewStatusLabel(input: {
  readonly agentActive: boolean;
  readonly lastActionLabel: string | null;
}): string | null {
  if (input.agentActive) return input.lastActionLabel ?? "Live";
  return input.lastActionLabel;
}

/** The frame source currently allowed to draw the preview canvas. */
export type ComputerPreviewFrameSource = "tap" | "stills" | "none";

/**
 * Which source draws the canvas while the preview wants frames. The desktop
 * app's native tap wins whenever it decoded a frame recently ("tap"); the
 * stills WebSocket covers every gap, including quiet taps and browsers where
 * the channel does not exist. "none" means the preview should not draw at
 * all, so both sources stay off and never write the canvas simultaneously.
 */
export function computerPreviewFrameSource(input: {
  readonly streamWanted: boolean;
  readonly tapActive: boolean;
}): ComputerPreviewFrameSource {
  if (!input.streamWanted) return "none";
  return input.tapActive ? "tap" : "stills";
}

/**
 * Thread states whose object identity changed between snapshots. The event
 * bridge diffs the store this way so seeded states (which bypass the push
 * handler) feed the same edge detection as pushed ones.
 */
export function changedThreadComputerStates(
  next: Record<string, ThreadComputerState | undefined>,
  previous: Record<string, ThreadComputerState | undefined>,
): ThreadComputerState[] {
  const changed: ThreadComputerState[] = [];
  for (const [threadId, state] of Object.entries(next)) {
    if (state !== undefined && state !== previous[threadId]) {
      changed.push(state);
    }
  }
  return changed;
}

/**
 * Thread ids whose state vanished between snapshots. A removed thread's
 * session must die with it — an armed preview for a dead thread would pop the
 * moment its chat surface mounted again, long after the task is gone.
 */
export function removedThreadComputerStateIds(
  next: Record<string, ThreadComputerState | undefined>,
  previous: Record<string, ThreadComputerState | undefined>,
): string[] {
  const removed: string[] = [];
  for (const threadId of Object.keys(previous)) {
    if (next[threadId] === undefined) {
      removed.push(threadId);
    }
  }
  return removed;
}
