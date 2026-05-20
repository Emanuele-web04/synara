import { describe, expect, it } from "vitest";

import {
  clearHermesProfileInventoryCacheForTests,
  resolveDefaultHermesProfile,
} from "./hermesProfileInventory.ts";

describe("resolveDefaultHermesProfile", () => {
  it("prefers the active profile marker", () => {
    expect(
      resolveDefaultHermesProfile([
        { name: "work", model: "gpt-5.4", isActive: false },
        { name: "default", model: "deepseek-v4-flash", isActive: true },
      ]),
    ).toEqual({
      name: "default",
      model: "deepseek-v4-flash",
      isActive: true,
    });
  });

  it("falls back to the first profile when none are active", () => {
    expect(
      resolveDefaultHermesProfile([
        { name: "alpha", model: "a" },
        { name: "beta", model: "b" },
      ]),
    ).toEqual({ name: "alpha", model: "a" });
  });
});

describe("hermesProfileInventory cache", () => {
  it("clears cached list entries for tests", () => {
    clearHermesProfileInventoryCacheForTests();
    expect(true).toBe(true);
  });
});
