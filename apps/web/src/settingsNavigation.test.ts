import { describe, expect, it } from "vitest";

import {
  normalizeSettingsSection,
  SETTINGS_NAV_ITEMS,
  visibleSettingsNavItems,
} from "./settingsNavigation";

describe("settingsNavigation Beta-only sections", () => {
  it("lists the computer section when the feature is enabled", () => {
    expect(visibleSettingsNavItems(true).map((item) => item.id)).toContain("computer");
    expect(visibleSettingsNavItems(true)).toHaveLength(SETTINGS_NAV_ITEMS.length);
  });

  it("omits the computer section when the feature is disabled", () => {
    const items = visibleSettingsNavItems(false);
    expect(items.map((item) => item.id)).not.toContain("computer");
    expect(items).toHaveLength(SETTINGS_NAV_ITEMS.length - 1);
    // Every other section survives.
    expect(items.map((item) => item.id)).toEqual(
      SETTINGS_NAV_ITEMS.filter((item) => item.id !== "computer").map((item) => item.id),
    );
  });

  it("falls back to general for a computer deep link when disabled", () => {
    expect(normalizeSettingsSection("computer", false)).toBe("general");
    expect(normalizeSettingsSection("computer", true)).toBe("computer");
    expect(normalizeSettingsSection("models", false)).toBe("models");
  });
});
