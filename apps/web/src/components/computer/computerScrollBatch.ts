// FILE: computerScrollBatch.ts
// Purpose: Coalesce a burst of wheel events into one desktop scroll RPC.
// Layer: web UI utility
// Exports: createComputerScrollBatch, COMPUTER_SCROLL_FLUSH_MS
//
// Wheel events arrive far faster than a seat can inject them — a trackpad
// flick is dozens of them — so they are summed and sent once per window. The
// batch lives here rather than inside the pane's wheel effect because it has
// to outlive that effect: the effect re-subscribes whenever the desktop pushes
// a new frame size, and a burst that is still accumulating must survive that
// rather than being dropped with the old timer.

import { clampComputerScrollDelta } from "../ComputerPanel.logic";

/**
 * Long enough to coalesce a trackpad flick, short enough that scrolling still
 * tracks the hand.
 */
export const COMPUTER_SCROLL_FLUSH_MS = 50;

export interface ComputerScrollTarget {
  readonly x: number;
  readonly y: number;
}

export interface ComputerScrollDelta {
  readonly deltaX: number;
  readonly deltaY: number;
}

export interface ComputerScrollSend {
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
}

export interface ComputerScrollBatch {
  /**
   * Adds one wheel event to the open burst, starting the window if there is
   * none. The newest pointer position wins: a burst is one gesture, and it is
   * where the hand ended up that the desktop should scroll under.
   */
  readonly add: (
    point: ComputerScrollTarget,
    delta: ComputerScrollDelta,
    send: (input: ComputerScrollSend) => void,
  ) => void;
  /** Sends the open burst now. Re-entrant calls from `send` are a no-op. */
  readonly flush: () => void;
  /** Forgets the open burst without sending it. */
  readonly clear: () => void;
}

export function createComputerScrollBatch(flushMs = COMPUTER_SCROLL_FLUSH_MS): ComputerScrollBatch {
  let pending:
    | (ComputerScrollSend & { readonly send: (input: ComputerScrollSend) => void })
    | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const flush = () => {
    stopTimer();
    const batch = pending;
    pending = null;
    if (!batch) return;
    // Clamped once over the whole burst, not per event: the contract's limit is
    // what one injected scroll may move, and a coalesced flick would otherwise
    // pass a sum far outside it.
    const deltaX = clampComputerScrollDelta(batch.deltaX);
    const deltaY = clampComputerScrollDelta(batch.deltaY);
    if (deltaX === 0 && deltaY === 0) return;
    batch.send({ x: batch.x, y: batch.y, deltaX, deltaY });
  };

  return {
    add: (point, delta, send) => {
      pending = {
        x: point.x,
        y: point.y,
        deltaX: (pending?.deltaX ?? 0) + delta.deltaX,
        deltaY: (pending?.deltaY ?? 0) + delta.deltaY,
        send,
      };
      timer ??= setTimeout(flush, flushMs);
    },
    flush,
    clear: () => {
      stopTimer();
      pending = null;
    },
  };
}
