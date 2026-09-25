// FILE: useSmoothStreamedText.test.ts
// Purpose: Pins the pure reveal stepper — velocity-driven drain plus quantized commits.
//          The hook itself is thin wiring (refs + rAF scheduling) around this function.

import { describe, expect, it } from "vitest";

import {
  createSmoothRevealState,
  MIN_EMIT_INTERVAL_MS,
  REVEAL_WORD_HOLD_CHARS,
  revealWordEnd,
  stepSmoothReveal,
  type SmoothRevealState,
} from "./useSmoothStreamedText";

const FRAME_MS = 8; // ~120Hz display

interface DrainRun {
  emits: { at: number; count: number }[];
  frames: number;
  state: SmoothRevealState;
}

/** Drive the stepper frame-by-frame until the backlog drains (or maxFrames). */
function drain(
  state: SmoothRevealState,
  targetText: string,
  startMs: number,
  maxFrames = 10_000,
  streaming = true,
): DrainRun {
  const emits: { at: number; count: number }[] = [];
  let emitted = Math.floor(state.shown);
  let now = startMs;
  let frames = 0;
  for (; frames < maxFrames; frames += 1) {
    const step = stepSmoothReveal(state, now, targetText, emitted, streaming);
    if (step.emitCount !== null) {
      emits.push({ at: now, count: step.emitCount });
      emitted = step.emitCount;
    }
    if (step.done) {
      break;
    }
    now += FRAME_MS;
  }
  return { emits, frames, state };
}

describe("stepSmoothReveal", () => {
  it("spaces commits at least MIN_EMIT_INTERVAL_MS apart while draining", () => {
    const run = drain(createSmoothRevealState(0), "x".repeat(400), 1_000);

    expect(run.emits.length).toBeGreaterThan(1);
    for (let index = 1; index < run.emits.length - 1; index += 1) {
      expect(run.emits[index]!.at - run.emits[index - 1]!.at).toBeGreaterThanOrEqual(
        MIN_EMIT_INTERVAL_MS,
      );
    }
    // Quantization is the point: far fewer commits than frames.
    expect(run.emits.length).toBeLessThan(run.frames / 3);
  });

  it("reveals every character: the final commit is the full target length", () => {
    const run = drain(createSmoothRevealState(0), "x".repeat(137), 500);

    expect(run.emits.at(-1)?.count).toBe(137);
    expect(run.state.shown).toBe(137);
  });

  it("emits the catch-up commit even when the interval has not elapsed", () => {
    // Mid-burst, one frame from catching up, with a commit only 4ms ago: the
    // final characters must not be held hostage to the quantization gate.
    const state: SmoothRevealState = {
      shown: 101.5,
      velocity: 500,
      lastFrameAt: 992,
      lastEmitAt: 996,
    };
    const step = stepSmoothReveal(state, 1_000, "x".repeat(103), 101, true);

    expect(step.emitCount).toBe(103);
    expect(step.done).toBe(true);
  });

  it("clamps the frame delta after a background-tab resume", () => {
    const state = createSmoothRevealState(0);
    // Prime one frame so velocity builds, then jump far ahead as if rAF was paused.
    stepSmoothReveal(state, 1_000, "x".repeat(500), 0, true);
    stepSmoothReveal(state, 1_008, "x".repeat(500), 0, true);
    const shownBefore = state.shown;
    const velocityBefore = state.velocity;
    stepSmoothReveal(state, 61_000, "x".repeat(500), Math.floor(shownBefore), true);

    // At most MAX_FRAME_SECONDS (0.05s) of reveal, not 60s of backlog dump.
    expect(state.shown - shownBefore).toBeLessThanOrEqual(
      Math.max(state.velocity, velocityBefore) * 0.05 + 1,
    );
    expect(state.shown).toBeLessThan(500);
  });

  it("clamps and sleeps when the target shrank below the revealed count", () => {
    const state = createSmoothRevealState(200);
    const step = stepSmoothReveal(state, 1_000, "x".repeat(50), 200, true);

    expect(state.shown).toBe(50);
    expect(step.done).toBe(true);
    expect(step.emitCount).toBeNull();
  });

  it("reports done and resets burst tracking once caught up", () => {
    const run = drain(createSmoothRevealState(0), "x".repeat(60), 2_000);

    expect(run.state.velocity).toBe(0);
    expect(run.state.lastFrameAt).toBe(0);
    // A later burst starting fresh emits its first advanced frame promptly.
    const next = drain(run.state, "x".repeat(120), 2_000 + run.frames * FRAME_MS + 100);
    expect(next.emits.length).toBeGreaterThan(0);
  });

  it("drains a large paste at the bounded ceiling instead of snapping", () => {
    const run = drain(createSmoothRevealState(0), "x".repeat(10_000), 0);

    // 10k chars at the 2000 chars/sec ceiling needs ≥5s of frames.
    expect(run.frames * FRAME_MS).toBeGreaterThanOrEqual(5_000);
    expect(run.emits.at(-1)?.count).toBe(10_000);
  });

  it("emits only whole-word boundaries while streaming", () => {
    const target = "Hello brave new world of words";
    const run = drain(createSmoothRevealState(0), target, 0);

    expect(run.emits.length).toBeGreaterThan(1);
    for (const emit of run.emits) {
      // Every committed prefix ends at a word boundary — either just before a
      // space (forward scan) or just after one (trailing-word hold) — never
      // mid-word.
      expect(target[emit.count] === " " || target[emit.count - 1] === " ").toBe(true);
    }
    // The trailing word "words" is held back: the final emit stops just past
    // the last boundary and the hook-side hold timer releases the tail
    // (browser test).
    expect(run.emits.at(-1)?.count).toBe(target.lastIndexOf(" ") + 1);
    expect(run.state.shown).toBe(target.length);
    expect(run.emits.at(-1)?.count).toBeLessThan(target.length);
  });

  it("dribbles raw offsets when a whitespaceless blob outgrows the hold window", () => {
    // A blob with no spaces at all would otherwise emit nothing: past
    // REVEAL_WORD_HOLD_CHARS held-back characters the raw floored count emits.
    const target = "x".repeat(REVEAL_WORD_HOLD_CHARS + 100);
    const run = drain(createSmoothRevealState(0), target, 0);

    expect(run.emits.length).toBeGreaterThan(0);
    expect(run.emits.at(-1)?.count).toBe(target.length);
  });

  it("runs a finished text out to its full length regardless of boundaries", () => {
    const target = "Hello brave new world";
    const run = drain(createSmoothRevealState(0), target, 0, 10_000, false);

    expect(run.emits.at(-1)?.count).toBe(target.length);
  });
});

describe("revealWordEnd", () => {
  it("ends at the end of the word the position falls in", () => {
    expect(revealWordEnd("Hello world", 2, true)).toBe(5);
    expect(revealWordEnd("Hello world", 5, true)).toBe(5);
  });

  it("holds a partial trailing word back to the last boundary while streaming", () => {
    expect(revealWordEnd("Hello wor", 9, true)).toBe(6);
    expect(revealWordEnd("Hello brave wor", 15, true)).toBe(12);
  });

  it("runs out to the full length when not streaming", () => {
    expect(revealWordEnd("Hello wor", 6, false)).toBe(9);
  });

  it("never emits mid-word for a markdown token", () => {
    // The emit boundary is the end of the word containing the position: "**bol"
    // can never leak as literal asterisks — the emit waits for "**bold**".
    expect(revealWordEnd("**bold** tail", 5, true)).toBe(8);
    expect(revealWordEnd("**bold** tail", 12, true)).toBe(9);
  });
});
