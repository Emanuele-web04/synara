import { COMPUTER_INPUT_SCROLL_LIMIT } from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";

import { COMPUTER_SCROLL_FLUSH_MS, createComputerScrollBatch } from "./computerScrollBatch";

afterEach(() => vi.useRealTimers());

it("sums a burst into one scroll at the position the gesture ended on", () => {
  vi.useFakeTimers();
  const batch = createComputerScrollBatch();
  const send = vi.fn();

  batch.add({ x: 10, y: 10 }, { deltaX: 0, deltaY: 12 }, send);
  batch.add({ x: 11, y: 14 }, { deltaX: 3, deltaY: 18 }, send);
  expect(send).not.toHaveBeenCalled();

  vi.advanceTimersByTime(COMPUTER_SCROLL_FLUSH_MS);
  expect(send.mock.calls).toEqual([[{ x: 11, y: 14, deltaX: 3, deltaY: 30 }]]);
});

it("sends what has accumulated when the burst is flushed early", () => {
  // The pane re-subscribes its wheel listener whenever the desktop pushes new
  // geometry, which happens constantly while scrolling. Clearing the timer on
  // the way out without flushing meant those deltas were silently dropped and
  // the desktop scrolled less than the hand did.
  vi.useFakeTimers();
  const batch = createComputerScrollBatch();
  const send = vi.fn();

  batch.add({ x: 4, y: 5 }, { deltaX: 0, deltaY: 9 }, send);
  batch.flush();

  expect(send.mock.calls).toEqual([[{ x: 4, y: 5, deltaX: 0, deltaY: 9 }]]);
  // The window is closed with the burst; the timer must not fire a second one.
  vi.runAllTimers();
  expect(send).toHaveBeenCalledTimes(1);
});

it("survives a flush re-entered from inside the send", () => {
  // The pane's send path flushes this batch to keep clicks and scrolls in
  // order, and that path is how a scroll is sent in the first place.
  vi.useFakeTimers();
  const batch = createComputerScrollBatch();
  const send = vi.fn(() => batch.flush());

  batch.add({ x: 1, y: 2 }, { deltaX: 0, deltaY: 4 }, send);
  vi.runAllTimers();

  expect(send).toHaveBeenCalledTimes(1);
});

it("clamps the coalesced burst rather than each event", () => {
  vi.useFakeTimers();
  const batch = createComputerScrollBatch();
  const send = vi.fn();

  for (let index = 0; index < 50; index += 1) {
    batch.add({ x: 0, y: 0 }, { deltaX: 0, deltaY: 400 }, send);
  }
  vi.runAllTimers();

  expect(send.mock.calls[0]?.[0].deltaY).toBe(COMPUTER_INPUT_SCROLL_LIMIT);
});

it("drops the open burst when interaction ends", () => {
  vi.useFakeTimers();
  const batch = createComputerScrollBatch();
  const send = vi.fn();

  batch.add({ x: 0, y: 0 }, { deltaX: 0, deltaY: 30 }, send);
  batch.clear();
  vi.runAllTimers();

  expect(send).not.toHaveBeenCalled();
});

it("sends nothing when a burst cancels itself out", () => {
  vi.useFakeTimers();
  const batch = createComputerScrollBatch();
  const send = vi.fn();

  batch.add({ x: 0, y: 0 }, { deltaX: 0, deltaY: 20 }, send);
  batch.add({ x: 0, y: 0 }, { deltaX: 0, deltaY: -20 }, send);
  vi.runAllTimers();

  expect(send).not.toHaveBeenCalled();
});
