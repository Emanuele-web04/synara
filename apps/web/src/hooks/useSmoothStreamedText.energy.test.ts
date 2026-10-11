import { describe, expect, it } from "vitest";

import { createSmoothRevealState, stepSmoothReveal } from "./useSmoothStreamedText";

describe("smooth reveal lifecycle", () => {
  it.each([30, 60, 144, 240, 1_000])("settles exactly and sleeps between bursts at %i Hz", (hz) => {
    const state = createSmoothRevealState(0);
    let emitted = 0;
    let done = false;
    let now = 1_000;
    for (let frame = 0; frame < hz * 3; frame += 1) {
      now += 1_000 / hz;
      const step = stepSmoothReveal(state, now, 100, emitted);
      if (step.emitCount !== null) {
        expect(step.emitCount).toBeGreaterThan(emitted);
        expect(step.emitCount).toBeLessThanOrEqual(100);
        emitted = step.emitCount;
      }
      if (step.done) {
        done = true;
        break;
      }
    }
    expect(done).toBe(true);
    expect(emitted).toBe(100);
    expect(state.shown).toBe(100);
    expect(state.velocity).toBe(0);
    expect(state.lastFrameAt).toBe(0);
    expect(stepSmoothReveal(state, now + 60_000, 100, emitted)).toEqual({
      emitCount: null,
      done: true,
    });
    // A sleeping loop must still wake for the next append-only burst.
    expect(stepSmoothReveal(state, now + 60_001, 200, emitted).done).toBe(false);
  });

  it("emits the final character despite a recent commit when the tail has stalled", () => {
    const state = {
      shown: 99.99999999999982,
      velocity: 0.000000000001,
      lastFrameAt: 1_000,
      lastEmitAt: 1_000,
    };
    expect(stepSmoothReveal(state, 1_004, 100, 99)).toEqual({
      emitCount: 100,
      done: true,
    });
    expect(state.shown).toBe(100);
  });

  it("does not snap a meaningful backlog", () => {
    const state = createSmoothRevealState(0);
    const step = stepSmoothReveal(state, 1_000, 100, 0);
    expect(step.done).toBe(false);
    expect(step.emitCount).toBeNull();
    expect(state.shown).toBe(0);
  });
});
