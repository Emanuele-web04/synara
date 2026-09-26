import { describe, expect, it } from "vitest";

import { resolveSidebarLayout } from "./useSidebarLayout";

describe("resolveSidebarLayout", () => {
  it("returns rail when the setting, Beta gate, and desktop viewport all allow it", () => {
    expect(resolveSidebarLayout({ setting: "rail", betaFeatureOn: true, isMobile: false })).toBe(
      "rail",
    );
  });

  it("keeps a stored rail setting inert on Stable", () => {
    expect(resolveSidebarLayout({ setting: "rail", betaFeatureOn: false, isMobile: false })).toBe(
      "classic",
    );
  });

  it("falls back to classic on mobile", () => {
    expect(resolveSidebarLayout({ setting: "rail", betaFeatureOn: true, isMobile: true })).toBe(
      "classic",
    );
  });

  it("returns classic when the user has not chosen the rail", () => {
    expect(resolveSidebarLayout({ setting: "classic", betaFeatureOn: true, isMobile: false })).toBe(
      "classic",
    );
  });
});
