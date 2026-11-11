import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  channelManifestNames,
  prepareReleaseUpdateManifests,
  resolveReleaseUpdatePolicy,
  type ReleaseUpdatePolicyConfig,
} from "./lib/release-update-policy";

const cleanConfig: ReleaseUpdatePolicyConfig = {
  lane: "clean",
  bridgeVersion: "0.4.2",
  channel: "synara",
};

const defaultManifestNames = ["latest-mac.yml", "latest.yml", "latest-linux.yml"] as const;

const appImageBytes = Buffer.from("AppImage fixture");
const appImageSha512 = createHash("sha512").update(appImageBytes).digest("base64");

const linuxManifest = (version: string, payload: string) =>
  `version: ${version}\nfiles:\n  - url: ${payload}\n    sha512: ${appImageSha512}\n    size: ${appImageBytes.length}\npath: ${payload}\nsha512: ${appImageSha512}\n`;
const linuxX64Manifest = (version = "1.5.1") =>
  linuxManifest(version, `Synara-${version}-x86_64.AppImage`);
const arm64AppImageName = (version: string) => `Synara-${version}-arm64.AppImage`;
const linuxArm64Manifest = (version = "1.5.1") =>
  linuxManifest(version, arm64AppImageName(version));

function stageLinuxArm64(root: string, version = "1.5.1"): void {
  writeFileSync(resolve(root, arm64AppImageName(version)), appImageBytes);
  writeFileSync(resolve(root, "latest-linux-arm64.yml"), linuxArm64Manifest(version));
}

describe("release update policy", () => {
  it("publishes stable clean releases to Latest and keeps prereleases off it", () => {
    expect(resolveReleaseUpdatePolicy("0.4.2", { ...cleanConfig, lane: "bridge" })).toMatchObject({
      tag: "v0.4.2",
      lane: "bridge",
      makeLatest: false,
      mirrorToStableChannel: false,
    });
    expect(resolveReleaseUpdatePolicy("v0.5.0", cleanConfig)).toMatchObject({
      tag: "v0.5.0",
      lane: "clean",
      makeLatest: true,
      mirrorToStableChannel: false,
      bridgeTag: "v0.4.2",
      channel: "synara",
    });
    expect(resolveReleaseUpdatePolicy("0.6.0-beta.1", cleanConfig)).toMatchObject({
      isPrerelease: true,
      makeLatest: false,
      mirrorToStableChannel: false,
      channel: "beta",
      desktopFlavor: "beta",
    });
  });

  it("routes isolated prerelease identifiers onto their own channel and flavor", () => {
    expect(resolveReleaseUpdatePolicy("0.6.0", cleanConfig)).toMatchObject({
      channel: "synara",
      desktopFlavor: "production",
    });
    expect(resolveReleaseUpdatePolicy("0.6.0-beta.4", cleanConfig)).toMatchObject({
      channel: "beta",
      desktopFlavor: "beta",
      isPrerelease: true,
    });
    expect(resolveReleaseUpdatePolicy("1.0.6-remote.1", cleanConfig)).toMatchObject({
      channel: "remote",
      desktopFlavor: "remote",
      isPrerelease: true,
      makeLatest: false,
      mirrorToStableChannel: false,
    });
    expect(resolveReleaseUpdatePolicy("0.6.0-alpha.1", cleanConfig)).toMatchObject({
      channel: "synara",
      desktopFlavor: "production",
      isPrerelease: true,
    });
    expect(resolveReleaseUpdatePolicy("0.6.0-rc.2", cleanConfig)).toMatchObject({
      channel: "synara",
      desktopFlavor: "production",
      isPrerelease: true,
    });
  });

  it("publishes all Remote platform feeds without exposing Latest or Stable aliases", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-remote-release-policy-"));
    try {
      for (const name of defaultManifestNames)
        writeFileSync(resolve(root, name), "version: 1.0.6-remote.1\n");
      rmSync(resolve(root, "latest-linux.yml"));
      expect(() => prepareReleaseUpdateManifests(root, cleanConfig, "remote")).toThrow(
        "missing update manifests",
      );
      writeFileSync(resolve(root, "latest-linux.yml"), "version: 1.0.6-remote.1\n");
      expect(prepareReleaseUpdateManifests(root, cleanConfig, "remote")).toEqual([
        "remote-mac.yml",
        "remote.yml",
        "remote-linux.yml",
      ]);
      expect(readFileSync(resolve(root, "remote-mac.yml"), "utf8")).toBe(
        "version: 1.0.6-remote.1\n",
      );
      for (const name of [
        ...defaultManifestNames,
        ...channelManifestNames("synara"),
        ...channelManifestNames("beta"),
      ]) {
        expect(existsSync(resolve(root, name))).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("copies manifests under the resolved beta channel name", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-release-policy-"));
    try {
      for (const name of [...defaultManifestNames, "latest-linux-arm64.yml"]) {
        writeFileSync(resolve(root, name), name);
      }
      writeFileSync(resolve(root, "latest-linux.yml"), linuxX64Manifest());
      stageLinuxArm64(root);

      expect(prepareReleaseUpdateManifests(root, cleanConfig, "beta")).toEqual([
        ...defaultManifestNames,
        ...channelManifestNames("beta"),
        "beta-linux-arm64.yml",
        "latest-linux-arm64.yml",
      ]);
      for (const channelName of channelManifestNames("synara")) {
        expect(existsSync(resolve(root, channelName))).toBe(false);
      }
      for (const [index, channelName] of channelManifestNames("beta").entries()) {
        const defaultName = defaultManifestNames[index];
        if (!defaultName) throw new Error(`Missing default manifest mapping for ${channelName}`);
        expect(readFileSync(resolve(root, channelName), "utf8")).toBe(
          readFileSync(resolve(root, defaultName), "utf8"),
        );
      }
      expect(readFileSync(resolve(root, "beta-linux-arm64.yml"), "utf8")).toBe(
        linuxArm64Manifest(),
      );
      expect(existsSync(resolve(root, "latest-linux-arm64.yml"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes one dedicated arm64 Linux feed beside the x86_64 feed", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-release-policy-"));
    try {
      for (const name of defaultManifestNames) writeFileSync(resolve(root, name), name);
      writeFileSync(resolve(root, "latest-linux.yml"), linuxX64Manifest());

      expect(() => prepareReleaseUpdateManifests(root, cleanConfig)).toThrow(
        "missing the Linux arm64 update manifest",
      );

      stageLinuxArm64(root);
      expect(prepareReleaseUpdateManifests(root, cleanConfig)).toEqual([
        ...defaultManifestNames,
        ...channelManifestNames("synara"),
        "synara-linux-arm64.yml",
        "latest-linux-arm64.yml",
      ]);
      expect(readFileSync(resolve(root, "synara-linux.yml"), "utf8")).toBe(linuxX64Manifest());
      expect(readFileSync(resolve(root, "synara-linux-arm64.yml"), "utf8")).toBe(
        linuxArm64Manifest(),
      );
      expect(existsSync(resolve(root, "latest-linux-arm64.yml"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { channel: "synara", version: "1.5.1" },
    { channel: "beta", version: "1.5.2-beta.1" },
  ])("validates the staged AppImage before copying the $channel feed", ({ channel, version }) => {
    const root = mkdtempSync(join(tmpdir(), "synara-release-policy-"));
    try {
      for (const name of defaultManifestNames) writeFileSync(resolve(root, name), name);
      writeFileSync(resolve(root, "latest-linux.yml"), linuxX64Manifest(version));
      stageLinuxArm64(root, version);
      const artifact = resolve(root, arm64AppImageName(version));
      const channelManifest = resolve(root, `${channel}-linux-arm64.yml`);

      rmSync(artifact);
      expect(() => prepareReleaseUpdateManifests(root, cleanConfig, channel)).toThrow(
        "staged AppImage",
      );
      expect(existsSync(channelManifest)).toBe(false);

      writeFileSync(artifact, Buffer.alloc(1));
      expect(() => prepareReleaseUpdateManifests(root, cleanConfig, channel)).toThrow("size");
      expect(existsSync(channelManifest)).toBe(false);

      writeFileSync(artifact, Buffer.alloc(appImageBytes.length));
      expect(() => prepareReleaseUpdateManifests(root, cleanConfig, channel)).toThrow("SHA-512");
      expect(existsSync(channelManifest)).toBe(false);

      writeFileSync(artifact, appImageBytes);
      const manifestPath = resolve(root, "latest-linux-arm64.yml");
      writeFileSync(
        manifestPath,
        linuxArm64Manifest(version).replace("path: Synara-", "path: Other-"),
      );
      expect(() => prepareReleaseUpdateManifests(root, cleanConfig, channel)).toThrow(
        "conflicting AppImage metadata",
      );
      expect(existsSync(channelManifest)).toBe(false);

      writeFileSync(manifestPath, linuxArm64Manifest(version));
      expect(prepareReleaseUpdateManifests(root, cleanConfig, channel)).toContain(
        `${channel}-linux-arm64.yml`,
      );
      expect(readFileSync(channelManifest, "utf8")).toBe(linuxArm64Manifest(version));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an arm64 feed that describes another release or payload", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-release-policy-"));
    try {
      for (const name of defaultManifestNames) writeFileSync(resolve(root, name), name);
      writeFileSync(resolve(root, "latest-linux.yml"), linuxX64Manifest("1.5.1"));
      stageLinuxArm64(root, "1.4.0");

      expect(() => prepareReleaseUpdateManifests(root, cleanConfig)).toThrow(
        "does not match latest-linux.yml",
      );

      writeFileSync(
        resolve(root, "latest-linux-arm64.yml"),
        linuxManifest("1.5.1", "Synara-1.5.1-x86_64.AppImage"),
      );
      expect(() => prepareReleaseUpdateManifests(root, cleanConfig)).toThrow("non-arm64 payload");
      expect(existsSync(resolve(root, "synara-linux-arm64.yml"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the arm64 feed optional for the compatibility release", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-release-policy-"));
    try {
      for (const name of defaultManifestNames) writeFileSync(resolve(root, name), "bridge");

      expect(prepareReleaseUpdateManifests(root, { ...cleanConfig, lane: "bridge" })).toEqual([
        ...defaultManifestNames,
        ...channelManifestNames("synara"),
      ]);
      expect(existsSync(resolve(root, "synara-linux-arm64.yml"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("copies the arm64 feed on a compatibility release that built one", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-release-policy-"));
    try {
      for (const name of defaultManifestNames) writeFileSync(resolve(root, name), "bridge");
      writeFileSync(resolve(root, "latest-linux.yml"), linuxX64Manifest());
      stageLinuxArm64(root);

      expect(prepareReleaseUpdateManifests(root, { ...cleanConfig, lane: "bridge" })).toEqual([
        ...defaultManifestNames,
        ...channelManifestNames("synara"),
        "synara-linux-arm64.yml",
        "latest-linux-arm64.yml",
      ]);
      expect(readFileSync(resolve(root, "synara-linux-arm64.yml"), "utf8")).toBe(
        linuxArm64Manifest(),
      );
      expect(existsSync(resolve(root, "latest-linux-arm64.yml"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves the release directory untouched when one feed already exists", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-release-policy-"));
    try {
      for (const name of defaultManifestNames) writeFileSync(resolve(root, name), name);
      writeFileSync(resolve(root, "latest-linux-arm64.yml"), "arm64");
      writeFileSync(resolve(root, "synara-linux-arm64.yml"), "existing");

      expect(() => prepareReleaseUpdateManifests(root, cleanConfig)).toThrow(
        "Refusing to overwrite existing update manifest: synara-linux-arm64.yml",
      );
      expect(existsSync(resolve(root, "synara-mac.yml"))).toBe(false);
      expect(existsSync(resolve(root, "latest-linux-arm64.yml"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the staged arm64 feed when a legacy channel manifest already exists", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-release-policy-"));
    try {
      for (const name of defaultManifestNames) writeFileSync(resolve(root, name), name);
      writeFileSync(resolve(root, "latest-linux.yml"), linuxX64Manifest());
      stageLinuxArm64(root);
      writeFileSync(resolve(root, "synara.yml"), "existing");

      expect(() => prepareReleaseUpdateManifests(root, cleanConfig)).toThrow(
        "Refusing to overwrite existing update manifest: synara.yml",
      );
      expect(existsSync(resolve(root, "latest-linux-arm64.yml"))).toBe(true);
      expect(existsSync(resolve(root, "synara-linux-arm64.yml"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects releases that could bypass or replace the compatibility hop", () => {
    expect(() => resolveReleaseUpdatePolicy("0.5.0", { ...cleanConfig, lane: "bridge" })).toThrow(
      "may publish only",
    );
    expect(() => resolveReleaseUpdatePolicy("0.4.2", cleanConfig)).toThrow("must be newer");
    expect(() => resolveReleaseUpdatePolicy("0.4.1", cleanConfig)).toThrow("must be newer");
    expect(() => resolveReleaseUpdatePolicy("0.4.0", cleanConfig)).toThrow("must be newer");
    expect(() => resolveReleaseUpdatePolicy("0.5.0.not-semver", cleanConfig)).toThrow(
      "Invalid release version",
    );
  });

  it("keeps clean release metadata on Latest and dedicated channel filenames", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-release-policy-"));
    try {
      mkdirSync(root, { recursive: true });
      for (const name of defaultManifestNames) {
        writeFileSync(resolve(root, name), name);
      }
      writeFileSync(resolve(root, "latest-linux.yml"), linuxX64Manifest());
      stageLinuxArm64(root);

      expect(prepareReleaseUpdateManifests(root, cleanConfig)).toEqual([
        ...defaultManifestNames,
        ...channelManifestNames("synara"),
        "synara-linux-arm64.yml",
        "latest-linux-arm64.yml",
      ]);
      for (const name of defaultManifestNames) {
        expect(readFileSync(resolve(root, name), "utf8")).toBe(
          name === "latest-linux.yml" ? linuxX64Manifest() : name,
        );
      }
      for (const [index, channelName] of channelManifestNames("synara").entries()) {
        const defaultName = defaultManifestNames[index];
        if (!defaultName) throw new Error(`Missing default manifest mapping for ${channelName}`);
        expect(readFileSync(resolve(root, channelName), "utf8")).toBe(
          readFileSync(resolve(root, defaultName), "utf8"),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps default metadata and copies same-version channel placeholders on the compatibility release", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-release-policy-"));
    try {
      for (const name of defaultManifestNames) {
        writeFileSync(resolve(root, name), `bridge:${name}`);
      }
      expect(prepareReleaseUpdateManifests(root, { ...cleanConfig, lane: "bridge" })).toEqual([
        ...defaultManifestNames,
        ...channelManifestNames("synara"),
      ]);
      for (const [index, channelName] of channelManifestNames("synara").entries()) {
        const defaultName = defaultManifestNames[index];
        if (!defaultName) throw new Error(`Missing default manifest mapping for ${channelName}`);
        expect(readFileSync(resolve(root, channelName), "utf8")).toBe(
          readFileSync(resolve(root, defaultName), "utf8"),
        );
      }
      for (const name of defaultManifestNames) {
        expect(existsSync(resolve(root, name))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a compatibility channel placeholder", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-release-policy-"));
    try {
      for (const name of defaultManifestNames) {
        writeFileSync(resolve(root, name), "bridge");
      }
      writeFileSync(resolve(root, "synara-mac.yml"), "existing");

      expect(() => prepareReleaseUpdateManifests(root, { ...cleanConfig, lane: "bridge" })).toThrow(
        "Refusing to overwrite existing update manifest: synara-mac.yml",
      );
      expect(existsSync(resolve(root, "synara.yml"))).toBe(false);
      expect(existsSync(resolve(root, "synara-linux.yml"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a clean Latest release with missing default metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-release-policy-"));
    try {
      writeFileSync(resolve(root, "latest-mac.yml"), "bridge");

      expect(() => prepareReleaseUpdateManifests(root, cleanConfig)).toThrow(
        "Latest release is missing update manifests: latest.yml, latest-linux.yml",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
