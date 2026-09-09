import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseCustomTitleBarPreference,
  readCustomTitleBarPreference,
  resolveDesktopCustomTitleBarState,
  resolveDesktopTitleBarConfiguration,
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

    expect(readCustomTitleBarPreference(filePath)).toBeNull();

    writeCustomTitleBarPreference(filePath, false);
    expect(readCustomTitleBarPreference(filePath)).toBe(false);

    writeCustomTitleBarPreference(filePath, true);
    expect(readCustomTitleBarPreference(filePath)).toBe(true);
  });
});

describe("resolveDesktopTitleBarConfiguration", () => {
  it("uses Windows native controls over the existing 46px renderer header", () => {
    expect(resolveDesktopTitleBarConfiguration({ platform: "win32", preference: null })).toEqual({
      mode: "native-overlay",
      windowOptions: {
        titleBarStyle: "hidden",
        titleBarOverlay: { color: "#00000000", height: 46 },
      },
    });
  });

  it("keeps the fully renderer-owned title bar on Linux", () => {
    expect(resolveDesktopTitleBarConfiguration({ platform: "linux", preference: true })).toEqual({
      mode: "renderer",
      windowOptions: { frame: false },
    });
  });

  it("returns native frame configuration when custom chrome is disabled or unsupported", () => {
    expect(resolveDesktopTitleBarConfiguration({ platform: "linux", preference: false })).toEqual({
      mode: "native-frame",
      windowOptions: {},
    });
    expect(resolveDesktopTitleBarConfiguration({ platform: "darwin", preference: true })).toEqual({
      mode: "native-frame",
      windowOptions: {},
    });
  });
});

describe("resolveDesktopCustomTitleBarState", () => {
  it("marks restart required when preference and active diverge", () => {
    expect(
      resolveDesktopCustomTitleBarState({
        platform: "linux",
        preference: true,
        activeMode: "native-frame",
      }),
    ).toEqual({
      supported: true,
      preference: true,
      active: false,
      restartRequired: true,
      mode: "native-frame",
    });
  });

  it("reports Windows native overlay as an active custom title bar", () => {
    expect(
      resolveDesktopCustomTitleBarState({
        platform: "win32",
        preference: true,
        activeMode: "native-overlay",
      }),
    ).toEqual({
      supported: true,
      preference: true,
      active: true,
      restartRequired: false,
      mode: "native-overlay",
    });
  });

  it("is unsupported on macOS", () => {
    expect(
      resolveDesktopCustomTitleBarState({
        platform: "darwin",
        preference: true,
        activeMode: "native-overlay",
      }),
    ).toEqual({
      supported: false,
      preference: false,
      active: false,
      restartRequired: false,
      mode: "native-frame",
    });
  });
});
