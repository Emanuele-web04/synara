import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalImportPath,
  importPathIdentity,
  normalizeWindowsImportPath,
} from "./projectImportPaths";

describe("normalizeWindowsImportPath", () => {
  it("converts extended drive and UNC paths before resolving their parents", () => {
    const drive = normalizeWindowsImportPath("\\\\?\\C:\\_Install");
    const share = normalizeWindowsImportPath("\\\\?\\UNC\\Server\\Share\\gone");

    expect(drive).toBe("C:\\_Install");
    expect(path.win32.resolve(path.win32.dirname(drive))).toBe("C:\\");
    expect(share).toBe("\\\\Server\\Share\\gone");
    expect(path.win32.resolve(path.win32.dirname(share))).toBe("\\\\Server\\Share\\");
  });

  it("preserves ordinary drive, UNC, and other device paths", () => {
    expect(normalizeWindowsImportPath("C:\\repo")).toBe("C:\\repo");
    expect(normalizeWindowsImportPath("\\\\Server\\Share\\repo")).toBe("\\\\Server\\Share\\repo");
    expect(normalizeWindowsImportPath("\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1")).toBe(
      "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1",
    );
  });
});

it.runIf(process.platform === "win32")(
  "canonicalizes a missing extended drive path without losing its drive root",
  async () => {
    const missing = path.win32.toNamespacedPath(
      path.win32.join(process.env.SystemDrive ?? "C:", "synara-absent-import-root-1298"),
    );
    const result = await canonicalImportPath(missing);
    expect(importPathIdentity(result)).toBe(
      importPathIdentity(
        path.win32.join(process.env.SystemDrive ?? "C:", "synara-absent-import-root-1298"),
      ),
    );
    expect(result.startsWith("\\\\?\\")).toBe(false);
  },
);
