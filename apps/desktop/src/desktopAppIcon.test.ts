import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  desktopAppIconResourceName,
  isDesktopAppIcon,
  normalizeStoredDesktopAppIcon,
  readDesktopAppIconPreference,
  shouldUpdateDesktopAppIcon,
  usesMacBundleAppIcon,
  writeDesktopAppIconPreference,
} from "./desktopAppIcon";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryIconPath(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-app-icon-"));
  temporaryDirectories.push(directory);
  return Path.join(directory, "desktop-app-icon");
}

describe("desktop app icons", () => {
  it("accepts only supported preferences", () => {
    expect(isDesktopAppIcon("default")).toBe(true);
    expect(isDesktopAppIcon("icon")).toBe(true);
    expect(isDesktopAppIcon("dark")).toBe(true);
    expect(isDesktopAppIcon("unknown")).toBe(false);
  });

  it("selects the alternate native asset on every desktop platform", () => {
    expect(
      desktopAppIconResourceName({ icon: "icon", platform: "darwin", isDarkAppearance: false }),
    ).toBe("app-icon-macos.png");
    expect(
      desktopAppIconResourceName({ icon: "icon", platform: "win32", isDarkAppearance: false }),
    ).toBe("app-icon-windows.ico");
    expect(
      desktopAppIconResourceName({ icon: "icon", platform: "linux", isDarkAppearance: false }),
    ).toBe("app-icon-linux.png");
  });

  it("uses a PNG for the macOS default icon in light and dark mode", () => {
    expect(
      desktopAppIconResourceName({ icon: "default", platform: "darwin", isDarkAppearance: false }),
    ).toBe("dock-icon.png");
    expect(
      desktopAppIconResourceName({ icon: "default", platform: "darwin", isDarkAppearance: true }),
    ).toBe("dock-icon-dark.png");
  });

  it("always uses the dark artwork when the dark preference is selected", () => {
    expect(
      desktopAppIconResourceName({ icon: "dark", platform: "darwin", isDarkAppearance: false }),
    ).toBe("dock-icon-dark.png");
    expect(
      desktopAppIconResourceName({ icon: "dark", platform: "darwin", isDarkAppearance: true }),
    ).toBe("dock-icon-dark.png");
  });

  it("falls back to the default icon for the dark preference off macOS", () => {
    expect(
      desktopAppIconResourceName({ icon: "dark", platform: "linux", isDarkAppearance: false }),
    ).toBe("icon.png");
    expect(
      desktopAppIconResourceName({ icon: "dark", platform: "win32", isDarkAppearance: false }),
    ).toBe("icon.ico");
    expect(
      desktopAppIconResourceName({ icon: "default", platform: "linux", isDarkAppearance: true }),
    ).toBe("icon.png");
    expect(
      desktopAppIconResourceName({ icon: "default", platform: "win32", isDarkAppearance: true }),
    ).toBe("icon.ico");
  });

  it("leaves the Liquid Glass bundle icon alone for the macOS default preference", () => {
    expect(
      usesMacBundleAppIcon({ icon: "default", platform: "darwin", usesLegacyDockIcon: false }),
    ).toBe(true);
    expect(
      usesMacBundleAppIcon({ icon: "default", platform: "darwin", usesLegacyDockIcon: true }),
    ).toBe(false);
    expect(
      usesMacBundleAppIcon({ icon: "icon", platform: "darwin", usesLegacyDockIcon: false }),
    ).toBe(false);
    expect(
      usesMacBundleAppIcon({ icon: "dark", platform: "darwin", usesLegacyDockIcon: false }),
    ).toBe(false);
    expect(
      usesMacBundleAppIcon({ icon: "default", platform: "linux", usesLegacyDockIcon: false }),
    ).toBe(false);
    expect(
      usesMacBundleAppIcon({ icon: "default", platform: "win32", usesLegacyDockIcon: false }),
    ).toBe(false);
  });

  it("does not reapply the icon when renderer hydration matches native state", () => {
    expect(shouldUpdateDesktopAppIcon("default", "default")).toBe(false);
    expect(shouldUpdateDesktopAppIcon("icon", "icon")).toBe(false);
    expect(shouldUpdateDesktopAppIcon("dark", "dark")).toBe(false);
    expect(shouldUpdateDesktopAppIcon("default", "dark")).toBe(true);
    expect(shouldUpdateDesktopAppIcon("dark", "icon")).toBe(true);
  });
});

describe("desktop app icon preference reset", () => {
  it("resets unrecognized persisted values to default and writes the reset back", () => {
    const filePath = temporaryIconPath();
    FS.writeFileSync(filePath, "beta", "utf8");

    expect(normalizeStoredDesktopAppIcon("beta")).toEqual({ icon: "default", needsReset: true });
    expect(readDesktopAppIconPreference(filePath)).toBe("default");
    expect(FS.readFileSync(filePath, "utf8")).toBe("default");
  });

  it("reads a missing preference as default without creating the file", () => {
    const filePath = temporaryIconPath();

    expect(readDesktopAppIconPreference(filePath)).toBe("default");
    expect(FS.existsSync(filePath)).toBe(false);
  });

  it("treats a blank persisted value as missing without writing", () => {
    const filePath = temporaryIconPath();
    FS.writeFileSync(filePath, "   \n", "utf8");

    expect(normalizeStoredDesktopAppIcon("   \n")).toEqual({ icon: "default", needsReset: false });
    expect(readDesktopAppIconPreference(filePath)).toBe("default");
    expect(FS.readFileSync(filePath, "utf8")).toBe("   \n");
  });

  it("keeps valid persisted values untouched", () => {
    for (const icon of ["default", "icon", "dark"] as const) {
      const filePath = temporaryIconPath();
      writeDesktopAppIconPreference(filePath, icon);

      expect(normalizeStoredDesktopAppIcon(` ${icon}\n`)).toEqual({ icon, needsReset: false });
      expect(readDesktopAppIconPreference(filePath)).toBe(icon);
      expect(FS.readFileSync(filePath, "utf8")).toBe(icon);
    }
  });

  it("reports no reset error for valid or missing values", () => {
    const missingPath = temporaryIconPath();
    let reported: unknown;
    const onResetError = (error: unknown): void => {
      reported = error;
    };

    expect(readDesktopAppIconPreference(missingPath, onResetError)).toBe("default");
    expect(reported).toBeUndefined();

    const validPath = temporaryIconPath();
    writeDesktopAppIconPreference(validPath, "dark");
    expect(readDesktopAppIconPreference(validPath, onResetError)).toBe("dark");
    expect(reported).toBeUndefined();
  });
});
