// the transport coalesces deltas into ~100ms clumps; this drains them on rAF at a smoothed adaptive velocity — React commits are quantized to MIN_EMIT_INTERVAL_MS since one setState per frame is the dominant CPU cost of a streaming turn and a ~25/s multi-char reveal is visually equivalent

import { useEffect, useRef, useState } from "react";
import { useMediaQuery } from "./useMediaQuery";

// drain window kept above the ~100ms network flush so a cushion remains and the reveal tracks inflow without running dry
const DRAIN_WINDOW_SECONDS = 0.16;
// hard ceiling so a huge flush reveals fast but bounded rather than snapping in
const MAX_CHARS_PER_SECOND = 2000;
// low-pass factor: ~0.15 ≈ a ~110ms time constant at 60fps
const VELOCITY_LERP = 0.15;
// per-frame clamp so returning from a backgrounded tab (rAF paused) doesn't dump the whole backlog in one frame
const MAX_FRAME_SECONDS = 0.05;
// the reveal float advances every frame; this only batches how often the grown prefix is pushed to state
export const MIN_EMIT_INTERVAL_MS = 40;

/**
 * Mutable per-message reveal state. Owned by the hook via refs; the pure stepper below
 * mutates it in place so the rAF loop allocates nothing per frame.
 */
export interface SmoothRevealState {
  shown: number;
  velocity: number;
  lastFrameAt: number;
  lastEmitAt: number;
}

export function createSmoothRevealState(shown: number): SmoothRevealState {
  return { shown, velocity: 0, lastFrameAt: 0, lastEmitAt: 0 };
}

export interface SmoothRevealStep {
  emitCount: number | null;
  done: boolean;
}

/**
 * Advance the reveal by one animation frame. Mutates `state` in place and reports
 * whether this frame should commit a longer prefix and whether the loop can sleep.
 *
 * Emission is quantized: a commit is due only when the floored count advanced AND
 * either MIN_EMIT_INTERVAL_MS elapsed since the last commit, the reveal just caught
 * up with the target (never hold back the final characters of a burst), or no commit
 * has happened yet in this burst.
 */
export function stepSmoothReveal(
  state: SmoothRevealState,
  nowMs: number,
  targetLength: number,
  emittedCount: number,
): SmoothRevealStep {
  const previousFrameAt = state.lastFrameAt;
  const dt = previousFrameAt ? Math.min((nowMs - previousFrameAt) / 1000, MAX_FRAME_SECONDS) : 0;
  state.lastFrameAt = nowMs;

  if (state.shown > targetLength) state.shown = targetLength;

  const backlog = targetLength - state.shown;
  if (backlog <= 0) {
    state.velocity = 0;
    state.lastFrameAt = 0;
    return { emitCount: null, done: true };
  }

  const targetVelocity = Math.min(MAX_CHARS_PER_SECOND, backlog / DRAIN_WINDOW_SECONDS);
  state.velocity += (targetVelocity - state.velocity) * VELOCITY_LERP;
  state.shown = Math.min(targetLength, state.shown + state.velocity * dt);
  // at high refresh rates the damped tail can approach the target without reaching it — settle a remainder below 1/1000 char so rAF doesn't run indefinitely
  if (targetLength - state.shown < 0.001) {
    state.shown = targetLength;
  }

  const nextCount = Math.floor(state.shown);
  const caughtUp = nextCount >= targetLength;
  const emitDue =
    nextCount !== emittedCount &&
    (caughtUp || state.lastEmitAt === 0 || nowMs - state.lastEmitAt >= MIN_EMIT_INTERVAL_MS);
  if (emitDue) {
    state.lastEmitAt = nowMs;
  }

  const done = targetLength - state.shown <= 0;
  if (done) {
    state.velocity = 0;
    state.lastFrameAt = 0;
  }
  return { emitCount: emitDue ? nextCount : null, done };
}

/**
 * Smoothly reveal `text` while `isStreaming` is true.
 *
 * - Returns `text` unchanged when not streaming or under prefers-reduced-motion, so
 *   completed messages and reduced-motion users see the exact text with zero animation.
 * - Snaps to the full text the instant streaming ends (no trailing typewriter once the
 *   agent is done).
 * - Text already present on mount is shown immediately; only newly-arriving deltas animate.
 */
export function useSmoothStreamedText(text: string, isStreaming: boolean): string {
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  // Testable env (jsdom/vitest) has no rAF or has mocked timers – smooth reveal would jank and never settle. Fall back to immediate text so streaming tests stay deterministic and the main thread isn't blocked by rAF loops.
  const isTestableEnv =
    typeof window === "undefined" ||
    typeof (window as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame !==
      "function" ||
    (typeof process !== "undefined" &&
      (process.env.VITEST === "true" || process.env.NODE_ENV === "test"));
  const animate = isStreaming && !reduceMotion && !isTestableEnv;

  const [revealed, setRevealed] = useState(text);

  // latest text mirrored post-commit so the rAF loop reads current without re-subscribing the effect on every delta
  const targetRef = useRef(text);
  const stateRef = useRef<SmoothRevealState>(createSmoothRevealState(text.length));
  const emittedRef = useRef(text.length);
  const rafRef = useRef<number | null>(null);
  const tickRef = useRef<(now: number) => void>(() => undefined);

  const cancelFrame = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const scheduleFrame = () => {
    if (rafRef.current != null) {
      return;
    }
    rafRef.current = requestAnimationFrame((now) => {
      rafRef.current = null;
      tickRef.current(now);
    });
  };

  // installed in an effect (a render-time write would kill Compiler eligibility); the tick reads refs so a mount-time install stays fresh
  useEffect(() => {
    tickRef.current = (now: number) => {
      const target = targetRef.current;
      const step = stepSmoothReveal(stateRef.current, now, target.length, emittedRef.current);
      if (step.emitCount !== null) {
        emittedRef.current = step.emitCount;
        setRevealed(step.emitCount >= target.length ? target : target.slice(0, step.emitCount));
      }
      if (!step.done) {
        scheduleFrame();
      }
      // When done, the loop sleeps; the text-update effect wakes it on the next flush.
    };
  }, [scheduleFrame]);

  useEffect(() => {
    const previousTarget = targetRef.current;
    const isAppendOnly = text.length >= previousTarget.length && text.startsWith(previousTarget);
    targetRef.current = text;

    if (!animate || !isAppendOnly) {
      cancelFrame();
      stateRef.current = createSmoothRevealState(text.length);
      emittedRef.current = text.length;
      setRevealed(text);
      return;
    }

    if (text.length > stateRef.current.shown) {
      scheduleFrame();
    }
  }, [animate, cancelFrame, scheduleFrame, text]);

  useEffect(() => () => cancelFrame(), [cancelFrame]);

  return animate ? revealed : text;
}
