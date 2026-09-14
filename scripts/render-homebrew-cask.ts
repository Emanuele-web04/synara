#!/usr/bin/env node
// FILE: render-homebrew-cask.ts
// Purpose: Prints or writes the official Homebrew Cask from versioned DMG checksums.
// Layer: Release script
// Depends on: scripts/lib/homebrew-cask.ts and optional GitHub Releases API.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOMEBREW_CASK_GITHUB_REPO,
  HOMEBREW_CASK_RELATIVE_PATH,
  homebrewCaskDmgFileName,
  parseGitHubReleaseDigest,
  renderHomebrewCask,
  type HomebrewCaskChecksums,
} from "./lib/homebrew-cask.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type CliOptions = {
  readonly version?: string;
  readonly sha256Arm64?: string;
  readonly sha256X64?: string;
  readonly fromGitHub: boolean;
  readonly write: boolean;
};

function parseArgs(argv: readonly string[]): CliOptions {
  const options: {
    version?: string;
    sha256Arm64?: string;
    sha256X64?: string;
    fromGitHub: boolean;
    write: boolean;
  } = {
    fromGitHub: false,
    write: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--from-github") {
      options.fromGitHub = true;
      continue;
    }
    if (arg === "--write") {
      options.write = true;
      continue;
    }
    if (arg === "--version" && next) {
      options.version = next;
      index += 1;
      continue;
    }
    if (arg === "--sha256-arm64" && next) {
      options.sha256Arm64 = next;
      index += 1;
      continue;
    }
    if (arg === "--sha256-x64" && next) {
      options.sha256X64 = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  return options;
}

type GitHubReleaseAsset = {
  readonly name?: string;
  readonly digest?: string;
};

type GitHubRelease = {
  readonly tag_name?: string;
  readonly assets?: GitHubReleaseAsset[];
};

async function checksumsFromGitHub(): Promise<{
  version: string;
  sha256: HomebrewCaskChecksums;
}> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(
    `https://api.github.com/repos/${HOMEBREW_CASK_GITHUB_REPO}/releases/latest`,
    { headers },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub latest release request failed: ${response.status} ${response.statusText}`,
    );
  }

  const release = (await response.json()) as GitHubRelease;
  const version = release.tag_name;
  if (!version) {
    throw new Error("GitHub latest release did not include tag_name.");
  }

  const assets = release.assets ?? [];
  const digestFor = (arch: "arm64" | "x64"): string => {
    const fileName = homebrewCaskDmgFileName(version, arch);
    const asset = assets.find((entry) => entry.name === fileName);
    if (!asset) {
      throw new Error(`Latest GitHub release is missing ${fileName}.`);
    }
    return parseGitHubReleaseDigest(asset.digest);
  };

  return {
    version,
    sha256: {
      arm64: digestFor("arm64"),
      x64: digestFor("x64"),
    },
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const resolved = options.fromGitHub
    ? await checksumsFromGitHub()
    : {
        version: options.version,
        sha256: {
          arm64: options.sha256Arm64,
          x64: options.sha256X64,
        },
      };

  if (!resolved.version || !resolved.sha256.arm64 || !resolved.sha256.x64) {
    throw new Error(
      "Provide --version --sha256-arm64 --sha256-x64, or pass --from-github to read the latest GitHub Release.",
    );
  }

  const rendered = renderHomebrewCask({
    version: resolved.version,
    sha256: {
      arm64: resolved.sha256.arm64,
      x64: resolved.sha256.x64,
    },
  });

  if (options.write) {
    const outputPath = join(REPO_ROOT, HOMEBREW_CASK_RELATIVE_PATH);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, rendered);
    process.stdout.write(`${outputPath}\n`);
    return;
  }

  process.stdout.write(rendered);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
