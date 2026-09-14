// FILE: homebrew-cask.ts
// Purpose: Renders the official Homebrew Cask for the signed macOS Synara DMG.
// Layer: Release/packaging helper
// Depends on: desktop artifact names and production desktop identity.

import { SYNARA_PRODUCTION_BUNDLE_ID, synaraDesktopIdentity } from "@synara/shared/desktopIdentity";

import { desktopArtifactFileName } from "./desktop-artifact-names.ts";

export const HOMEBREW_CASK_TOKEN = "synara";
export const HOMEBREW_CASK_NAME = "Synara";
export const HOMEBREW_CASK_DESC = "Desktop workspace for coding agents";
export const HOMEBREW_CASK_HOMEPAGE = "https://www.trysynara.com/";
export const HOMEBREW_CASK_GITHUB_REPO = "Emanuele-web04/synara";
export const HOMEBREW_CASK_RELATIVE_PATH = "packaging/homebrew/Casks/synara.rb";
export const HOMEBREW_CASK_MACOS_SYMBOL = ":ventura";
export const HOMEBREW_CASK_INSTALL_COMMAND = "brew install --cask synara";

const PRODUCTION_IDENTITY = synaraDesktopIdentity("production");

export interface HomebrewCaskChecksums {
  readonly arm64: string;
  readonly x64: string;
}

export interface HomebrewCaskInput {
  readonly version: string;
  readonly sha256: HomebrewCaskChecksums;
}

export function normalizeHomebrewCaskVersion(version: string): string {
  const trimmed = version.trim();
  if (trimmed.length === 0) {
    throw new Error("Homebrew cask version must not be empty.");
  }
  return trimmed.replace(/^v/i, "");
}

export function homebrewCaskDmgFileName(version: string, arch: "arm64" | "x64"): string {
  return desktopArtifactFileName({
    version: normalizeHomebrewCaskVersion(version),
    arch,
    ext: "dmg",
  });
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
    throw new Error("Homebrew cask SHA-256 values must be 64 lowercase hex characters.");
  }

  const url = `https://github.com/${HOMEBREW_CASK_GITHUB_REPO}/releases/download/v#{version}/Synara-#{version}-#{arch}.dmg`;

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
