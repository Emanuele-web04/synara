import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureStaticSnapshot, findAsarArchivePath, snapshotDirectoryName } from "./staticSnapshot";

describe("findAsarArchivePath", () => {
  it("resolves the containing archive for a path inside an asar", () => {
    expect(
      findAsarArchivePath(
        "/Applications/Synara.app/Contents/Resources/app.asar/apps/server/dist/client",
      ),
    ).toBe(path.join("/Applications/Synara.app/Contents/Resources/app.asar"));
  });

  it("returns the archive itself when the path is the asar file", () => {
    expect(findAsarArchivePath("/tmp/app.asar")).toBe(path.join("/tmp/app.asar"));
  });

  it("returns null for plain directories", () => {
    expect(findAsarArchivePath("/Users/me/dev/synara/apps/web/dist")).toBeNull();
  });
});

describe("snapshotDirectoryName", () => {
  it("keeps safe characters and replaces the rest", () => {
    expect(snapshotDirectoryName("194884627-1767900000000.123-42")).toBe(
      "194884627-1767900000000.123-42",
    );
    expect(snapshotDirectoryName("a/b\\c:d e")).toBe("a_b_c_d_e");
  });
});

describe("ensureStaticSnapshot", () => {
  let workDir: string;
  let sourceDir: string;
  let cacheRoot: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "static-snapshot-"));
    sourceDir = path.join(workDir, "source");
    cacheRoot = path.join(workDir, "cache");
    fs.mkdirSync(path.join(sourceDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "index.html"), "<html>v1</html>");
    fs.writeFileSync(path.join(sourceDir, "assets", "app.js"), "console.log(1)");
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("copies the source tree on first use", () => {
    const result = ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" });

    expect(result.reused).toBe(false);
    expect(fs.readFileSync(path.join(result.dir, "index.html"), "utf8")).toBe("<html>v1</html>");
    expect(fs.readFileSync(path.join(result.dir, "assets", "app.js"), "utf8")).toBe(
      "console.log(1)",
    );
  });

  it("reuses an existing snapshot for the same signature without re-reading the source", () => {
    const first = ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" });
    fs.rmSync(sourceDir, { recursive: true, force: true });

    const second = ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" });

    expect(second.reused).toBe(true);
    expect(second.dir).toBe(first.dir);
    expect(fs.readFileSync(path.join(second.dir, "index.html"), "utf8")).toBe("<html>v1</html>");
  });

  it("creates a fresh snapshot and prunes the old one when the signature changes", () => {
    const first = ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" });
    fs.writeFileSync(path.join(sourceDir, "index.html"), "<html>v2</html>");

    const second = ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-2" });

    expect(second.dir).not.toBe(first.dir);
    expect(fs.readFileSync(path.join(second.dir, "index.html"), "utf8")).toBe("<html>v2</html>");
    expect(fs.existsSync(first.dir)).toBe(false);
  });

  it("throws when the source is missing its sentinel so callers can fall back", () => {
    fs.rmSync(path.join(sourceDir, "index.html"));

    expect(() => ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" })).toThrow(
      /missing index\.html/,
    );
  });

  it("does not treat a half-written staging directory as a usable snapshot", () => {
    fs.mkdirSync(path.join(cacheRoot, ".staging-sig-1-999"), { recursive: true });

    const result = ensureStaticSnapshot({ sourceDir, cacheRoot, signature: "sig-1" });

    expect(result.reused).toBe(false);
    expect(fs.existsSync(path.join(cacheRoot, ".staging-sig-1-999"))).toBe(false);
  });
});
