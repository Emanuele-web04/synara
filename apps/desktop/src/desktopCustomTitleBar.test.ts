import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseCustomTitleBarPreference,
  readCustomTitleBarSettings,
  resolveDesktopCustomTitleBarState,
  resolveDesktopTitleBarFrameOptions,
  writeCustomTitleBarPreference,
} from "./desktopCustomTitleBar";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseCustomTitleBarPreference", () => {
  it("accepts versioned boolean payloads and rejects malformed ones", () => {
    expect(parseCustomTitleBarPreference({ version: 1, enabled: true })).toEqual({
      version: 1,
      enabled: true,
    });
    expect(parseCustomTitleBarPreference({ version: 1, enabled: false })).toEqual({
      version: 1,
      enabled: false,
    });
    expect(
      parseCustomTitleBarPreference({ version: 1, enabled: true, roundedCorners: false }),
    ).toEqual({ version: 1, enabled: true, roundedCorners: false });
    expect(parseCustomTitleBarPreference({ version: 2, enabled: true })).toBeNull();
    expect(parseCustomTitleBarPreference({ enabled: true })).toBeNull();
    expect(parseCustomTitleBarPreference(null)).toBeNull();
  });
});

describe("custom title bar preference filesystem", () => {
  it("round-trips the preference and returns null for missing files", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-title-bar-"));
    temporaryDirectories.push(directory);
    const filePath = Path.join(directory, "nested", "custom-title-bar.json");

    expect(readCustomTitleBarSettings(filePath)).toEqual({ enabled: null, roundedCorners: true });

    writeCustomTitleBarPreference(filePath, { enabled: false, roundedCorners: true });
    expect(readCustomTitleBarSettings(filePath)).toEqual({ enabled: false, roundedCorners: true });

    writeCustomTitleBarPreference(filePath, { enabled: true, roundedCorners: false });
    expect(readCustomTitleBarSettings(filePath)).toEqual({ enabled: true, roundedCorners: false });
  });

  it("keeps rounded corners on for files written before the toggle existed", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-title-bar-"));
    temporaryDirectories.push(directory);
    const filePath = Path.join(directory, "custom-title-bar.json");
    FS.writeFileSync(filePath, JSON.stringify({ version: 1, enabled: true }));

    expect(readCustomTitleBarSettings(filePath)).toEqual({ enabled: true, roundedCorners: true });
  });
});

describe("resolveDesktopTitleBarFrameOptions", () => {
  it("returns frameless options when the preference resolves active", () => {
    expect(
      resolveDesktopTitleBarFrameOptions({
        platform: "linux",
        preference: true,
        roundedCorners: true,
      }),
    ).toEqual({
      frame: false,
    });
    expect(
      resolveDesktopTitleBarFrameOptions({
        platform: "win32",
        preference: null,
        roundedCorners: true,
      }),
    ).toEqual({ frame: false });
  });

  it("turns off Electron's rounded corners when the user asks for square ones", () => {
    expect(
      resolveDesktopTitleBarFrameOptions({
        platform: "linux",
        preference: true,
        roundedCorners: false,
      }),
    ).toEqual({ frame: false, roundedCorners: false });
  });

  it("returns an empty object for native frames", () => {
    expect(
      resolveDesktopTitleBarFrameOptions({
        platform: "linux",
        preference: false,
        roundedCorners: false,
      }),
    ).toEqual({});
    expect(
      resolveDesktopTitleBarFrameOptions({
        platform: "darwin",
        preference: true,
        roundedCorners: true,
      }),
    ).toEqual({});
  });
});

describe("resolveDesktopCustomTitleBarState", () => {
  it("marks restart required when preference and active diverge", () => {
    expect(
      resolveDesktopCustomTitleBarState({
        platform: "linux",
        preference: true,
        active: false,
        roundedCornersPreference: true,
        roundedCornersActive: true,
      }),
    ).toEqual({
      supported: true,
      preference: true,
      active: false,
      roundedCornersPreference: true,
      roundedCornersActive: true,
      restartRequired: true,
    });
  });

  it("marks restart required when only the corner preference changed", () => {
    expect(
      resolveDesktopCustomTitleBarState({
        platform: "linux",
        preference: true,
        active: true,
        roundedCornersPreference: false,
        roundedCornersActive: true,
      }).restartRequired,
    ).toBe(true);
    expect(
      resolveDesktopCustomTitleBarState({
        platform: "linux",
        preference: false,
        active: false,
        roundedCornersPreference: false,
        roundedCornersActive: true,
      }).restartRequired,
    ).toBe(false);
  });

  it("is unsupported on macOS", () => {
    expect(
      resolveDesktopCustomTitleBarState({
        platform: "darwin",
        preference: true,
        active: false,
        roundedCornersPreference: true,
        roundedCornersActive: true,
      }),
    ).toEqual({
      supported: false,
      preference: false,
      active: false,
      roundedCornersPreference: true,
      roundedCornersActive: true,
      restartRequired: false,
    });
  });
});
