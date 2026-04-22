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
  it("resolves DP Code profile names without reusing legacy profile paths", () => {
    const appDataBase = "/Users/tester/Library/Application Support";

    expect(resolveDesktopUserDataPath({ appDataBase, isDevelopment: true })).toBe(
      "/Users/tester/Library/Application Support/dpcode-dev",
    );
    expect(resolveDesktopUserDataPath({ appDataBase, isDevelopment: false })).toBe(
      "/Users/tester/Library/Application Support/dpcode",
    );
    expect(resolveLegacyDesktopUserDataPaths({ appDataBase, isDevelopment: true })).toEqual([
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

  it("seeds local persistent renderer data into the new DP profile once", () => {
    const tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "dpcode-userdata-profile-"));
    try {
      const legacyPath = Path.join(tempDir, "t3code-dev");
      const targetPath = Path.join(tempDir, "dpcode-dev");
      FS.mkdirSync(Path.join(legacyPath, "Local Storage", "leveldb"), { recursive: true });
      FS.writeFileSync(
        Path.join(legacyPath, "Local Storage", "leveldb", "000003.log"),
        "t3code:pinned-threads:v1",
      );

      const result = seedDesktopUserDataProfileFromLegacy({
        targetPath,
        legacyPaths: [legacyPath],
      });

      expect(result.status).toBe("seeded");
      expect(
        FS.readFileSync(Path.join(targetPath, "Local Storage", "leveldb", "000003.log"), "utf8"),
      ).toBe("t3code:pinned-threads:v1");

      const secondResult = seedDesktopUserDataProfileFromLegacy({
        targetPath,
        legacyPaths: [legacyPath],
      });
      expect(secondResult.status).toBe("target-exists");
    } finally {
      FS.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
