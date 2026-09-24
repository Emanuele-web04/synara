import { describe, expect, it } from "vitest";

import {
  COMPUTER_BACKEND_OVERRIDES,
  InvalidComputerBackendOverrideError,
  isLinuxBackendChoice,
  parseComputerBackendOverride,
  selectLinuxBackend,
} from "./linuxBackendSelection.ts";

describe("parseComputerBackendOverride", () => {
  it("accepts every backend the server can name, case-insensitively", () => {
    for (const choice of COMPUTER_BACKEND_OVERRIDES) {
      expect(parseComputerBackendOverride(choice.toUpperCase())).toBe(choice);
      expect(parseComputerBackendOverride(` ${choice} `)).toBe(choice);
    }
    expect(parseComputerBackendOverride(undefined)).toBeUndefined();
    expect(parseComputerBackendOverride("  ")).toBeUndefined();
  });

  it("throws on a typo instead of silently booting the wrong backend", () => {
    // Every other env var here degrades to a default on bad input. This one
    // names the backend, so ignoring it would look like the override is broken.
    expect(() => parseComputerBackendOverride("protal")).toThrow(
      InvalidComputerBackendOverrideError,
    );
    expect(() => parseComputerBackendOverride("protal")).toThrow("cua");
  });

  it("has no shared-seat backend to name", () => {
    // Nothing in the tree drives the human's own seat, so a portal backend is
    // simply not a backend Synara has — the same refusal as any typo.
    expect(() => parseComputerBackendOverride("portal")).toThrow(
      InvalidComputerBackendOverrideError,
    );
  });

  it("tells the platform-neutral backends apart from the Linux tiers", () => {
    expect(isLinuxBackendChoice("fake")).toBe(false);
    expect(isLinuxBackendChoice("cua")).toBe(false);
    expect(isLinuxBackendChoice(undefined)).toBe(false);
  });
});

describe("selectLinuxBackend", () => {
  it("claims no host without an override when no tier is registered", async () => {
    await expect(selectLinuxBackend({ env: {} })).resolves.toBeUndefined();
  });
});
