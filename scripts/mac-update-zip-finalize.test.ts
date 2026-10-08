import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { finalizeMacUpdateZip } from "./lib/mac-update-zip-finalize.ts";
import { parseMacUpdateManifest } from "./merge-mac-update-manifests.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createDmgStage(productName: string, version: string, arch: string, updater: boolean) {
  const root = mkdtempSync(join(tmpdir(), "synara-update-zip-test-"));
  roots.push(root);
  const stage = join(root, "app");
  const dist = join(stage, "dist");
  const appName = `${productName}.app`;
  const app = join(dist, "mac", appName);
  const framework = join(app, "Contents/Frameworks/Electron Framework.framework");
  const current = join(framework, "Versions/A");
  mkdirSync(current, { recursive: true });
  writeFileSync(join(current, "Electron Framework"), "fixture framework bytes\n");
  for (const name of ["Helpers", "Libraries", "Resources"]) mkdirSync(join(current, name));
  symlinkSync("A", join(framework, "Versions/Current"));
  for (const name of ["Electron Framework", "Helpers", "Libraries", "Resources"]) {
    symlinkSync(`Versions/Current/${name}`, join(framework, name));
  }
  writeFileSync(join(app, "Contents/payload.txt"), "final packaged app bytes\n");
  writeFileSync(
    join(stage, "package.json"),
    JSON.stringify({
      productName,
      version,
      build: { mac: { target: ["dmg"] }, publish: updater ? [{ provider: "github" }] : null },
    }),
  );
  const artifactStem = `${productName.replaceAll(" ", "-")}-${version}-${arch}`;
  // Container generation/signing is owned by electron-builder; this fixture
  // exercises the finalizer's real ditto archive and downstream manifest reader.
  writeFileSync(join(dist, `${artifactStem}.dmg`), "DMG fixture\n");
  return { root, stage, dist, appName, artifactStem };
}

describe.runIf(process.platform === "darwin")("macOS update ZIP finalization", () => {
  it.each([
    ["Synara", "1.0.2", "arm64", true],
    ["Synara Beta", "1.0.2-beta.1", "x64", true],
    ["Synara Canary", "1.0.2", "arm64", false],
  ] as const)(
    "creates the final %s ZIP and feed from a DMG-only stage",
    async (productName, version, arch, updater) => {
      const fixture = createDmgStage(productName, version, arch, updater);
      const result = await finalizeMacUpdateZip({
        stageDistDir: fixture.dist,
        signed: false,
        requireUpdateManifest: updater,
      });
      expect(result.zipFileName).toBe(`${fixture.artifactStem}.zip`);
      const bytes = readFileSync(result.zipPath);
      const sha512 = createHash("sha512").update(bytes).digest("base64");
      expect(result.sha512).toBe(sha512);
      expect(result.size).toBe(bytes.length);
      expect(existsSync(`${result.zipPath}.blockmap`)).toBe(false);

      const extracted = join(fixture.root, "extracted");
      execFileSync("ditto", ["-x", "-k", result.zipPath, extracted]);
      const framework = join(
        extracted,
        fixture.appName,
        "Contents/Frameworks/Electron Framework.framework",
      );
      expect(lstatSync(join(framework, "Electron Framework")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(framework, "Versions/Current"))).toBe("A");
      expect(readFileSync(join(framework, "Electron Framework"), "utf8")).toBe(
        "fixture framework bytes\n",
      );
      expect(readFileSync(join(extracted, fixture.appName, "Contents/payload.txt"), "utf8")).toBe(
        "final packaged app bytes\n",
      );

      const manifestPath = join(fixture.dist, "latest-mac.yml");
      expect(existsSync(manifestPath)).toBe(updater);
      if (updater) {
        const manifest = parseMacUpdateManifest(readFileSync(manifestPath, "utf8"), manifestPath);
        expect(manifest.version).toBe(version);
        expect(manifest.files).toEqual([
          { url: `${fixture.artifactStem}.zip`, sha512, size: bytes.length },
        ]);
        expect(Number.isFinite(Date.parse(manifest.releaseDate))).toBe(true);
        expect(result.updatedManifestPaths).toEqual([manifestPath]);
      } else {
        expect(result.updatedManifestPaths).toEqual([]);
      }
    },
  );

  it("requires the app signature before creating a signed update ZIP", async () => {
    const fixture = createDmgStage("Synara", "1.0.2", "arm64", true);
    await expect(
      finalizeMacUpdateZip({ stageDistDir: fixture.dist, signed: true }),
    ).rejects.toThrow("codesign");
    expect(existsSync(join(fixture.dist, `${fixture.artifactStem}.zip`))).toBe(false);
  });

  it("rejects a DMG whose version differs from its retained staging identity", async () => {
    const fixture = createDmgStage("Synara", "1.0.2", "arm64", true);
    const packagePath = join(fixture.stage, "package.json");
    const stagedPackage = JSON.parse(readFileSync(packagePath, "utf8"));
    stagedPackage.version = "1.0.3";
    writeFileSync(packagePath, JSON.stringify(stagedPackage));
    await expect(
      finalizeMacUpdateZip({ stageDistDir: fixture.dist, signed: false }),
    ).rejects.toThrow("does not match its staged package identity");
  });
});
