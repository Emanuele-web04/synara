import { describe, expect, it } from "vitest";

import { ToolGuidanceCadence } from "./toolGuidanceCadence.ts";

describe("ToolGuidanceCadence", () => {
  it("refreshes on first use and after each bounded interval per thread", () => {
    const cadence = new ToolGuidanceCadence(10, 8);

    expect(cadence.shouldRefresh("first")).toBe(true);
    for (let index = 0; index < 9; index += 1) {
      expect(cadence.shouldRefresh("first")).toBe(false);
    }
    expect(cadence.shouldRefresh("first")).toBe(true);
    expect(cadence.shouldRefresh("second")).toBe(true);
  });

  it("evicts old thread counters without changing active thread cadence", () => {
    const cadence = new ToolGuidanceCadence(2, 2);

    expect(cadence.shouldRefresh("first")).toBe(true);
    expect(cadence.shouldRefresh("second")).toBe(true);
    expect(cadence.shouldRefresh("second")).toBe(false);
    expect(cadence.shouldRefresh("third")).toBe(true);
    expect(cadence.shouldRefresh("second")).toBe(true);
    expect(cadence.shouldRefresh("first")).toBe(true);
  });
});
