// FILE: mac-icon-catalog.ts
// Purpose: Fingerprints, compiles and verifies the release macOS icon catalog.
// Usage:
//   node scripts/mac-icon-catalog.ts key --flavor FLAVOR
//   node scripts/mac-icon-catalog.ts compile --flavor FLAVOR --output DIR   (macOS 26, pinned Xcode)
//   node scripts/mac-icon-catalog.ts verify --flavor FLAVOR --dir DIR
// `key` and `verify` run on any host before dependency installation.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectMacIconCatalogInputs,
  MAC_ICON_CATALOG_FILE,
  MAC_ICON_PROVENANCE_FILE,
  MAC_ICON_RELEASE_XCODE_VERSION,
  macIconActoolArguments,
  macIconCatalogKey,
  parseMacIconFlavor,
  verifyMacIconCatalogDirectory,
  type MacIconCatalogProvenance,
} from "./lib/mac-icon-catalog.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...rest] = process.argv.slice(2);
const option = (name: string) => {
  const index = rest.indexOf(name);
  return index < 0 ? undefined : rest[index + 1];
};
const flavor = parseMacIconFlavor(option("--flavor"));
const inputs = collectMacIconCatalogInputs(repoRoot, flavor);
const key = macIconCatalogKey(inputs);
const output = (command: string, args: string[]) =>
  execFileSync(command, args, { encoding: "utf8" }).trim();

if (command === "key") {
  console.log(key);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\n`);
} else if (command === "compile") {
  const destination = option("--output");
  if (!destination) throw new Error("compile requires --output DIR.");
  if (process.platform !== "darwin") throw new Error("The icon catalog compiles only on macOS.");
  const xcode = output("xcodebuild", ["-version"]);
  console.log(xcode);
  if (!`${xcode}\n`.startsWith(`Xcode ${MAC_ICON_RELEASE_XCODE_VERSION}\n`))
    throw new Error(`The icon catalog requires Xcode ${MAC_ICON_RELEASE_XCODE_VERSION}.`);
  const work = mkdtempSync(join(tmpdir(), "synara-mac-icon-"));
  try {
    const compiled = join(work, "compiled");
    mkdirSync(compiled);
    // The .icon folder must be named Synara to match CFBundleIconName.
    execFileSync(
      "xcrun",
      macIconActoolArguments(
        join(repoRoot, inputs.source),
        compiled,
        join(work, "icon-partial.plist"),
      ),
      { stdio: "inherit" },
    );
    // An older actool can exit 0 without writing the catalog: never ship without it.
    const catalog = join(compiled, MAC_ICON_CATALOG_FILE);
    if (!statSync(catalog, { throwIfNoEntry: false })?.size)
      throw new Error(`actool completed without writing ${MAC_ICON_CATALOG_FILE}.`);
    mkdirSync(destination, { recursive: true });
    copyFileSync(catalog, join(destination, MAC_ICON_CATALOG_FILE));
    const provenance: MacIconCatalogProvenance = {
      key,
      source: inputs.source,
      catalogSha256: createHash("sha256")
        .update(readFileSync(join(destination, MAC_ICON_CATALOG_FILE)))
        .digest("hex"),
      xcode,
      actool: output("xcrun", ["actool", "--version", "--output-format", "human-readable-text"]),
      macos: `${output("sw_vers", ["-productVersion"])} (${output("sw_vers", ["-buildVersion"])})`,
    };
    writeFileSync(
      join(destination, MAC_ICON_PROVENANCE_FILE),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );
    verifyMacIconCatalogDirectory(destination, { key, source: inputs.source });
    console.log(`Compiled ${inputs.source} for ${flavor}: ${key}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
} else if (command === "verify") {
  const directory = option("--dir");
  if (!directory) throw new Error("verify requires --dir DIR.");
  const provenance = verifyMacIconCatalogDirectory(directory, { key, source: inputs.source });
  const summary = [
    `macOS icon catalog for ${flavor}: ${key}`,
    `Compiled with ${provenance.xcode.replaceAll("\n", ", ")} on macOS ${provenance.macos}`,
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
} else {
  throw new Error("Usage: node scripts/mac-icon-catalog.ts key|compile|verify --flavor FLAVOR");
}
