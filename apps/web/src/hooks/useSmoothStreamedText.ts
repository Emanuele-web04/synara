// FILE: useSmoothStreamedText.ts
// Purpose: Reveal streamed assistant text at a steady, adaptive cadence so tokens appear
//          fluidly instead of in the ~100ms network clumps that land in the store.
// Layer: Web UI streaming primitive
// Exports: useSmoothStreamedText, stepSmoothReveal (pure stepper, unit-tested)
// Why: The transport coalesces deltas into one store update per ~100ms
//      (apps/web/src/routes/__root.tsx Throttler), so rendering each clump verbatim looks
//      choppy. This hook drains the already-delivered buffer on requestAnimationFrame at a
//      velocity that adapts to the backlog, low-pass-smooths that velocity so there are
//      no jarring speed jumps, and sleeps between bursts once it catches up. It feeds the
//      same text ChatMarkdown already defers, so the markdown re-parse stays coalesced by
//      useDeferredValue: this hook governs *cadence*, not parse cost.
//      The reveal position advances every frame, but React commits are quantized to
//      MIN_EMIT_INTERVAL_MS: one setState per frame (~120/s on a 120Hz display, each
//      re-rendering the growing message) is the dominant CPU cost of a streaming turn,
//      while a ~25/s multi-character reveal is visually equivalent.

import { useCallback, useEffect, useRef, useState } from "react";
import { useMediaQuery } from "./useMediaQuery";

// Drain the current backlog over this window. Kept above the ~100ms network flush so a
// small backlog cushion always remains and the reveal tracks inflow without running dry.
const DRAIN_WINDOW_SECONDS = 0.16;
// Hard ceiling so a single huge flush (e.g. a pasted code block) reveals fast but bounded
// rather than snapping in all at once.
const MAX_CHARS_PER_SECOND = 2000;
// Low-pass factor: how aggressively the live velocity chases the target velocity each
// frame. Smaller is smoother but laggier; ~0.15 ≈ a ~110ms time constant at 60fps.
const VELOCITY_LERP = 0.15;
// Clamp per-frame delta so returning from a backgrounded tab (rAF paused) does not dump
// the whole backlog in a single frame.
const MAX_FRAME_SECONDS = 0.05;
// Minimum spacing between React commits. The reveal float still advances every frame at
// the smoothed velocity; this only batches how often the grown prefix is pushed to state.
export const MIN_EMIT_INTERVAL_MS = 40;
// Commit spacing while the transcript tail is not being followed. The paced
// reveal still matters then — snapping to full text would jerk a detached
// reader's anchor — but each commit costs the virtualized list a
// measure/compensate pass, so off-screen growth lands at a coarse cadence.
export const DETACHED_EMIT_INTERVAL_MS = 250;
// Cap on how far a pending word boundary may sit behind the reveal position.
// A whitespaceless blob (minified line, giant URL) would otherwise emit nothing
// for its entire drain — past this many held-back characters the reveal
// dribbles raw offsets instead of stalling.
export const REVEAL_WORD_HOLD_CHARS = 80;
// Once the reveal catches up while streaming, a still-growing trailing word is
// held back this long; past it the stream has stalled mid-word, so the honest
// partial text shows. Sized ~3x the ~100ms transport flush cadence.
export const REVEAL_WORD_HOLD_MS = 300;
// Duration of one streamed word's opacity fade; also the linger window after
// the last stream activity so the final word's fade finishes.
export const STREAM_WORD_FADE_MS = 300;

function isSpace(code: number): boolean {
  return code === 32 || code === 10 || code === 9 || code === 13;
}

/**
 * Where to stop emitting `text` for a reveal position of `at`: the end of the
 * word `at` falls in, so a word is never shown half-written and a markdown
 * token like `**bold**` arrives atomically instead of flashing literal syntax.
 * While `streaming`, a text still mid-word trims back to the last whole word;
 * a finished text runs out to its full length.
 */
export function revealWordEnd(text: string, at: number, streaming: boolean): number {
  for (let i = Math.max(0, Math.ceil(at)); i < text.length; i++) {
    if (isSpace(text.charCodeAt(i))) return i;
  }
  if (!streaming) return text.length;
  let end = text.length;
  while (end > 0 && !isSpace(text.charCodeAt(end - 1))) end--;
  return end;
}

/**
 * Mutable per-message reveal state. Owned by the hook via refs; the pure stepper below
 * mutates it in place so the rAF loop allocates nothing per frame.
 */
export interface SmoothRevealState {
  /** Revealed character count, accumulated as a float across frames. */
  shown: number;
  /** Smoothed reveal velocity in chars/second. */
  velocity: number;
  /** Timestamp (ms) of the previous frame; 0 marks the start of a fresh burst. */
  lastFrameAt: number;
  /** Timestamp (ms) of the last emitted commit; 0 forces the next emit immediately. */
  lastEmitAt: number;
}

export function createSmoothRevealState(shown: number): SmoothRevealState {
  return { shown, velocity: 0, lastFrameAt: 0, lastEmitAt: 0 };
}

export interface SmoothRevealStep {
  /** Floored character count to commit this frame, or null when no commit is due. */
  emitCount: number | null;
  /** True when the backlog is drained and the loop should sleep until the next flush. */
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
  targetText: string,
  emittedCount: number,
  streaming: boolean,
  minEmitIntervalMs: number = MIN_EMIT_INTERVAL_MS,
): SmoothRevealStep {
  const targetLength = targetText.length;
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
  // At high refresh rates the damped tail can approach the target without ever
  // reaching it, leaving the last character hidden and rAF running indefinitely.
  // Settle a remainder below 1/1000 character; preserve the reveal cadence.
  if (targetLength - state.shown < 0.001) {
    state.shown = targetLength;
  }

  const nextCount = Math.floor(state.shown);
  // Emit on whole-word boundaries so a partial word (and partial markdown
  // syntax) never reaches the DOM. A boundary further than
  // REVEAL_WORD_HOLD_CHARS behind the reveal is a whitespaceless blob — emit
  // the raw floored count rather than holding the whole blob.
  const wordEnd = revealWordEnd(targetText, nextCount, streaming);
  const emitCount = nextCount - wordEnd > REVEAL_WORD_HOLD_CHARS ? nextCount : wordEnd;
  const emitDue =
    emitCount > emittedCount &&
    (emitCount >= targetLength ||
      state.lastEmitAt === 0 ||
      nowMs - state.lastEmitAt >= minEmitIntervalMs);
  if (emitDue) {
    state.lastEmitAt = nowMs;
  }

  const done = targetLength - state.shown <= 0;
  if (done) {
    state.velocity = 0;
    state.lastFrameAt = 0;
  }
  return { emitCount: emitDue ? emitCount : null, done };
}

/**
 * Smoothly reveal `text` while `isStreaming` is true.
 *
 * - Returns `text` unchanged when not streaming or under prefers-reduced-motion, so
 *   completed messages and reduced-motion users see the exact text with zero animation.
 * - Snaps to the full text the instant streaming ends (no trailing typewriter once the
 *   agent is done).
 * - Text already present on mount is shown immediately; only newly-arriving deltas animate.
 * - `liveTail` false marks the transcript as detached from the tail: the reveal
 *   keeps pacing (no snap) but React commits thin out to DETACHED_EMIT_INTERVAL_MS
 *   since an off-screen row does not need per-frame growth.
 */
export function useSmoothStreamedText(
  text: string,
  isStreaming: boolean,
  liveTail: boolean = true,
): string {
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  // Testable env (jsdom/vitest) has no rAF or has mocked timers – smooth reveal would
  // jank and never settle. Fall back to immediate text so streaming tests stay
  // deterministic and the main thread isn't blocked by rAF loops.
  const isTestableEnv =
    typeof window === "undefined" ||
    typeof (window as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame !==
      "function" ||
    (typeof process !== "undefined" &&
      (process.env.VITEST === "true" || process.env.NODE_ENV === "test"));
  const animate = isStreaming && !reduceMotion && !isTestableEnv;

  const [revealed, setRevealed] = useState(text);

  // Latest full text, mirrored post-commit so the rAF loop always reads the current value
  // without re-subscribing the animation effect on every ~100ms delta.
  const targetRef = useRef(text);
  const stateRef = useRef<SmoothRevealState>(createSmoothRevealState(text.length));
  // Character count last pushed to React state — guards against redundant setState when the
  // floored count has not advanced.
  const emittedRef = useRef(text.length);
  const rafRef = useRef<number | null>(null);
  const tickRef = useRef<(now: number) => void>(() => undefined);
  // Commit spacing for the rAF loop — ref so a follow/detach flip mid-burst
  // changes the next emit without resubscribing the animation effect.
  const emitIntervalRef = useRef(MIN_EMIT_INTERVAL_MS);
  useEffect(() => {
    emitIntervalRef.current = liveTail ? MIN_EMIT_INTERVAL_MS : DETACHED_EMIT_INTERVAL_MS;
  }, [liveTail]);
  // One-shot stall release: when the reveal catches up but is holding back a
  // still-growing trailing word, this emits the full arrived text after
  // REVEAL_WORD_HOLD_MS so a genuine pause shows the partial word honestly.
  const holdTimerRef = useRef<number | null>(null);
  const clearHold = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const cancelFrame = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const scheduleFrame = useCallback(() => {
    if (rafRef.current != null) {
      return;
    }
    rafRef.current = requestAnimationFrame((now) => {
      rafRef.current = null;
      tickRef.current(now);
    });
  }, []);

  // Installed in an effect (not during render — that write would make the
  // whole hook ineligible for React Compiler). The tick reads everything
  // through refs, so a mount-time install stays permanently fresh.
  useEffect(() => {
    tickRef.current = (now: number) => {
      const target = targetRef.current;
      const step = stepSmoothReveal(
        stateRef.current,
        now,
        target,
        emittedRef.current,
        /* streaming */ true,
        emitIntervalRef.current,
      );
      if (step.emitCount !== null) {
        clearHold();
        emittedRef.current = step.emitCount;
        setRevealed(step.emitCount >= target.length ? target : target.slice(0, step.emitCount));
      }
      if (!step.done) {
        scheduleFrame();
      } else if (emittedRef.current < target.length && holdTimerRef.current === null) {
        // Caught up mid-word: hold the partial word briefly; if the stream has
        // really stalled on it, release everything that has arrived.
        holdTimerRef.current = window.setTimeout(() => {
          holdTimerRef.current = null;
          const latest = targetRef.current;
          emittedRef.current = latest.length;
          setRevealed(latest);
        }, REVEAL_WORD_HOLD_MS);
      }
      // When done, the loop sleeps; the text-update effect wakes it on the next flush.
    };
  }, [clearHold, scheduleFrame]);

  useEffect(() => {
    const previousTarget = targetRef.current;
    const isAppendOnly = text.length >= previousTarget.length && text.startsWith(previousTarget);
    targetRef.current = text;
    // New arrivals are fresh stream activity — any armed stall release belongs
    // to the previous target and would snap ahead of the paced reveal.
    clearHold();

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
  }, [animate, cancelFrame, clearHold, scheduleFrame, text]);

  useEffect(
    () => () => {
      cancelFrame();
      clearHold();
    },
    [cancelFrame, clearHold],
  );

  return animate ? revealed : text;
}

/**
 * Whether a streamed message's words may still fade: true while `active` (the
 * stream is live or a paced reveal is still behind the wire) and for one
 * STREAM_WORD_FADE_MS linger after, so the last let-out words finish fading.
 * Once off it stays off — a finished reply folded away and reopened must not
 * replay the fade.
 */
export function useStreamingFadeLinger(active: boolean): boolean {
  const [lingering, setLingering] = useState(false);

  useEffect(() => {
    if (active) {
      setLingering(true);
      return;
    }
    if (!lingering) return;
    const timer = window.setTimeout(() => setLingering(false), STREAM_WORD_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [active, lingering]);

  return active || lingering;
}
