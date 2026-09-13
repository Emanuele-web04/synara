import { describe, expect, it } from "vitest";

import { waitForDeviceAccessibility } from "./device-smoke-readiness";

const starting = () =>
  new Error(
    "accessibility tree unavailable: no frontmost application (SpringBoard may still be starting)",
  );

function clock(timeoutMs = 2_000) {
  let elapsed = 0;
  const delays: number[] = [];
  return {
    options: {
      timeoutMs,
      now: () => elapsed,
      sleep: async (ms: number) => {
        delays.push(ms);
        elapsed += ms;
      },
    },
    delays,
    advance: (ms: number) => {
      elapsed += ms;
    },
  };
}

describe("post-Home device smoke readiness", () => {
  it("returns an immediately ready response without a fixed delay", async () => {
    const timer = clock();
    const result = { tree: { children: ["home"] } };
    expect(await waitForDeviceAccessibility(async () => result, timer.options)).toBe(result);
    expect(timer.delays).toEqual([]);
  });

  it("waits only for SpringBoard readiness and bounds every request", async () => {
    const timer = clock();
    const budgets: number[] = [];
    const result = { tree: { children: ["home"] } };
    expect(
      await waitForDeviceAccessibility(async (budget) => {
        budgets.push(budget);
        if (budgets.length < 3) throw starting();
        return result;
      }, timer.options),
    ).toBe(result);
    expect(budgets).toEqual([2000, 1500, 1000]);
    expect(timer.delays).toEqual([500, 500]);
  });

  it("fails closed at the deadline when the frontmost app never appears", async () => {
    const timer = clock(750);
    await expect(
      waitForDeviceAccessibility(async () => {
        throw starting();
      }, timer.options),
    ).rejects.toThrow("not ready within 750ms");
    expect(timer.delays).toEqual([500, 250]);
  });

  it("does not retry capability errors, helper timeouts or unrelated failures", async () => {
    for (const error of [
      new Error("accessibility unavailable"),
      new Error("helper timed out"),
      "bad RPC",
    ]) {
      const timer = clock();
      await expect(
        waitForDeviceAccessibility(async () => {
          throw error;
        }, timer.options),
      ).rejects.toBe(error);
      expect(timer.delays).toEqual([]);
    }
  });

  it("leaves empty or malformed trees to the unchanged smoke assertions", async () => {
    const timer = clock();
    const invalid = {};
    expect(await waitForDeviceAccessibility(async () => invalid, timer.options)).toBe(invalid);
    expect(timer.delays).toEqual([]);
  });

  it("does not accept a response after the total deadline", async () => {
    const timer = clock(100);
    await expect(
      waitForDeviceAccessibility(async () => {
        timer.advance(101);
        return { tree: { children: ["home"] } };
      }, timer.options),
    ).rejects.toThrow("not ready within 100ms");
  });

  it("rejects invalid budgets", async () => {
    for (const timeoutMs of [0, -1, Infinity, NaN]) {
      await expect(waitForDeviceAccessibility(async () => ({}), { timeoutMs })).rejects.toThrow(
        "Invalid readiness timeout",
      );
    }
  });
});
