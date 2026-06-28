// FILE: useSmoothStreamedText.ts
// Purpose: Reveal streamed assistant text at a steady, adaptive cadence so tokens appear
//          fluidly instead of in the ~100ms network clumps that land in the store.
// Layer: Web UI streaming primitive
// Exports: useSmoothStreamedText
// Why: The transport coalesces deltas into one store update per ~100ms
//      (apps/web/src/routes/__root.tsx Throttler), so rendering each clump verbatim looks
//      choppy. This hook drains the already-delivered buffer on requestAnimationFrame at a
//      velocity that adapts to the backlog — always keeping a small cushion so it never
//      runs dry (an emptied buffer is what produces visible stalls) — and low-pass-smooths
//      that velocity so there are no jarring speed jumps. It feeds the same text
//      ChatMarkdown already defers, so the markdown re-parse stays coalesced by
//      useDeferredValue: this hook governs *cadence*, not parse cost.

import { useEffect, useRef, useState } from "react";
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
  const animate = isStreaming && !reduceMotion;

  const [revealed, setRevealed] = useState(text);

  // Latest full text, mirrored post-commit so the rAF loop always reads the current value
  // without re-subscribing the animation effect on every ~100ms delta.
  const targetRef = useRef(text);
  // Revealed character count, accumulated as a float across frames.
  const shownRef = useRef(text.length);
  // Character count last pushed to React state — guards against redundant setState when the
  // floored count has not advanced.
  const emittedRef = useRef(text.length);
  const velocityRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);

  useEffect(() => {
    targetRef.current = text;
  }, [text]);

  useEffect(() => {
    if (!animate) {
      // Idle / finished / reduced-motion: cancel any loop and snap to the exact text.
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const full = targetRef.current;
      shownRef.current = full.length;
      emittedRef.current = full.length;
      velocityRef.current = 0;
      lastFrameRef.current = 0;
      setRevealed(full);
      return;
    }

    // Entering the animating state: never re-reveal text already on screen.
    emittedRef.current = Math.floor(shownRef.current);

    const tick = (now: number) => {
      const previous = lastFrameRef.current;
      const dt = previous ? Math.min((now - previous) / 1000, MAX_FRAME_SECONDS) : 0;
      lastFrameRef.current = now;

      const target = targetRef.current;
      const len = target.length;
      // Text can be replaced by something shorter (edit / resend); never reveal past it.
      if (shownRef.current > len) shownRef.current = len;

      const backlog = len - shownRef.current;
      if (backlog > 0) {
        const targetVelocity = Math.min(MAX_CHARS_PER_SECOND, backlog / DRAIN_WINDOW_SECONDS);
        velocityRef.current += (targetVelocity - velocityRef.current) * VELOCITY_LERP;
        shownRef.current = Math.min(len, shownRef.current + velocityRef.current * dt);
      } else {
        velocityRef.current = 0;
      }

      const nextCount = Math.floor(shownRef.current);
      if (nextCount !== emittedRef.current) {
        emittedRef.current = nextCount;
        setRevealed(nextCount >= len ? target : target.slice(0, nextCount));
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastFrameRef.current = 0;
    };
  }, [animate]);

  return animate ? revealed : text;
}
