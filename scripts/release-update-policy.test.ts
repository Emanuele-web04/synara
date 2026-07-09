import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("release update policy", () => {
  it("keeps the compatibility release latest and every clean release off latest", () => {
    expect(resolveReleaseUpdatePolicy("0.4.2", { ...cleanConfig, lane: "bridge" })).toMatchObject({
      tag: "v0.4.2",
      lane: "bridge",
      makeLatest: true,
      mirrorToStableChannel: false,
    });
    expect(resolveReleaseUpdatePolicy("v0.5.0", cleanConfig)).toMatchObject({
      tag: "v0.5.0",
      lane: "clean",
      makeLatest: false,
      mirrorToStableChannel: true,
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

  it("renames all clean metadata to platform-specific channel filenames", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-release-policy-"));
    try {
      mkdirSync(root, { recursive: true });
      for (const name of ["latest-mac.yml", "latest.yml", "latest-linux.yml"]) {
        writeFileSync(resolve(root, name), name);
      }

      expect(prepareReleaseUpdateManifests(root, cleanConfig)).toEqual(
        channelManifestNames("synara"),
      );
      for (const name of channelManifestNames("synara")) {
        expect(readFileSync(resolve(root, name), "utf8")).toContain("latest");
      }
      expect(() => prepareReleaseUpdateManifests(root, cleanConfig)).toThrow(
        "Expected 3 update manifests",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves default metadata in place on the compatibility release", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-release-policy-"));
    try {
      for (const name of ["latest-mac.yml", "latest.yml", "latest-linux.yml"]) {
        writeFileSync(resolve(root, name), "bridge");
      }
      expect(prepareReleaseUpdateManifests(root, { ...cleanConfig, lane: "bridge" })).toEqual([
        "latest-mac.yml",
        "latest.yml",
        "latest-linux.yml",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
