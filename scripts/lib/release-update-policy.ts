// FILE: release-update-policy.ts
// Purpose: Enforces the permanent compatibility hop and prepares channel manifests.

import {
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { resolve } from "node:path";

export type ReleaseLane = "bridge" | "clean";

export interface ReleaseUpdatePolicyConfig {
  readonly lane: ReleaseLane;
  readonly bridgeVersion: string;
  readonly channel: string;
}

export interface ResolvedReleaseUpdatePolicy {
  readonly version: string;
  readonly tag: string;
  readonly isPrerelease: boolean;
  readonly makeLatest: boolean;
  readonly mirrorToStableChannel: boolean;
  readonly lane: ReleaseLane;
  readonly bridgeTag: string;
  readonly channel: string;
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const CHANNEL_PATTERN = /^[a-z0-9-]+$/;

function parseVersion(value: string): { core: readonly number[]; isPrerelease: boolean } {
  const match = VERSION_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid release version: ${value}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    isPrerelease: match[4] !== undefined,
  };
}

function compareCoreVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function validateReleaseUpdatePolicyConfig(config: unknown): ReleaseUpdatePolicyConfig {
  if (typeof config !== "object" || config === null) {
    throw new Error("Release update policy must be an object.");
  }
  const candidate = config as Partial<ReleaseUpdatePolicyConfig>;
  if (candidate.lane !== "bridge" && candidate.lane !== "clean") {
    throw new Error(`Invalid release lane: ${String(candidate.lane)}`);
  }
  if (typeof candidate.bridgeVersion !== "string") {
    throw new Error("Compatibility release version must be a string.");
  }
  parseVersion(candidate.bridgeVersion);
  if (
    typeof candidate.channel !== "string" ||
    !CHANNEL_PATTERN.test(candidate.channel) ||
    candidate.channel === "latest"
  ) {
    throw new Error(`Invalid dedicated update channel: ${String(candidate.channel)}`);
  }
  return candidate as ReleaseUpdatePolicyConfig;
}

export function readReleaseUpdatePolicyConfig(rootDirectory: string): ReleaseUpdatePolicyConfig {
  const path = resolve(rootDirectory, "scripts/release-update-policy.json");
  return validateReleaseUpdatePolicyConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function resolveReleaseUpdatePolicy(
  rawVersion: string,
  config: ReleaseUpdatePolicyConfig,
): ResolvedReleaseUpdatePolicy {
  const normalizedConfig = validateReleaseUpdatePolicyConfig(config);
  const version = rawVersion.startsWith("v") ? rawVersion.slice(1) : rawVersion;
  const requested = parseVersion(version);
  const bridge = parseVersion(normalizedConfig.bridgeVersion);

  if (normalizedConfig.lane === "bridge" && version !== normalizedConfig.bridgeVersion) {
    throw new Error(
      `The compatibility lane may publish only v${normalizedConfig.bridgeVersion}, not v${version}.`,
    );
  }
  if (normalizedConfig.lane === "clean" && compareCoreVersions(requested.core, bridge.core) <= 0) {
    throw new Error(
      `Synara releases must be newer than the compatibility release v${normalizedConfig.bridgeVersion}.`,
    );
  }

  return {
    version,
    tag: `v${version}`,
    isPrerelease: requested.isPrerelease,
    makeLatest: normalizedConfig.lane === "bridge",
    mirrorToStableChannel: normalizedConfig.lane === "clean" && !requested.isPrerelease,
    lane: normalizedConfig.lane,
    bridgeTag: `v${normalizedConfig.bridgeVersion}`,
    channel: normalizedConfig.channel,
  };
}

export function channelManifestNames(channel: string): readonly string[] {
  if (!CHANNEL_PATTERN.test(channel) || channel === "latest") {
    throw new Error(`Invalid dedicated update channel: ${channel}`);
  }
  return [`${channel}-mac.yml`, `${channel}.yml`, `${channel}-linux.yml`];
}

export function prepareReleaseUpdateManifests(
  assetDirectory: string,
  config: ReleaseUpdatePolicyConfig,
): readonly string[] {
  const normalizedConfig = validateReleaseUpdatePolicyConfig(config);
  const sourceNames = ["latest-mac.yml", "latest.yml", "latest-linux.yml"] as const;
  const destinationNames = channelManifestNames(normalizedConfig.channel);
  if (normalizedConfig.lane === "bridge") {
    const missing = sourceNames.filter((name) => !existsSync(resolve(assetDirectory, name)));
    if (missing.length > 0) {
      throw new Error(`Compatibility release is missing update manifests: ${missing.join(", ")}`);
    }
    const existing = destinationNames.filter((name) => existsSync(resolve(assetDirectory, name)));
    if (existing.length > 0) {
      throw new Error(`Refusing to overwrite existing update manifest: ${existing.join(", ")}`);
    }
    for (const [index, sourceName] of sourceNames.entries()) {
      const destinationName = destinationNames[index];
      if (!destinationName) throw new Error(`Missing channel manifest mapping for ${sourceName}.`);
      copyFileSync(
        resolve(assetDirectory, sourceName),
        resolve(assetDirectory, destinationName),
        constants.COPYFILE_EXCL,
      );
    }
    return [...sourceNames, ...destinationNames];
  }

  const renamed: string[] = [];
  for (const [index, sourceName] of sourceNames.entries()) {
    const sourcePath = resolve(assetDirectory, sourceName);
    if (!existsSync(sourcePath)) continue;
    const destinationName = destinationNames[index];
    if (!destinationName) throw new Error(`Missing channel manifest mapping for ${sourceName}.`);
    const destinationPath = resolve(assetDirectory, destinationName);
    if (existsSync(destinationPath)) {
      throw new Error(`Refusing to overwrite existing update manifest: ${destinationName}`);
    }
    renameSync(sourcePath, destinationPath);
    renamed.push(destinationName);
  }

  const remainingDefaultManifests = readdirSync(assetDirectory).filter((name) =>
    /^latest(?:-mac|-linux)?\.yml$/.test(name),
  );
  if (remainingDefaultManifests.length > 0) {
    throw new Error(
      `Clean releases cannot publish default-channel manifests: ${remainingDefaultManifests.join(", ")}`,
    );
  }
  if (renamed.length !== sourceNames.length) {
    throw new Error(
      `Expected ${sourceNames.length} update manifests, prepared ${renamed.length}: ${renamed.join(", ")}`,
    );
  }
  return renamed;
}
