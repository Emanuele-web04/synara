import { describe, expect, it } from "vitest";
import {
  localizedKeepAwakeModeOptions,
  keepAwakeModeLabel,
  keepAwakeStatusLabel,
} from "./keepAwake";

describe("keepAwake copy helpers", () => {
  it("exposes the three modes in On / Agent / Off order", () => {
    expect(localizedKeepAwakeModeOptions().map((option) => option.value)).toEqual([
      "always",
      "agent",
      "off",
    ]);
    expect(localizedKeepAwakeModeOptions().map((option) => option.label)).toEqual([
      "On",
      "Agent",
      "Off",
    ]);
    for (const option of localizedKeepAwakeModeOptions()) {
      expect(option.description.length).toBeGreaterThan(0);
    }
  });

  it("formats status", () => {
    expect(keepAwakeModeLabel("agent")).toBe("Agent");
    expect(keepAwakeStatusLabel({ mode: "always", active: true })).toBe("On · Active");
    expect(keepAwakeStatusLabel({ mode: "agent", active: false })).toBe("Agent · Idle");
  });
});
