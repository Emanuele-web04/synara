import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startEventLoopDeadline } from "./eventLoopDeadline.ts";

// Fake timers advance Date.now() tick by tick, like a responsive loop.
const now = () => Date.now();
const advance = (ms: number) => vi.advanceTimersByTime(ms);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it("expires after the budget while the loop stays responsive", () => {
  const onExpire = vi.fn();
  startEventLoopDeadline(1_000, onExpire, now);
  advance(750);
  expect(onExpire).not.toHaveBeenCalled();
  advance(250);
  expect(onExpire).toHaveBeenCalledOnce();
  advance(5_000);
  expect(onExpire).toHaveBeenCalledOnce();
});

it("charges a stalled loop as a single tick", () => {
  const onExpire = vi.fn();
  startEventLoopDeadline(1_000, onExpire, now);
  advance(500);
  // The loop is blocked: wall time moves, but no tick runs until it unblocks.
  vi.setSystemTime(Date.now() + 30_000);
  advance(250);
  expect(onExpire).not.toHaveBeenCalled();
  advance(250);
  expect(onExpire).toHaveBeenCalledOnce();
});

it("never fires once cancelled", () => {
  const onExpire = vi.fn();
  const cancel = startEventLoopDeadline(100, onExpire, now);
  advance(50);
  cancel();
  advance(1_000);
  expect(onExpire).not.toHaveBeenCalled();
});
