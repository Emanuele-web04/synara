import { afterEach, expect, it, vi } from "vitest";
import { createComputerClickSequence } from "./computerClickSequence";

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
