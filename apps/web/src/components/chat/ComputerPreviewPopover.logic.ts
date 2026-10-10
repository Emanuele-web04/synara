// FILE: ComputerPreviewPopover.logic.ts
// Purpose: Phase machine for the in-chat computer preview popover.
// Layer: Web chat surface logic
// Exports: ComputerPreviewSession phases, transitions, and labels
// Depends on: contracts types only (pure)
//
// The popover is the ambient computer surface: it appears inside the chat of
// the thread whose agent is driving the desktop. Phases, not booleans:
//
//   armed           a surface request or a drive turn started; the owning
//                   thread may not be on screen yet.
//   live            armed and now being rendered by the viewed thread's chat
//                   surface (the only place the popover may draw).
//   hidden-for-task the user closed it; it stays closed until the task ends
//                   and re-arms on the next turn or lease.
//   ended           the drive turn ended (lease released, agent idle).
//
// Per-thread memory arms a session on the owning thread whether or not it is
// visible, so background agent work never steals the chat the user is reading.

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

/** Viewport clearance kept around a detached floating card on every edge. */
export const COMPUTER_PREVIEW_FLOAT_MARGIN_PX = 8;

/**
 * Clamp a detached card's top-left so the whole card stays on screen. When
 * the card is wider or taller than the viewport itself the margin still
 * applies on the origin edge, so the card can never start off-screen.
 */
export function clampComputerPreviewFloat(input: {
  readonly x: number;
  readonly y: number;
  readonly cardWidthPx: number;
  readonly cardHeightPx: number;
  readonly viewportWidthPx: number;
  readonly viewportHeightPx: number;
}): { readonly x: number; readonly y: number } {
  const margin = COMPUTER_PREVIEW_FLOAT_MARGIN_PX;
  const maxX = Math.max(margin, input.viewportWidthPx - input.cardWidthPx - margin);
  const maxY = Math.max(margin, input.viewportHeightPx - input.cardHeightPx - margin);
  return {
    x: Math.min(Math.max(input.x, margin), maxX),
    y: Math.min(Math.max(input.y, margin), maxY),
  };
}

/**
 * How much bigger a detached card is than the docked one. The pop-out control
 * is drawn with expand arrows, and the rail card already sits at its footprint
 * cap on any normal window: at 1:1 the detached card re-rendered at the exact
 * same rect, so the control read as dead.
 */
export const COMPUTER_PREVIEW_FLOAT_EXPAND_SCALE = 1.5;

/**
 * Width a detached card takes. Leaving the rail is the expansion: the card
 * grows past the footprint cap that bounds it while docked, and the viewport
 * is its only remaining bound — on both axes, so a tall portrait window
 * shrinks the card back instead of hanging off the bottom of the screen.
 */
export function computerPreviewFloatWidthPx(input: {
  readonly caps: ComputerPreviewCardCaps;
  readonly viewportWidthPx: number;
  readonly viewportHeightPx: number;
  readonly frameAspect: number;
}): number {
  const margins = COMPUTER_PREVIEW_FLOAT_MARGIN_PX * 2;
  return Math.max(
    input.caps.minWidthPx,
    Math.min(
      input.caps.maxWidthPx * COMPUTER_PREVIEW_FLOAT_EXPAND_SCALE,
      input.viewportWidthPx - margins,
      (input.viewportHeightPx - margins) * input.frameAspect,
    ),
  );
}

const SLOT_MARGIN_X_PX = 32;
const SLOT_TOP_PX = 16;
const SLOT_BOTTOM_RESERVE_PX = 120;

/**
 * Rendered card width. Detached cards ignore the rail slot entirely — their
 * bound is the viewport, at the larger detached footprint. Docked cards fill
 * the slot's width and height budget at the content aspect, clamped to sane
 * bounds: a tall phone-shaped window narrows the card instead of growing past
 * the chat; a wide desktop caps at the max. The docked width basis is the rail
 * budget when provided:
 * the rail wrapper shrink-fits the card, so measuring it would feed the card
 * its own width back and pin it small forever.
 */
export function computerPreviewCardFitWidth(input: {
  readonly floating: boolean;
  readonly caps: ComputerPreviewCardCaps;
  /** Host-supplied rail budget (the maxWidthPx prop); overrides slot measure. */
  readonly railBudgetPx: number | undefined;
  /** Measured slot; callers pass fallbacks before the first observation. */
  readonly slotWidthPx: number;
  readonly slotHeightPx: number;
  readonly frameAspect: number;
  readonly viewportWidthPx: number;
  readonly viewportHeightPx: number;
}): number {
  if (input.floating) {
    return computerPreviewFloatWidthPx({
      caps: input.caps,
      viewportWidthPx: input.viewportWidthPx,
      viewportHeightPx: input.viewportHeightPx,
      frameAspect: input.frameAspect,
    });
  }
  const widthBasis = input.railBudgetPx ?? input.slotWidthPx - SLOT_MARGIN_X_PX;
  const cardMaxWidth = Math.min(input.railBudgetPx ?? input.caps.maxWidthPx, input.caps.maxWidthPx);
  return Math.max(
    input.caps.minWidthPx,
    Math.min(
      cardMaxWidth,
      widthBasis,
      (input.slotHeightPx - SLOT_TOP_PX - SLOT_BOTTOM_RESERVE_PX) * input.frameAspect,
    ),
  );
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
  readonly inputStopped?: boolean;
  readonly currentActivity: string | null;
  readonly lastActionLabel: string | null;
}): string | null {
  // The Escape kill outranks "live": frames may still arrive, but nothing the
  // chip could say about activity is true while input admission is closed.
  if (input.inputStopped === true) return "Stopped via Escape";
  if (input.agentActive) return input.currentActivity ?? input.lastActionLabel ?? "Live";
  return input.lastActionLabel;
}

/** The frame source currently allowed to draw the preview canvas. */
export type ComputerPreviewFrameSource = "tap" | "stills" | "none";

/**
 * Which source draws the canvas while the preview wants frames. The desktop
 * app's native tap wins whenever it decoded a frame recently ("tap"). The
 * stills WebSocket is the server's window/tab-scoped fallback: it draws until
 * the tap has a frame, and the server publishes nothing when no window or tab
 * is the target — a desktop-wide still is never a pane frame. When the tap
 * already painted a window frame and just went quiet, neither source draws
 * ("none") so the canvas keeps showing that frame. "none" also means the
 * preview should not draw at all, so both sources stay off and never write the
 * canvas simultaneously.
 */
export function computerPreviewFrameSource(input: {
  readonly streamWanted: boolean;
  readonly tapActive: boolean;
  readonly tapHasFrame?: boolean | undefined;
}): ComputerPreviewFrameSource {
  if (!input.streamWanted) return "none";
  if (input.tapActive) return "tap";
  if (input.tapHasFrame === true) return "none";
  return "stills";
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
