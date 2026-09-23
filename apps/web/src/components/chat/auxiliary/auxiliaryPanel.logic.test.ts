import { describe, expect, it } from "vitest";

import { resolveProjectPanelEnabled } from "./auxiliaryPanel.logic";

describe("auxiliary panel slot", () => {
  it("shows Project only for group containers", () => {
    expect(resolveProjectPanelEnabled({ environmentEnabled: true, isGroupContainer: true })).toBe(
      true,
    );
    expect(resolveProjectPanelEnabled({ environmentEnabled: true, isGroupContainer: false })).toBe(
      false,
    );
    expect(resolveProjectPanelEnabled({ environmentEnabled: false, isGroupContainer: true })).toBe(
      false,
    );
  });
});
