import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  evaluatePackagedBundleSize,
  evaluatePortableBundleSize,
  parseBundleSizeArgs,
  readBundleSizeBudget,
} from "./check-bundle-size.ts";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("bundle size budget checker", () => {
  it("loads the repository budget configuration cleanly", () => {
    const budget = readBundleSizeBudget(
      fileURLToPath(new URL("./bundle-size-budget.json", import.meta.url)),
    );
    expect(budget.portable.desktopMainMaxBytes).toBeGreaterThan(0);
    expect(budget.portable.serverDistMaxBytes).toBeGreaterThan(0);
    expect(budget.portable.webClientMaxBytes).toBeGreaterThan(0);
    expect(budget.packaged["mac-arm64"]?.installerMaxBytes).toBeGreaterThan(0);
    expect(budget.packaged["win-x64"]?.installerMaxBytes).toBeGreaterThan(0);
    expect(budget.packaged["linux-x64"]?.installerMaxBytes).toBeGreaterThan(0);
  });

  it("evaluates portable build outputs and fails when a ceiling is exceeded", () => {
    const root = makeTempDir("synara-bundle-portable-");
    try {
      mkdirSync(join(root, "apps/desktop/dist-electron"), { recursive: true });
      mkdirSync(join(root, "apps/server/dist/client/assets"), { recursive: true });
      mkdirSync(join(root, "apps/server/dist/device-helper"), { recursive: true });

      writeFileSync(join(root, "apps/desktop/dist-electron/main.js"), Buffer.alloc(100));
      writeFileSync(join(root, "apps/server/dist/index.mjs"), Buffer.alloc(200));
      // device-helper is excluded from server JS budget
      writeFileSync(join(root, "apps/server/dist/device-helper/helper.swift"), Buffer.alloc(500));
      writeFileSync(join(root, "apps/server/dist/client/index.html"), Buffer.alloc(50));
      writeFileSync(join(root, "apps/server/dist/client/assets/app.js"), Buffer.alloc(150));
      writeFileSync(join(root, "apps/server/dist/client/assets/app.js.gz"), Buffer.alloc(60));
      writeFileSync(join(root, "apps/server/dist/client/assets/font.woff2"), Buffer.alloc(40));

      const passing = evaluatePortableBundleSize(root, {
        desktopMainMaxBytes: 120,
        serverDistMaxBytes: 250,
        webClientMaxBytes: 300,
        webClientFontsMaxBytes: 50,
        webClientPrecompressedMaxBytes: 80,
      });
      expect(passing.passed).toBe(true);
      expect(passing.errors).toEqual([]);
      expect(passing.checks.map((c) => [c.name, c.actualBytes])).toEqual([
        ["desktop dist-electron", 100],
        ["server dist (JS/runtime)", 200],
        ["web client (uncompressed)", 240],
        ["web client fonts", 40],
        ["web client precompressed (.gz/.br)", 60],
      ]);

      const failing = evaluatePortableBundleSize(root, {
        desktopMainMaxBytes: 120,
        serverDistMaxBytes: 150,
        webClientMaxBytes: 300,
        webClientFontsMaxBytes: 30,
        webClientPrecompressedMaxBytes: 80,
      });
      expect(failing.passed).toBe(false);
      expect(failing.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual([
        "server dist (JS/runtime)",
        "web client fonts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("evaluates packaged release artifacts and optional app bundle payloads", () => {
    const root = makeTempDir("synara-bundle-packaged-");
    try {
      const assetsDir = join(root, "assets");
      const appDir = join(root, "Synara.app");
      mkdirSync(assetsDir, { recursive: true });
      mkdirSync(join(appDir, "Contents/Resources"), { recursive: true });

      writeFileSync(join(assetsDir, "Synara-1.1.0-arm64.dmg"), Buffer.alloc(500));
      writeFileSync(join(assetsDir, "Synara-1.1.0-arm64.zip"), Buffer.alloc(400));
      writeFileSync(join(appDir, "Contents/Resources/app.asar"), Buffer.alloc(300));
      writeFileSync(join(appDir, "Contents/Resources/extra.bin"), Buffer.alloc(200));

      const budgets = {
        "mac-arm64": {
          installerMaxBytes: 600,
          updateZipMaxBytes: 450,
          appAsarMaxBytes: 350,
          installedAppMaxBytes: 600,
        },
      };

      const pass = evaluatePackagedBundleSize({
        platform: "mac",
        arch: "arm64",
        assetsDir,
        appDir,
        budgets,
      });
      expect(pass.passed).toBe(true);

      const fail = evaluatePackagedBundleSize({
        platform: "mac",
        arch: "arm64",
        assetsDir,
        appDir,
        budgets: {
          "mac-arm64": {
            installerMaxBytes: 400,
            updateZipMaxBytes: 450,
            appAsarMaxBytes: 250,
            installedAppMaxBytes: 600,
          },
        },
      });
      expect(fail.passed).toBe(false);
      expect(fail.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual([
        "mac-arm64 installer (.dmg)",
        "mac-arm64 app.asar",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates CLI arguments for portable and packaged modes", () => {
    expect(parseBundleSizeArgs([]).mode).toBe("portable");
    expect(() => parseBundleSizeArgs(["--mode", "packaged"])).toThrow(/requires --platform/);
    expect(() => parseBundleSizeArgs(["--unknown", "1"])).toThrow(/Unknown argument/);
    const packaged = parseBundleSizeArgs([
      "--mode",
      "packaged",
      "--platform",
      "linux",
      "--arch",
      "x64",
      "--assets-dir",
      "release-publish",
    ]);
    expect(packaged.mode).toBe("packaged");
    expect(packaged.platform).toBe("linux");
    expect(packaged.arch).toBe("x64");
  });
});
