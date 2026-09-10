import { afterEach, expect, it, vi } from "vitest";
import { createComputerClickSequence } from "./computerClickSequence";

afterEach(() => vi.useRealTimers());

it("sends a double click atomically without waiting for a first RPC", () => {
  vi.useFakeTimers();
  const clicks = createComputerClickSequence();
  const send = vi.fn();
  clicks.click(1, send);
  vi.advanceTimersByTime(100);
  expect(send).not.toHaveBeenCalled();
  clicks.click(2, send);
  vi.runAllTimers();
  expect(send.mock.calls).toEqual([[2]]);
});

it("sends singles and drops pending clicks when interaction ends", () => {
  vi.useFakeTimers();
  const clicks = createComputerClickSequence();
  const send = vi.fn();
  clicks.click(1, send);
  vi.runAllTimers();
  expect(send.mock.calls).toEqual([[1]]);
  clicks.click(1, send);
  clicks.clear();
  vi.runAllTimers();
  expect(send).toHaveBeenCalledTimes(1);
});
