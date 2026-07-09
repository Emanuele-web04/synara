import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolveDesktopAppDataBase,
  resolveDesktopUserDataPath,
  resolveLegacyDesktopUserDataPaths,
  seedDesktopUserDataProfileFromLegacy,
} from "./desktopUserDataProfile";

describe("desktopUserDataProfile", () => {
  it("resolves Synara profile names without reusing legacy profile paths", () => {
    const appDataBase = "/Users/tester/Library/Application Support";

    expect(resolveDesktopUserDataPath({ appDataBase, isDevelopment: true })).toBe(
      "/Users/tester/Library/Application Support/synara-dev",
    );
    expect(resolveDesktopUserDataPath({ appDataBase, isDevelopment: false })).toBe(
      "/Users/tester/Library/Application Support/synara",
    );
    expect(resolveLegacyDesktopUserDataPaths({ appDataBase, isDevelopment: true })).toEqual([
      "/Users/tester/Library/Application Support/dpcode-dev",
      "/Users/tester/Library/Application Support/t3code-dev",
      "/Users/tester/Library/Application Support/DP Code (Dev)",
    ]);
  });

  it("uses XDG_CONFIG_HOME on Linux when available", () => {
    expect(
      resolveDesktopAppDataBase({
        platform: "linux",
        env: { XDG_CONFIG_HOME: "/tmp/xdg" },
        homeDir: "/home/tester",
      }),
    ).toBe("/tmp/xdg");
  });

  it("seeds local persistent renderer data into the new Synara profile once", () => {
    const tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-userdata-profile-"));
    try {
      const legacyPath = Path.join(tempDir, "t3code-dev");
      const targetPath = Path.join(tempDir, "synara-dev");
      FS.mkdirSync(Path.join(legacyPath, "Local Storage", "leveldb"), { recursive: true });
      FS.writeFileSync(
        Path.join(legacyPath, "Local Storage", "leveldb", "000003.log"),
        "t3code:pinned-threads:v1",
      );
      FS.mkdirSync(Path.join(legacyPath, "Partitions", "t3code-browser"), {
        recursive: true,
      });
      FS.writeFileSync(
        Path.join(legacyPath, "Partitions", "t3code-browser", "Cookies"),
        "browser-session",
      );
      FS.writeFileSync(Path.join(legacyPath, "Cookies"), "renderer-session");

      const result = seedDesktopUserDataProfileFromLegacy({
        targetPath,
        legacyPaths: [legacyPath],
      });

      expect(result.status).toBe("seeded");
      expect(
        FS.readFileSync(Path.join(targetPath, "Local Storage", "leveldb", "000003.log"), "utf8"),
      ).toBe("t3code:pinned-threads:v1");
      expect(FS.readFileSync(Path.join(targetPath, "Cookies"), "utf8")).toBe("renderer-session");
      expect(
        FS.readFileSync(Path.join(targetPath, "Partitions", "synara-browser", "Cookies"), "utf8"),
      ).toBe("browser-session");
      expect(FS.existsSync(Path.join(targetPath, "Partitions", "t3code-browser"))).toBe(false);

      const secondResult = seedDesktopUserDataProfileFromLegacy({
        targetPath,
        legacyPaths: [legacyPath],
      });
      expect(secondResult.status).toBe("target-exists");
    } finally {
      FS.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("repairs a pre-existing Synara profile without overwriting newer browser data", () => {
    const tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-userdata-profile-"));
    try {
      const legacyPath = Path.join(tempDir, "dpcode");
      const targetPath = Path.join(tempDir, "synara");
      const legacyPartition = Path.join(legacyPath, "Partitions", "dpcode-browser");
      const targetPartition = Path.join(targetPath, "Partitions", "synara-browser");
      FS.mkdirSync(legacyPartition, { recursive: true });
      FS.mkdirSync(targetPartition, { recursive: true });
      FS.writeFileSync(Path.join(legacyPartition, "Cookies"), "legacy-session");
      FS.writeFileSync(Path.join(legacyPartition, "Preferences"), "legacy-preferences");
      FS.writeFileSync(Path.join(targetPartition, "Preferences"), "newer-preferences");

      const result = seedDesktopUserDataProfileFromLegacy({
        targetPath,
        legacyPaths: [legacyPath],
      });

      expect(result.status).toBe("repaired-browser-partition");
      expect(FS.readFileSync(Path.join(targetPartition, "Cookies"), "utf8")).toBe("legacy-session");
      expect(FS.readFileSync(Path.join(targetPartition, "Preferences"), "utf8")).toBe(
        "newer-preferences",
      );

      expect(
        seedDesktopUserDataProfileFromLegacy({ targetPath, legacyPaths: [legacyPath] }).status,
      ).toBe("target-exists");
    } finally {
      FS.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
