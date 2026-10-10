import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startVisibleInterval } from "./visibleInterval";

let visibility: DocumentVisibilityState;
let target: EventTarget;

function setVisibility(value: DocumentVisibilityState) {
  visibility = value;
  target.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-17T12:00:00Z"));
  visibility = "visible";
  target = new EventTarget();
  Object.defineProperty(target, "visibilityState", { get: () => visibility });
  vi.stubGlobal("document", target);
  vi.stubGlobal("window", globalThis);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("startVisibleInterval", () => {
  it("refreshes asynchronously and preserves the visible cadence", () => {
    const tick = vi.fn();
    const stop = startVisibleInterval(tick, 1_000);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(999);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not allocate timers when mounted hidden", () => {
    setVisibility("hidden");
    const tick = vi.fn();
    const stop = startVisibleInterval(tick, 1_000);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(300_000);
    expect(tick).not.toHaveBeenCalled();
    stop();
  });

  it("cancels both the pending initial refresh and interval on hide", () => {
    const tick = vi.fn();
    const stop = startVisibleInterval(tick, 1_000);
    setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(300_000);
    expect(tick).not.toHaveBeenCalled();
    stop();
  });

  it("reads current wall time once on resume without replaying missed ticks", () => {
    const tick = vi.fn(() => Date.now());
    const stop = startVisibleInterval(tick, 1_000);
    vi.advanceTimersByTime(0);
    setVisibility("hidden");
    vi.advanceTimersByTime(35_123);
    expect(tick).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    vi.advanceTimersByTime(0);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(tick.mock.results.at(-1)?.value).toBe(Date.now());
    vi.advanceTimersByTime(1_000);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  it("does not duplicate or postpone a timer on repeated visible notifications", () => {
    const tick = vi.fn();
    const stop = startVisibleInterval(tick, 1_000);
    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(500);
    setVisibility("visible");
    setVisibility("visible");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(500);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  it.each(["visible", "hidden"] as const)("stays disposed after cleanup while %s", (state) => {
    const tick = vi.fn();
    const stop = startVisibleInterval(tick, 1_000);
    setVisibility(state);
    stop();
    stop();
    setVisibility("hidden");
    setVisibility("visible");
    vi.advanceTimersByTime(300_000);
    expect(tick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
