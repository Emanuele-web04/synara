// FILE: release-update-policy.ts
// Purpose: Resolves release identities and updater manifests while keeping
// Stable, Beta and Remote feeds isolated from the historical compatibility line.

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
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
  readonly desktopFlavor: "production" | "beta" | "remote";
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const CHANNEL_PATTERN = /^[a-z0-9-]+$/;

function parseVersion(value: string): {
  core: readonly number[];
  isPrerelease: boolean;
  prereleaseId: string | null;
} {
  const match = VERSION_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid release version: ${value}`);
  const prerelease = match[4];
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    isPrerelease: prerelease !== undefined,
    prereleaseId: prerelease?.split(".")[0] ?? null,
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

  // Isolated prereleases resolve their package and updater channel together.
  const prereleaseFlavor =
    requested.prereleaseId === "beta" || requested.prereleaseId === "remote"
      ? requested.prereleaseId
      : undefined;

  return {
    version,
    tag: `v${version}`,
    isPrerelease: requested.isPrerelease,
    makeLatest: normalizedConfig.lane === "clean" && !requested.isPrerelease,
    mirrorToStableChannel: false,
    lane: normalizedConfig.lane,
    bridgeTag: `v${normalizedConfig.bridgeVersion}`,
    channel: prereleaseFlavor ?? normalizedConfig.channel,
    desktopFlavor: prereleaseFlavor ?? "production",
  };
}

export function channelManifestNames(channel: string): readonly string[] {
  if (!CHANNEL_PATTERN.test(channel) || channel === "latest") {
    throw new Error(`Invalid dedicated update channel: ${channel}`);
  }
  return [`${channel}-mac.yml`, `${channel}.yml`, `${channel}-linux.yml`];
}

/**
 * The staged arm64 Linux manifest. electron-builder already writes this name
 * for an arm64 build (`latest` channel plus the `-linux-arm64` suffix), so the
 * build script does not retarget it; it only has to be published under the
 * dedicated channel name as well.
 */
export const LINUX_ARM64_UPDATE_MANIFEST = "latest-linux-arm64.yml";

/**
 * Dedicated arm64 Linux feed for a channel. electron-updater derives Linux
 * manifest names as `<channel>-linux` plus `-<arch>` for any architecture other
 * than x64, so `synara` resolves to `synara-linux-arm64.yml` on arm64.
 */
export function linuxArm64ChannelManifestName(channel: string): string {
  if (!CHANNEL_PATTERN.test(channel) || channel === "latest") {
    throw new Error(`Invalid dedicated update channel: ${channel}`);
  }
  return `${channel}-linux-arm64.yml`;
}

interface LinuxArm64ManifestPlan {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly destinationName: string;
}

/**
 * Resolves the arm64 feed without touching the directory, so a release either
 * publishes every channel manifest or none.
 */
function planLinuxArm64Manifest(
  assetDirectory: string,
  channel: string,
  required: boolean,
): LinuxArm64ManifestPlan | null {
  const sourcePath = resolve(assetDirectory, LINUX_ARM64_UPDATE_MANIFEST);
  if (!existsSync(sourcePath)) {
    if (required) {
      throw new Error(
        `Release is missing the Linux arm64 update manifest: ${LINUX_ARM64_UPDATE_MANIFEST}`,
      );
    }
    return null;
  }
  const destinationName = linuxArm64ChannelManifestName(channel);
  const destinationPath = resolve(assetDirectory, destinationName);
  if (existsSync(destinationPath)) {
    throw new Error(`Refusing to overwrite existing update manifest: ${destinationName}`);
  }
  validateLinuxArm64Manifest(assetDirectory, sourcePath);
  return { sourcePath, destinationPath, destinationName };
}

interface UpdaterManifest {
  readonly version?: unknown;
  readonly files?: ReadonlyArray<{ url?: unknown; size?: unknown; sha512?: unknown }>;
  readonly path?: unknown;
  readonly sha512?: unknown;
}

function readUpdaterManifest(path: string): UpdaterManifest | null {
  // Release preflight resolves version policy before installing dependencies.
  const { parse } = createRequire(import.meta.url)("yaml") as typeof import("yaml");
  return parse(readFileSync(path, "utf8"), { maxAliasCount: 0 }) as UpdaterManifest | null;
}

/** Validate the builder's feed against the bytes selected for publication. */
function validateLinuxArm64Manifest(assetDirectory: string, manifestPath: string): void {
  const version = readUpdaterManifest(resolve(assetDirectory, "latest-linux.yml"))?.version;
  const manifest = readUpdaterManifest(manifestPath);
  if (typeof version !== "string" || !version || manifest?.version !== version) {
    throw new Error(
      `Linux arm64 update manifest version ${manifest?.version || "(missing)"} does not match latest-linux.yml ${version || "(missing)"}.`,
    );
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== 1) {
    throw new Error("Linux arm64 update manifest must list exactly one AppImage.");
  }
  const file = manifest.files[0];
  if (typeof file?.url !== "string" || !/^[\w.-]+-arm64\.AppImage$/.test(file.url)) {
    throw new Error(`Linux arm64 update manifest points at a non-arm64 payload: ${file?.url}.`);
  }
  if (manifest.path !== file.url || manifest.sha512 !== file.sha512) {
    throw new Error("Linux arm64 update manifest has conflicting AppImage metadata.");
  }

  const artifactPath = resolve(assetDirectory, file.url);
  let artifact: number;
  try {
    artifact = openSync(artifactPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (cause) {
    throw new Error(`Cannot open staged AppImage: ${file.url}.`, { cause });
  }
  try {
    const stat = fstatSync(artifact);
    if (!stat.isFile() || stat.size <= 0 || stat.size !== file.size) {
      throw new Error(
        `Linux arm64 update manifest size does not match staged AppImage: ${file.url}.`,
      );
    }
    const hash = createHash("sha512");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead: number;
    while ((bytesRead = readSync(artifact, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (hash.digest("base64") !== file.sha512) {
      throw new Error(
        `Linux arm64 update manifest SHA-512 does not match staged AppImage: ${file.url}.`,
      );
    }
  } finally {
    closeSync(artifact);
  }
}

function writeLinuxArm64Manifest(plan: LinuxArm64ManifestPlan | null): readonly string[] {
  if (!plan) return [];
  copyFileSync(plan.sourcePath, plan.destinationPath, constants.COPYFILE_EXCL);
  // Keep the staged name too: it is the updater's default-channel fallback for
  // arm64, mirroring how x64 keeps `latest-linux.yml` beside `synara-linux.yml`.
  return [plan.destinationName, LINUX_ARM64_UPDATE_MANIFEST];
}

function copyChannelManifests(
  assetDirectory: string,
  sourceNames: readonly string[],
  destinationNames: readonly string[],
): void {
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
}

export function prepareReleaseUpdateManifests(
  assetDirectory: string,
  config: ReleaseUpdatePolicyConfig,
  channelOverride?: string,
): readonly string[] {
  const normalizedConfig = validateReleaseUpdatePolicyConfig(config);
  const channel = channelOverride ?? normalizedConfig.channel;
  if (channel === "remote") {
    // Remote requires all supported platforms, with no Latest/Stable aliases.
    if (normalizedConfig.lane !== "clean")
      throw new Error("Remote releases require the clean release lane.");
    const sourceNames = ["latest-mac.yml", "latest.yml", "latest-linux.yml"];
    const missing = sourceNames.filter((name) => !existsSync(resolve(assetDirectory, name)));
    if (missing.length > 0)
      throw new Error(`Remote release is missing update manifests: ${missing.join(", ")}`);
    const destinationNames = channelManifestNames("remote");
    copyChannelManifests(assetDirectory, sourceNames, destinationNames);
    for (const sourceName of sourceNames) unlinkSync(resolve(assetDirectory, sourceName));
    return destinationNames;
  }
  const sourceNames = ["latest-mac.yml", "latest.yml", "latest-linux.yml"] as const;
  const destinationNames = channelManifestNames(channel);
  if (normalizedConfig.lane === "bridge") {
    const missing = sourceNames.filter((name) => !existsSync(resolve(assetDirectory, name)));
    if (missing.length > 0) {
      throw new Error(`Compatibility release is missing update manifests: ${missing.join(", ")}`);
    }
    // The compatibility release predates arm64 Linux; only an explicit arm64
    // build in this run may contribute a feed.
    const linuxArm64 = planLinuxArm64Manifest(assetDirectory, channel, false);
    copyChannelManifests(assetDirectory, sourceNames, destinationNames);
    return [...sourceNames, ...destinationNames, ...writeLinuxArm64Manifest(linuxArm64)];
  }

  const missing = sourceNames.filter((name) => !existsSync(resolve(assetDirectory, name)));
  if (missing.length > 0) {
    throw new Error(`Latest release is missing update manifests: ${missing.join(", ")}`);
  }
  // Resolve the arm64 feed before any copy so a rejected release directory stays
  // untouched and a published one carries every channel manifest.
  const linuxArm64 = planLinuxArm64Manifest(assetDirectory, channel, true);
  // Stable 0.5.x releases are GitHub Latest, but shipped desktop binaries still
  // request the dedicated `synara` channel. Keep both filenames in the same
  // release so existing installations and new Latest installs use the same feed.
  copyChannelManifests(assetDirectory, sourceNames, destinationNames);
  return [...sourceNames, ...destinationNames, ...writeLinuxArm64Manifest(linuxArm64)];
}
