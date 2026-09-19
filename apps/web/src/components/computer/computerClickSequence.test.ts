import { afterEach, expect, it, vi } from "vitest";
import {
  COMPUTER_DOUBLE_CLICK_WINDOW_MS,
  createComputerClickSequence,
} from "./computerClickSequence";

afterEach(() => vi.useRealTimers());

it("flushes a pending click before keyboard input without recursive or timer duplication", () => {
  vi.useFakeTimers();
  const clicks = createComputerClickSequence();
  const sent: string[] = [];
  const sendInput = (value: string) => {
    clicks.flush();
    sent.push(value);
  };
  clicks.click(1, (count) => sendInput(`click:${count}`));
  sendInput("key:a");
  clicks.flush();
  vi.runAllTimers();
  expect(sent).toEqual(["click:1", "key:a"]);
});

it("sends a double click atomically without waiting for a first RPC", () => {
  vi.useFakeTimers();
  const clicks = createComputerClickSequence();
  const send = vi.fn();
  clicks.click(1, send);
  vi.advanceTimersByTime(COMPUTER_DOUBLE_CLICK_WINDOW_MS - 1);
  expect(send).not.toHaveBeenCalled();
  clicks.click(2, send);
  vi.runAllTimers();
  expect(send.mock.calls).toEqual([[2]]);
});

it("makes an ordinary single click wait no longer than the double-click window", () => {
  // Every single click pays this delay before the desktop reacts, so it is the
  // pane's baseline responsiveness, not a corner case.
  vi.useFakeTimers();
  const clicks = createComputerClickSequence();
  const send = vi.fn();
  clicks.click(1, send);
  vi.advanceTimersByTime(COMPUTER_DOUBLE_CLICK_WINDOW_MS);
  expect(send.mock.calls).toEqual([[1]]);
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
