import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isMacAppBundlePath,
  sameFileIdentity,
  supportsPosixPermissions,
  syncDirectoryEntry,
  syncRegularFile,
} from "./filesystemPlatform";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "synara-filesystem-platform-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("filesystemPlatform", () => {
  it("keeps POSIX permission behavior out of Windows", () => {
    expect(supportsPosixPermissions("win32")).toBe(false);
    expect(supportsPosixPermissions("linux")).toBe(true);
    expect(supportsPosixPermissions("darwin")).toBe(true);
  });

  it("treats directory fsync as unsupported on Windows", async () => {
    await expect(syncDirectoryEntry(path.join(root, "missing"), "win32")).resolves.toBeUndefined();
  });

  it("flushes an app-created regular file through a writable handle", async () => {
    const filePath = path.join(root, "state.sqlite.partial");
    writeFileSync(filePath, "snapshot");

    await expect(syncRegularFile(filePath, process.platform)).resolves.toBeUndefined();
  });

  it("recognizes macOS app bundles without catching dotted folders", () => {
    expect(isMacAppBundlePath("/Users/me/Fake Report.app", "darwin")).toBe(true);
    expect(isMacAppBundlePath("/Users/me/Old Build.APP", "darwin")).toBe(true);
    expect(isMacAppBundlePath("/Users/me/code/next.js", "darwin")).toBe(false);
    expect(isMacAppBundlePath("/home/me/Fake Report.app", "linux")).toBe(false);
  });

  it("uses inode identity on POSIX and the documented Windows path-guard fallback", () => {
    const leftPath = path.join(root, "left");
    const rightPath = path.join(root, "right");
    writeFileSync(leftPath, "left");
    writeFileSync(rightPath, "right");
    const left = statSync(leftPath);
    const same = statSync(leftPath);
    const right = statSync(rightPath);

    expect(sameFileIdentity(left, same, "linux")).toBe(true);
    expect(sameFileIdentity(left, right, "linux")).toBe(false);
    expect(sameFileIdentity(left, right, "win32")).toBe(true);
  });
});
