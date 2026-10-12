// FILE: homebrew-cask.ts
// Purpose: Renders the proposed Homebrew Cask for the signed macOS Synara DMG.
// Layer: Release/packaging helper
// Depends on: desktop artifact names and production desktop identity.

import { SYNARA_PRODUCTION_BUNDLE_ID, synaraDesktopIdentity } from "@synara/shared/desktopIdentity";

import { createDesktopArtifactIdentity } from "./desktop-artifact-identity.ts";

export const HOMEBREW_CASK_TOKEN = "synara";
export const HOMEBREW_CASK_NAME = "Synara";
export const HOMEBREW_CASK_DESC = "Desktop workspace for coding agents";
export const HOMEBREW_CASK_HOMEPAGE = "https://www.trysynara.com/";
export const HOMEBREW_CASK_GITHUB_REPO = "Emanuele-web04/synara";
export const HOMEBREW_CASK_RELATIVE_PATH = "packaging/homebrew/Casks/synara.rb";
// v1.0.1's app plist declares 12.0, but its bundled Claude and Cua Mach-O binaries require 13.0.
export const HOMEBREW_CASK_MACOS_SYMBOL = ":ventura";
export const HOMEBREW_CASK_INSTALL_COMMAND = "brew install --cask synara";

const PRODUCTION_IDENTITY = synaraDesktopIdentity("production");
const PRODUCTION_MAC_ARTIFACT_NAME = createDesktopArtifactIdentity({
  platform: "mac",
  flavor: "production",
}).buildConfig.artifactName;

export interface HomebrewCaskChecksums {
  readonly arm64: string;
  readonly x64: string;
}

export interface HomebrewCaskInput {
  readonly version: string;
  readonly sha256: HomebrewCaskChecksums;
}

export function normalizeHomebrewCaskVersion(version: string): string {
  const normalized = version.trim().replace(/^v/i, "");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(normalized)) {
    throw new Error(
      "Homebrew cask version must be a stable X.Y.Z version, optionally prefixed with v.",
    );
  }
  return normalized;
}

export function homebrewCaskDmgFileName(version: string, arch: "arm64" | "x64"): string {
  return PRODUCTION_MAC_ARTIFACT_NAME.replaceAll(
    "${version}",
    normalizeHomebrewCaskVersion(version),
  )
    .replaceAll("${arch}", arch)
    .replaceAll("${ext}", "dmg");
}

export function homebrewCaskZapTrash(): readonly string[] {
  const bundleId = SYNARA_PRODUCTION_BUNDLE_ID;
  return [
    `~/${PRODUCTION_IDENTITY.defaultHomeDirectoryName}`,
    `~/Library/Application Support/com.apple.sharedfilelist/com.apple.LSSharedFileList.ApplicationRecentDocuments/${bundleId}.sfl*`,
    `~/Library/Application Support/${PRODUCTION_IDENTITY.userDataDirectoryName}`,
    `~/Library/Caches/${bundleId}`,
    `~/Library/Caches/${bundleId}.ShipIt`,
    `~/Library/HTTPStorages/${bundleId}`,
    `~/Library/Logs/${PRODUCTION_IDENTITY.displayName}`,
    `~/Library/Preferences/${bundleId}.plist`,
    `~/Library/Saved Application State/${bundleId}.savedState`,
  ].toSorted((left, right) => left.localeCompare(right));
}

function rubyQuoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function renderZapBlock(): string {
  const lines = homebrewCaskZapTrash().map((path) => `    ${rubyQuoted(path)},`);
  return ["  zap trash: [", ...lines, "  ]"].join("\n");
}

export function renderHomebrewCask(input: HomebrewCaskInput): string {
  const version = normalizeHomebrewCaskVersion(input.version);
  const armSha = input.sha256.arm64.trim().toLowerCase();
  const intelSha = input.sha256.x64.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(armSha) || !/^[0-9a-f]{64}$/.test(intelSha)) {
    throw new Error("Homebrew cask SHA-256 values must be 64 hex characters.");
  }

  const artifactName = PRODUCTION_MAC_ARTIFACT_NAME.replaceAll("${version}", "#{version}")
    .replaceAll("${arch}", "#{arch}")
    .replaceAll("${ext}", "dmg");
  const url = `https://github.com/${HOMEBREW_CASK_GITHUB_REPO}/releases/download/v#{version}/${artifactName}`;

  return `cask "${HOMEBREW_CASK_TOKEN}" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${armSha}",
         intel: "${intelSha}"

  url "${url}",
      verified: "github.com/${HOMEBREW_CASK_GITHUB_REPO}/"
  name "${HOMEBREW_CASK_NAME}"
  desc "${HOMEBREW_CASK_DESC}"
  homepage "${HOMEBREW_CASK_HOMEPAGE}"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  # Bundled Claude and Cua executables require macOS 13.
  depends_on macos: ${HOMEBREW_CASK_MACOS_SYMBOL}

  app "${HOMEBREW_CASK_NAME}.app"

  uninstall quit: "${SYNARA_PRODUCTION_BUNDLE_ID}"

${renderZapBlock()}
end
`;
}

export function parseGitHubReleaseDigest(digest: string | undefined): string {
  const value = digest?.trim() ?? "";
  const match = /^sha256:([0-9a-f]{64})$/i.exec(value);
  const hash = match?.[1];
  if (!hash) {
    throw new Error(`GitHub asset digest must be sha256:<64 hex chars>. Received '${digest}'.`);
  }
  return hash.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function homebrewCaskInputFromGitHubRelease(release: unknown): HomebrewCaskInput {
  if (!isRecord(release) || release.draft !== false || release.prerelease !== false) {
    throw new Error("Homebrew requires a published stable GitHub release.");
  }
  if (typeof release.tag_name !== "string") {
    throw new Error("GitHub latest release did not include tag_name.");
  }
  const version = normalizeHomebrewCaskVersion(release.tag_name);
  if (release.tag_name !== `v${version}`) {
    throw new Error("GitHub release tag must use the canonical vX.Y.Z download path.");
  }
  if (!Array.isArray(release.assets)) {
    throw new Error("GitHub latest release did not include an asset inventory.");
  }
  const assets = release.assets.filter(isRecord);
  const digestFor = (arch: "arm64" | "x64"): string => {
    const fileName = homebrewCaskDmgFileName(version, arch);
    const matches = assets.filter((entry) => entry.name === fileName);
    const asset = matches[0];
    if (matches.length !== 1 || !asset) {
      throw new Error(`Latest GitHub release must contain exactly one ${fileName}.`);
    }
    const expectedUrl = `https://github.com/${HOMEBREW_CASK_GITHUB_REPO}/releases/download/v${version}/${fileName}`;
    if (
      asset.state !== "uploaded" ||
      typeof asset.size !== "number" ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      asset.browser_download_url !== expectedUrl
    ) {
      throw new Error(
        `GitHub asset ${fileName} is not a complete upload at the expected download URL.`,
      );
    }
    return parseGitHubReleaseDigest(typeof asset.digest === "string" ? asset.digest : undefined);
  };
  return { version, sha256: { arm64: digestFor("arm64"), x64: digestFor("x64") } };
}
