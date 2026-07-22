#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptsDirectory = dirname(scriptPath);
const desktopDirectory = resolve(scriptsDirectory, "..");
const sourceDirectory = join(desktopDirectory, "native", "synara-island-helper");
const minimumMacOSVersion = "13.0";

export const defaultIslandHelperPath = join(
  desktopDirectory,
  ".electron-runtime",
  "island",
  "synara-island-helper",
);

const frameworkArguments = [
  "-framework",
  "AppKit",
  "-framework",
  "SwiftUI",
  "-framework",
  "QuartzCore",
];

export function swiftTargetsForArch(arch) {
  switch (arch) {
    case "arm64":
      return [{ arch: "arm64", target: `arm64-apple-macos${minimumMacOSVersion}` }];
    case "x64":
      return [{ arch: "x86_64", target: `x86_64-apple-macos${minimumMacOSVersion}` }];
    case "universal":
      return [
        { arch: "arm64", target: `arm64-apple-macos${minimumMacOSVersion}` },
        { arch: "x86_64", target: `x86_64-apple-macos${minimumMacOSVersion}` },
      ];
    default:
      throw new Error(
        `Unsupported island helper architecture: ${arch}. Expected arm64, x64, or universal.`,
      );
  }
}

export function liquidGlassArgumentsForSdkVersion(sdkVersion) {
  const match = /^(\d+)(?:\.\d+)*$/.exec(sdkVersion);
  if (!match) {
    throw new Error(
      `Could not parse the macOS SDK version reported by xcrun: ${JSON.stringify(sdkVersion)}.`,
    );
  }

  return Number(match[1]) >= 26 ? ["-DSYNARA_HAS_LIQUID_GLASS"] : [];
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: desktopDirectory,
    encoding: "utf8",
    env: options.env ?? process.env,
  });
  if (result.error) {
    throw new Error(`Unable to run the island helper command ${command}: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status === 0) {
    return typeof result.stdout === "string" ? result.stdout.trim() : "";
  }

  const details = [result.stdout, result.stderr]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
  const suffix = details ? `\n${details}` : "";
  throw new Error(
    `Island helper command failed (${command} ${arguments_.join(" ")}): ${result.status ?? "unknown"}${suffix}`,
  );
}

function discoverToolchain() {
  const sdkVersion = run("xcrun", ["--sdk", "macosx", "--show-sdk-version"]);
  const sdkPath = run("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
  const swiftCompilerPath = run("xcrun", ["--find", "swiftc"]);
  const swiftCompilerVersion = run("xcrun", ["swiftc", "--version"]);
  const featureArguments = liquidGlassArgumentsForSdkVersion(sdkVersion);

  if (!sdkPath) {
    throw new Error("xcrun did not report a macOS SDK path for the island helper build.");
  }
  if (!swiftCompilerPath || !swiftCompilerVersion) {
    throw new Error("xcrun did not report a usable Swift compiler for the island helper build.");
  }

  return {
    featureArguments,
    sdkPath,
    sdkVersion,
    swiftCompilerPath,
    swiftCompilerVersion,
  };
}

function readSources() {
  if (!existsSync(sourceDirectory)) {
    throw new Error(`Island helper source directory is missing: ${sourceDirectory}`);
  }

  const sources = readdirSync(sourceDirectory)
    .filter((name) => name.endsWith(".swift"))
    .sort()
    .map((name) => join(sourceDirectory, name));
  if (sources.length === 0) {
    throw new Error(`No Swift sources found in ${sourceDirectory}.`);
  }
  return sources;
}

function buildFingerprint({ arch, release, sources, targets, toolchain }) {
  const hash = createHash("sha256");
  hash.update("synara-island-helper-build-v1\0");
  hash.update(arch);
  hash.update("\0");
  hash.update(release ? "release" : "debug");
  hash.update("\0");
  hash.update(JSON.stringify(targets));
  hash.update("\0");
  hash.update(JSON.stringify(frameworkArguments));
  hash.update("\0");
  hash.update(JSON.stringify(toolchain));
  hash.update("\0");
  hash.update(readFileSync(scriptPath));
  for (const source of sources) {
    hash.update("\0");
    hash.update(source);
    hash.update("\0");
    hash.update(readFileSync(source));
  }
  return hash.digest("hex");
}

function expectedBinaryArchitectures(targets) {
  return targets.map(({ arch }) => arch).sort();
}

function inspectBinaryArchitectures(binaryPath) {
  return run("xcrun", ["lipo", "-archs", binaryPath]).split(/\s+/).filter(Boolean).sort();
}

function verifyBinary(binaryPath, targets) {
  accessSync(binaryPath, constants.X_OK);
  run("codesign", ["--verify", "--strict", binaryPath]);

  const expected = expectedBinaryArchitectures(targets);
  const actual = inspectBinaryArchitectures(binaryPath);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Island helper architecture mismatch at ${binaryPath}: expected ${expected.join(", ")}, found ${actual.join(", ") || "none"}.`,
    );
  }
}

function isUsableCachedBuild(outputPath, metadataPath, fingerprint, targets) {
  if (!existsSync(outputPath) || !existsSync(metadataPath)) {
    return false;
  }

  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (metadata.fingerprint !== fingerprint) {
      return false;
    }
    verifyBinary(outputPath, targets);
    return true;
  } catch {
    return false;
  }
}

export function buildIslandHelper({
  arch = process.arch,
  outputPath = defaultIslandHelperPath,
  release = false,
  quiet = false,
} = {}) {
  if (process.platform !== "darwin") {
    throw new Error("The island helper can only be built on macOS.");
  }

  const targets = swiftTargetsForArch(arch);
  const sources = readSources();
  const toolchain = discoverToolchain();
  const resolvedOutputPath = resolve(outputPath);
  const metadataPath = `${resolvedOutputPath}.build.json`;
  const fingerprint = buildFingerprint({ arch, release, sources, targets, toolchain });

  if (isUsableCachedBuild(resolvedOutputPath, metadataPath, fingerprint, targets)) {
    if (!quiet) {
      console.error(`[island] Reusing ${arch} Swift helper at ${resolvedOutputPath}`);
    }
    return resolvedOutputPath;
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "synara-island-helper-"));
  const moduleCacheDirectory = join(temporaryDirectory, "module-cache");
  const buildEnvironment = {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: moduleCacheDirectory,
    SWIFT_MODULECACHE_PATH: moduleCacheDirectory,
  };

  try {
    const thinBinaries = [];
    for (const target of targets) {
      const thinBinary = join(temporaryDirectory, `synara-island-helper-${target.arch}`);
      const optimizationArguments = release
        ? ["-O", "-whole-module-optimization"]
        : ["-Onone", "-g"];

      run(
        "xcrun",
        [
          "swiftc",
          "-parse-as-library",
          ...optimizationArguments,
          "-module-name",
          "SynaraIslandHelper",
          "-sdk",
          toolchain.sdkPath,
          "-target",
          target.target,
          ...frameworkArguments,
          ...toolchain.featureArguments,
          ...sources,
          "-o",
          thinBinary,
        ],
        { env: buildEnvironment },
      );
      thinBinaries.push(thinBinary);
    }

    const unsignedBinary = join(temporaryDirectory, "synara-island-helper");
    if (thinBinaries.length === 1) {
      copyFileSync(thinBinaries[0], unsignedBinary);
    } else {
      run("xcrun", ["lipo", "-create", ...thinBinaries, "-output", unsignedBinary]);
    }

    // Dev helpers are ad-hoc signed. The packaged helper receives the app's
    // release identity at the packaging boundary.
    run("codesign", ["--force", "--sign", "-", "--timestamp=none", unsignedBinary]);
    verifyBinary(unsignedBinary, targets);

    mkdirSync(dirname(resolvedOutputPath), { recursive: true });
    const pendingOutputPath = `${resolvedOutputPath}.tmp-${process.pid}`;
    const pendingMetadataPath = `${metadataPath}.tmp-${process.pid}`;
    rmSync(pendingOutputPath, { force: true });
    rmSync(pendingMetadataPath, { force: true });

    copyFileSync(unsignedBinary, pendingOutputPath);
    chmodSync(pendingOutputPath, 0o755);
    renameSync(pendingOutputPath, resolvedOutputPath);

    const metadata = {
      arch,
      fingerprint,
      minimumMacOSVersion,
      release,
      sdkVersion: toolchain.sdkVersion,
      swiftCompilerVersion: toolchain.swiftCompilerVersion,
      targets,
    };
    writeFileSync(pendingMetadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    renameSync(pendingMetadataPath, metadataPath);

    if (!quiet) {
      console.error(
        `[island] Built ${arch} Swift helper for macOS ${minimumMacOSVersion}+ at ${resolvedOutputPath}`,
      );
    }
    return resolvedOutputPath;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseCommandLine(arguments_) {
  let arch = process.arch;
  let outputPath = defaultIslandHelperPath;
  let release = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    switch (argument) {
      case "--arch":
        index += 1;
        if (index >= arguments_.length) {
          throw new Error("--arch requires arm64, x64, or universal.");
        }
        arch = arguments_[index];
        break;
      case "--output":
        index += 1;
        if (index >= arguments_.length) {
          throw new Error("--output requires a path.");
        }
        outputPath = arguments_[index];
        break;
      case "--release":
        release = true;
        break;
      default:
        throw new Error(`Unknown island helper build argument: ${argument}`);
    }
  }

  return { arch, outputPath, release };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    buildIslandHelper(parseCommandLine(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
