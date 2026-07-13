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
    });
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

  it("keeps clean release metadata on the default Latest filenames", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-release-policy-"));
    try {
      mkdirSync(root, { recursive: true });
      for (const name of defaultManifestNames) {
        writeFileSync(resolve(root, name), name);
      }

      expect(prepareReleaseUpdateManifests(root, cleanConfig)).toEqual(defaultManifestNames);
      for (const name of defaultManifestNames) {
        expect(readFileSync(resolve(root, name), "utf8")).toBe(name);
      }
      for (const name of channelManifestNames("synara")) {
        expect(existsSync(resolve(root, name))).toBe(false);
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
