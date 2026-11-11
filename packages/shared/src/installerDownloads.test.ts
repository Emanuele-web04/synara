// FILE: installerDownloads.test.ts
// Purpose: Protects the marketing total contract shared with analytics artifact selection.
import { describe, expect, it } from "vitest";

import { countInstallerDownloads } from "./installerDownloads";

describe("public installer counters", () => {
  it("sums supported installer artifacts, including zero, without counting updater metadata", () => {
    expect(
      countInstallerDownloads([
        {
          assets: [
            { name: "Synara.dmg", download_count: 10 },
            { name: "Synara.EXE", download_count: 2 },
            { name: "Synara.AppImage", download_count: 0 },
            { name: "Synara.exe.blockmap", download_count: 999 },
            { name: "latest.yml", download_count: 999 },
          ],
        },
      ]),
    ).toBe(12);
    for (const count of [-1, Infinity, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
      expect(() =>
        countInstallerDownloads([{ assets: [{ name: "Synara.dmg", download_count: count }] }]),
      ).toThrow();
    }
  });
});
