import { describe, expect, it } from "vitest";

import {
  defaultCustomTitleBarPreference,
  resolveCustomTitleBarActive,
  resolveDesktopCustomTitleBarMode,
  supportsCustomTitleBar,
} from "./desktopTitleBar";

describe("supportsCustomTitleBar", () => {
  it("supports Windows and Linux only", () => {
    expect(supportsCustomTitleBar("win32")).toBe(true);
    expect(supportsCustomTitleBar("linux")).toBe(true);
    expect(supportsCustomTitleBar("darwin")).toBe(false);
    expect(supportsCustomTitleBar("freebsd")).toBe(false);
  });
});

describe("resolveDesktopCustomTitleBarMode", () => {
  it("uses native overlay controls on Windows when the custom title bar is active", () => {
    expect(resolveDesktopCustomTitleBarMode({ platform: "win32", preference: true })).toBe(
      "native-overlay",
    );
    expect(resolveDesktopCustomTitleBarMode({ platform: "win32", preference: null })).toBe(
      "native-overlay",
    );
  });

  it("keeps renderer controls on Linux and native frames elsewhere", () => {
    expect(resolveDesktopCustomTitleBarMode({ platform: "linux", preference: true })).toBe(
      "renderer",
    );
    expect(resolveDesktopCustomTitleBarMode({ platform: "linux", preference: false })).toBe(
      "native-frame",
    );
    expect(resolveDesktopCustomTitleBarMode({ platform: "darwin", preference: true })).toBe(
      "native-frame",
    );
  });
});

describe("defaultCustomTitleBarPreference", () => {
  it("defaults on for Windows and Linux, off elsewhere", () => {
    expect(defaultCustomTitleBarPreference("win32")).toBe(true);
    expect(defaultCustomTitleBarPreference("linux")).toBe(true);
    expect(defaultCustomTitleBarPreference("darwin")).toBe(false);
  });
});

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
