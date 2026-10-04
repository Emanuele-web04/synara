#!/usr/bin/env node

// Builds the macOS window-material Node-API addon (native/window-material) that lets the
// translucent shell set an adjustable desktop blur. Mirrors the AppSnap helper build:
// cached by source fingerprint, ad-hoc signed for dev, re-signed by electron-builder.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { installSignedBuild, isUsableCachedBuild, run } from "./native-build-cache.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const desktopDirectory = resolve(dirname(scriptPath), "..");
const sourcePath = join(desktopDirectory, "native", "window-material", "WindowMaterial.m");

export const defaultWindowMaterialAddonPath = join(
  desktopDirectory,
  ".electron-runtime",
  "window-material",
  "synara-window-material.node",
);

// Matches the AppSnap helper's deployment target.
const MACOS_DEPLOYMENT_TARGET = "12.3";

function clangArchArguments(arch) {
  switch (arch) {
    case "arm64":
      return ["-arch", "arm64"];
    case "x64":
      return ["-arch", "x86_64"];
    case "universal":
      return ["-arch", "arm64", "-arch", "x86_64"];
    default:
      throw new Error(`Unsupported window-material addon architecture: ${arch}`);
  }
}

export function buildWindowMaterialAddon({
  arch = process.arch,
  outputPath = defaultWindowMaterialAddonPath,
  quiet = false,
} = {}) {
  if (process.platform !== "darwin") {
    throw new Error("The window-material addon can only be built on macOS.");
  }

  const compileArguments = [
    "clang",
    "-x",
    "objective-c",
    "-fobjc-arc",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    ...clangArchArguments(arch),
    `-mmacosx-version-min=${MACOS_DEPLOYMENT_TARGET}`,
    // Node-API symbols resolve against the host Electron binary at load time.
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "-framework",
    "AppKit",
    sourcePath,
  ];
  const resolvedOutputPath = resolve(outputPath);
  const metadataPath = `${resolvedOutputPath}.build.json`;
  const fingerprint = createHash("sha256")
    .update("synara-window-material-addon-build-v1\0")
    .update(JSON.stringify(compileArguments.slice(0, -1)))
    .update("\0")
    .update(readFileSync(scriptPath))
    .update("\0")
    .update(readFileSync(sourcePath))
    .digest("hex");
  if (isUsableCachedBuild(resolvedOutputPath, metadataPath, fingerprint)) {
    if (!quiet) console.error(`[window-material] Reusing ${arch} addon at ${resolvedOutputPath}`);
    return resolvedOutputPath;
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "synara-window-material-"));
  try {
    const unsignedAddon = join(temporaryDirectory, "synara-window-material.node");
    run("xcrun", [...compileArguments, "-o", unsignedAddon], {
      env: { ...process.env, CLANG_MODULE_CACHE_PATH: join(temporaryDirectory, "module-cache") },
    });
    installSignedBuild({
      builtPath: unsignedAddon,
      outputPath: resolvedOutputPath,
      metadataPath,
      fingerprint,
      mode: 0o644,
    });

    if (!quiet) console.error(`[window-material] Built ${arch} addon at ${resolvedOutputPath}`);
    return resolvedOutputPath;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseCommandLine(arguments_) {
  let arch = process.arch;
  let outputPath = defaultWindowMaterialAddonPath;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if ((argument === "--arch" || argument === "--output") && value === undefined) {
      throw new Error(`${argument} requires a value.`);
    }
    if (argument === "--arch") arch = value;
    else if (argument === "--output") outputPath = value;
    // Accepted for parity with the AppSnap helper build; the addon is always optimized.
    else if (argument === "--release") continue;
    else throw new Error(`Unknown window-material addon build argument: ${argument}`);
    index += 1;
  }
  return { arch, outputPath };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    buildWindowMaterialAddon(parseCommandLine(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
