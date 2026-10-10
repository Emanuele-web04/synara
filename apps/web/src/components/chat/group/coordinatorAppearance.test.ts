// FILE: coordinatorAppearance.test.ts
// Purpose: Covers the coordinator appearance resolver — known keys map to their
//          glyph/color, and unknown or cleared keys fall back to the default
//          bot icon with the inherited row color.
// Layer: Web logic test

import { describe, expect, it } from "vitest";

import { BotIcon, BrainIcon } from "~/lib/icons";

import {
  COORDINATOR_COLOR_OPTIONS,
  COORDINATOR_ICON_OPTIONS,
  resolveCoordinatorAppearance,
} from "./coordinatorAppearance";

describe("resolveCoordinatorAppearance", () => {
  it("returns the bot icon and inherited color for an empty config", () => {
    const appearance = resolveCoordinatorAppearance({});
    expect(appearance.Icon).toBe(BotIcon);
    expect(appearance.iconClassName).toBe("");
    expect(appearance.iconKey).toBe("bot");
    expect(appearance.colorKey).toBe("default");
  });

  it("resolves a known icon and color", () => {
    const appearance = resolveCoordinatorAppearance({
      coordinatorIcon: "brain",
      coordinatorColor: "violet",
    });
    expect(appearance.Icon).toBe(BrainIcon);
    expect(appearance.iconClassName).toBe("text-violet-500");
  });

  it("falls back to the default icon for an unknown key", () => {
    const appearance = resolveCoordinatorAppearance({ coordinatorIcon: "no-such-icon" });
    expect(appearance.Icon).toBe(BotIcon);
    expect(appearance.iconKey).toBe("bot");
  });

  it("falls back to the default color for an unknown key", () => {
    const appearance = resolveCoordinatorAppearance({ coordinatorColor: "no-such-color" });
    expect(appearance.iconClassName).toBe("");
    expect(appearance.colorKey).toBe("default");
  });

  it("keeps icon and color sets distinct and non-empty", () => {
    expect(COORDINATOR_ICON_OPTIONS.length).toBeGreaterThanOrEqual(16);
    expect(COORDINATOR_COLOR_OPTIONS.length).toBeGreaterThanOrEqual(8);
    const iconKeys = new Set(COORDINATOR_ICON_OPTIONS.map((option) => option.key));
    const colorKeys = new Set(COORDINATOR_COLOR_OPTIONS.map((option) => option.key));
    expect(iconKeys.size).toBe(COORDINATOR_ICON_OPTIONS.length);
    expect(colorKeys.size).toBe(COORDINATOR_COLOR_OPTIONS.length);
  });
});
