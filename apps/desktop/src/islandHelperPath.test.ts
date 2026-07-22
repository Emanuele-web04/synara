import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDesktopIslandHelperPath } from "./islandHelperPath";

describe("resolveDesktopIslandHelperPath", () => {
  it("resolves the development helper from the desktop runtime directory", () => {
    const desktopDir = Path.join(Path.sep, "repo", "apps", "desktop");

    expect(
      resolveDesktopIslandHelperPath({
        isPackaged: false,
        moduleDir: Path.join(desktopDir, "dist-electron"),
        resourcesPath: Path.join(Path.sep, "unused", "Resources"),
      }),
    ).toBe(Path.join(desktopDir, ".electron-runtime", "island", "synara-island-helper"));
  });

  it("resolves the packaged helper from the macOS Contents directory", () => {
    const contentsDir = Path.join(Path.sep, "Applications", "Synara.app", "Contents");

    expect(
      resolveDesktopIslandHelperPath({
        isPackaged: true,
        moduleDir: Path.join(Path.sep, "unused", "dist-electron"),
        resourcesPath: Path.join(contentsDir, "Resources"),
      }),
    ).toBe(Path.join(contentsDir, "Helpers", "synara-island-helper"));
  });
});
