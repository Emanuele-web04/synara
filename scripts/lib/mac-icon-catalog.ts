// FILE: mac-icon-catalog.ts
// Purpose: One definition of the release Icon Composer compile, its exact cache
//          identity, and the checks a cached catalog must pass before reuse.
// Layer: Release/build helper. Dependency-free on purpose: the release restore
//        job computes the key on Linux before any dependency install.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { desktopIconAssetPaths } from "./brand-assets.ts";

// macOS 26 reads CFBundleIconName out of Assets.car and renders that layered
// icon with the Liquid Glass material; older releases keep using the ICNS.
export const MAC_ICON_ASSET_NAME = "Synara";
export const MAC_ICON_COMPOSER_DEPLOYMENT_TARGET = "26.0";
export const MAC_ICON_CATALOG_FILE = "Assets.car";
export const MAC_ICON_PROVENANCE_FILE = "provenance.json";
// Icon Composer needs macOS 26 frameworks (AssetRuntime crashed on macOS 15);
// native code keeps the macOS 15 SDK. Producer and release compile here only.
export const MAC_ICON_RELEASE_RUNNER = "macos-26";
export const MAC_ICON_RELEASE_XCODE_VERSION = "26.3";
export const MAC_ICON_RELEASE_DEVELOPER_DIR = `/Applications/Xcode_${MAC_ICON_RELEASE_XCODE_VERSION}.app/Contents/Developer`;
// Every packaged flavor; scripts/mac-icon-catalog.test.ts keeps this equal to
// SYNARA_PACKAGED_DESKTOP_FLAVORS, which this file cannot import before install.
export const MAC_ICON_FLAVORS = ["production", "canary", "cua", "beta", "remote"] as const;
export type MacIconFlavor = (typeof MAC_ICON_FLAVORS)[number];

const KEY_PATTERN = /^mac-icon-v1-[a-f0-9]{64}$/;
// The key covers the code that computes it and runs the compile.
const LOGIC_FILES = ["scripts/lib/mac-icon-catalog.ts", "scripts/mac-icon-catalog.ts"] as const;

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export function parseMacIconFlavor(value: string | undefined): MacIconFlavor {
  const flavor = MAC_ICON_FLAVORS.find((candidate) => candidate === value);
  if (!flavor) throw new Error(`Unknown macOS icon flavor: ${value ?? "(missing)"}.`);
  return flavor;
}

export function macIconActoolArguments(
  source: string,
  outputDirectory: string,
  partialInfoPlist: string,
): string[] {
  return [
    "actool",
    source,
    "--compile",
    outputDirectory,
    "--platform",
    "macosx",
    "--minimum-deployment-target",
    MAC_ICON_COMPOSER_DEPLOYMENT_TARGET,
    "--app-icon",
    MAC_ICON_ASSET_NAME,
    "--include-all-app-icons",
    "--output-partial-info-plist",
    partialInfoPlist,
    "--output-format",
    "human-readable-text",
  ];
}

// Relative POSIX path -> SHA-256 of every file in the Icon Composer source.
// Links and special files are refused: their bytes are not part of the tree.
export function hashIconSourceTree(repoRoot: string, source: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (relative: string) => {
    const absolute = join(repoRoot, relative);
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute).toSorted()) visit(`${relative}/${entry}`);
    } else if (stat.isFile()) {
      files[relative] = sha256(readFileSync(absolute));
    } else {
      throw new Error(`Icon Composer source contains a non-regular file: ${relative}`);
    }
  };
  visit(source);
  if (Object.keys(files).length === 0) throw new Error(`Icon Composer source is empty: ${source}`);
  return files;
}

export function collectMacIconCatalogInputs(repoRoot: string, flavor: MacIconFlavor) {
  const source = desktopIconAssetPaths(flavor).macIconComposer;
  return {
    source,
    files: hashIconSourceTree(repoRoot, source),
    actool: macIconActoolArguments("<source>", "<output>", "<partial-info-plist>"),
    runner: MAC_ICON_RELEASE_RUNNER,
    xcodeVersion: MAC_ICON_RELEASE_XCODE_VERSION,
    developerDir: MAC_ICON_RELEASE_DEVELOPER_DIR,
    logic: Object.fromEntries(
      LOGIC_FILES.map((path) => [path, sha256(readFileSync(join(repoRoot, path)))]),
    ),
  };
}

export function macIconCatalogKey(inputs: unknown): string {
  return `mac-icon-v1-${sha256(JSON.stringify(inputs))}`;
}

export interface MacIconCatalogProvenance {
  readonly key: string;
  readonly source: string;
  readonly catalogSha256: string;
  /** `xcodebuild -version` on the compiling runner. */
  readonly xcode: string;
  /** `actool --version` on the compiling runner. */
  readonly actool: string;
  /** `sw_vers` product and build version on the compiling runner. */
  readonly macos: string;
}

// A cached directory is accepted only when it holds exactly the catalog and its
// provenance for this key, the catalog bytes match, and the producer recorded
// the pinned Xcode. Anything else fails closed instead of compiling around it.
export function verifyMacIconCatalogDirectory(
  directory: string,
  expected: { readonly key: string; readonly source: string },
): MacIconCatalogProvenance {
  if (!KEY_PATTERN.test(expected.key)) throw new Error("Invalid macOS icon catalog key.");
  const entries = readdirSync(directory).toSorted();
  const allowed = [MAC_ICON_CATALOG_FILE, MAC_ICON_PROVENANCE_FILE].toSorted();
  if (JSON.stringify(entries) !== JSON.stringify(allowed))
    throw new Error(`Unexpected macOS icon catalog contents: ${entries.join(", ")}`);
  const provenance = JSON.parse(
    readFileSync(join(directory, MAC_ICON_PROVENANCE_FILE), "utf8"),
  ) as MacIconCatalogProvenance;
  if (provenance.key !== expected.key)
    throw new Error("macOS icon catalog was built for a different key.");
  if (provenance.source !== expected.source)
    throw new Error("macOS icon catalog was built from a different Icon Composer source.");
  if (!`${provenance.xcode}\n`.startsWith(`Xcode ${MAC_ICON_RELEASE_XCODE_VERSION}\n`))
    throw new Error("macOS icon catalog was not compiled with the pinned Xcode.");
  const catalog = readFileSync(join(directory, MAC_ICON_CATALOG_FILE));
  // Compiled asset catalogs are BOM stores; an empty or truncated file is not an icon.
  if (catalog.subarray(0, 8).toString("latin1") !== "BOMStore")
    throw new Error("macOS icon catalog is not a compiled asset catalog.");
  if (sha256(catalog) !== provenance.catalogSha256)
    throw new Error("macOS icon catalog bytes do not match their provenance.");
  return provenance;
}
