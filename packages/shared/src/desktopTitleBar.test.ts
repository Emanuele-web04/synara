import { describe, expect, it } from "vitest";

import { resolveCustomTitleBarActive } from "./desktopTitleBar";

describe("resolveCustomTitleBarActive", () => {
  it("never activates on unsupported platforms", () => {
    expect(resolveCustomTitleBarActive({ platform: "darwin", preference: true })).toBe(false);
    expect(resolveCustomTitleBarActive({ platform: "darwin", preference: null })).toBe(false);
  });

  it("uses the platform default when preference is unset", () => {
    expect(resolveCustomTitleBarActive({ platform: "win32", preference: null })).toBe(true);
    expect(resolveCustomTitleBarActive({ platform: "linux", preference: null })).toBe(true);
  });

  it("honors an explicit preference on supported platforms", () => {
    expect(resolveCustomTitleBarActive({ platform: "linux", preference: false })).toBe(false);
    expect(resolveCustomTitleBarActive({ platform: "win32", preference: false })).toBe(false);
    expect(resolveCustomTitleBarActive({ platform: "linux", preference: true })).toBe(true);
  });
});
