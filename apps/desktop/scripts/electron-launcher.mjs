// This file mostly exists because we want dev mode to say "Synara (Dev)" instead of "electron"

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { resolveSynaraDesktopFlavor, synaraDesktopIdentity } from "@synara/shared/desktopIdentity";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSourceDesktopEnvironment } from "./source-desktop-launch.mjs";

const desktopFlavor = resolveSynaraDesktopFlavor({
  // Packaged apps launch their bundled main directly; this launcher is source-only.
  isDevelopment: true,
  requestedFlavor: process.env.SYNARA_DESKTOP_FLAVOR,
});
const desktopIdentity = synaraDesktopIdentity(desktopFlavor);
const APP_DISPLAY_NAME = desktopIdentity.displayName;
const APP_BUNDLE_ID = desktopIdentity.bundleId;
const LAUNCHER_VERSION = 4;
const MICROPHONE_USAGE_DESCRIPTION =
  "Synara needs microphone access so you can record voice notes and transcribe them into the chat composer.";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const desktopDir = resolve(__dirname, "..");
const bootstrapPath = join(__dirname, "source-desktop-bootstrap.cjs");

export function configureMacLauncher(electronPath, environment = process.env) {
  const bundle = resolve(electronPath, "../../..");
  const configurationPath = join(dirname(bundle), `${basename(bundle)}.launch.json`);
  const sourceEnvironment = createSourceDesktopEnvironment({ environment });
  const configuration = Object.fromEntries(
    [
      "SYNARA_HOME",
      "SYNARA_DESKTOP_FLAVOR",
      "SYNARA_SOURCE_DESKTOP_BUILD_MARKER",
      "VITE_DEV_SERVER_URL",
    ].flatMap((name) =>
      sourceEnvironment[name] === undefined ? [] : [[name, sourceEnvironment[name]]],
    ),
  );
  // Keep mutable launch settings outside the signed bundle: changing a renderer
  // port or home directory must not invalidate previously granted permissions.
  const temporaryPath = `${configurationPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(configuration), { mode: 0o600 });
  renameSync(temporaryPath, configurationPath);
}

function setPlistString(plistPath, key, value, runCommand) {
  const replaceResult = runCommand("plutil", ["-replace", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (replaceResult.status === 0) {
    return;
  }

  const insertResult = runCommand("plutil", ["-insert", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (insertResult.status === 0) {
    return;
  }

  const details = [replaceResult.stderr, insertResult.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to update plist key "${key}" at ${plistPath}: ${details}`.trim());
}

function patchMainBundleInfoPlist(appBundlePath, iconPath, runCommand) {
  const infoPlistPath = join(appBundlePath, "Contents", "Info.plist");
  setPlistString(infoPlistPath, "CFBundleDisplayName", APP_DISPLAY_NAME, runCommand);
  setPlistString(infoPlistPath, "CFBundleName", APP_DISPLAY_NAME, runCommand);
  setPlistString(infoPlistPath, "CFBundleIdentifier", APP_BUNDLE_ID, runCommand);
  setPlistString(infoPlistPath, "CFBundleIconFile", "icon.icns", runCommand);
  setPlistString(
    infoPlistPath,
    "NSMicrophoneUsageDescription",
    MICROPHONE_USAGE_DESCRIPTION,
    runCommand,
  );

  const resourcesDir = join(appBundlePath, "Contents", "Resources");
  copyFileSync(iconPath, join(resourcesDir, "icon.icns"));
  copyFileSync(iconPath, join(resourcesDir, "electron.icns"));
}

function patchHelperBundleInfoPlists(appBundlePath, runCommand) {
  const frameworksDir = join(appBundlePath, "Contents", "Frameworks");
  if (!existsSync(frameworksDir)) {
    return;
  }

  for (const entry of readdirSync(frameworksDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".app")) {
      continue;
    }
    if (!entry.name.startsWith("Electron Helper")) {
      continue;
    }

    const helperPlistPath = join(frameworksDir, entry.name, "Contents", "Info.plist");
    if (!existsSync(helperPlistPath)) {
      continue;
    }

    const suffix = entry.name.replace("Electron Helper", "").replace(".app", "").trim();
    const helperName = suffix
      ? `${APP_DISPLAY_NAME} Helper ${suffix}`
      : `${APP_DISPLAY_NAME} Helper`;
    const helperIdSuffix = suffix.replace(/[()]/g, "").trim().toLowerCase().replace(/\s+/g, "-");
    const helperBundleId = helperIdSuffix
      ? `${APP_BUNDLE_ID}.helper.${helperIdSuffix}`
      : `${APP_BUNDLE_ID}.helper`;

    setPlistString(helperPlistPath, "CFBundleDisplayName", helperName, runCommand);
    setPlistString(helperPlistPath, "CFBundleName", helperName, runCommand);
    setPlistString(helperPlistPath, "CFBundleIdentifier", helperBundleId, runCommand);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function copyMacAppBundle(sourceAppBundlePath, targetAppBundlePath, runCommand = spawnSync) {
  const copyResult = runCommand("ditto", [sourceAppBundlePath, targetAppBundlePath], {
    encoding: "utf8",
  });
  if (copyResult.error) {
    throw new Error(
      `Failed to copy macOS Electron app bundle from ${sourceAppBundlePath} to ${targetAppBundlePath}: ${copyResult.error.message}`,
      { cause: copyResult.error },
    );
  }
  if (copyResult.status !== 0) {
    const details = [copyResult.stderr, copyResult.stdout].filter(Boolean).join("\n").trim();
    throw new Error(
      `Failed to copy macOS Electron app bundle from ${sourceAppBundlePath} to ${targetAppBundlePath} (ditto exit ${copyResult.status}): ${details}`.trim(),
    );
  }
}

function signMacLauncherBundle(appBundlePath, runCommand) {
  for (const [action, arguments_] of [
    ["sign", ["--force", "--deep", "--sign", "-", "--timestamp=none"]],
    ["verify", ["--verify", "--deep", "--strict"]],
  ]) {
    const result = runCommand("/usr/bin/codesign", [...arguments_, appBundlePath], {
      encoding: "utf8",
      timeout: 60_000,
    });
    if (result.error || result.status !== 0) {
      const details = [result.error?.message, result.stderr, result.stdout]
        .filter(Boolean)
        .join("\n")
        .trim();
      throw new Error(
        `Failed to ${action} the generated Synara launcher at ${appBundlePath} (codesign exit ${result.status}). Check the codesign error and retry; the invalid bundle will not be launched. ${details}`.trim(),
        result.error ? { cause: result.error } : undefined,
      );
    }
  }
}

export function buildMacLauncher(
  electronBinaryPath,
  { desktopDirectory = desktopDir, runCommand = spawnSync } = {},
) {
  const sourceAppBundlePath = resolve(electronBinaryPath, "../../..");
  const runtimeDir = join(desktopDirectory, ".electron-runtime");
  const targetAppBundlePath = join(runtimeDir, `${APP_DISPLAY_NAME}.app`);
  const targetBinaryPath = join(targetAppBundlePath, "Contents", "MacOS", "Electron");
  const iconPath = join(desktopDirectory, "resources", "icon.icns");
  const metadataPath = join(runtimeDir, "metadata.json");
  const desktopPackage = JSON.parse(readFileSync(join(desktopDirectory, "package.json"), "utf8"));

  mkdirSync(runtimeDir, { recursive: true });

  const expectedMetadata = {
    launcherVersion: LAUNCHER_VERSION,
    sourceAppBundlePath,
    sourceAppMtimeMs: statSync(sourceAppBundlePath).mtimeMs,
    iconMtimeMs: statSync(iconPath).mtimeMs,
    bootstrapHash: createHash("sha256").update(readFileSync(bootstrapPath)).digest("hex"),
    appVersion: desktopPackage.version,
  };

  const currentMetadata = readJson(metadataPath);
  if (
    existsSync(targetBinaryPath) &&
    currentMetadata &&
    JSON.stringify(currentMetadata) === JSON.stringify(expectedMetadata)
  ) {
    return targetBinaryPath;
  }

  // A failed rebuild must not retain metadata that could accept its partial bundle.
  rmSync(metadataPath, { force: true });
  rmSync(targetAppBundlePath, { recursive: true, force: true });
  copyMacAppBundle(sourceAppBundlePath, targetAppBundlePath, runCommand);
  patchMainBundleInfoPlist(targetAppBundlePath, iconPath, runCommand);
  patchHelperBundleInfoPlists(targetAppBundlePath, runCommand);
  const applicationDirectory = join(targetAppBundlePath, "Contents", "Resources", "app");
  mkdirSync(applicationDirectory, { recursive: true });
  writeFileSync(
    join(applicationDirectory, "package.json"),
    JSON.stringify({ name: APP_DISPLAY_NAME, version: desktopPackage.version, main: "main.cjs" }),
  );
  copyFileSync(bootstrapPath, join(applicationDirectory, "main.cjs"));
  // Plist/icon changes invalidate Electron's signature. Sign only our generated
  // copy, once per rebuild, so ordinary launches retain a stable TCC identity.
  signMacLauncherBundle(targetAppBundlePath, runCommand);
  writeFileSync(metadataPath, `${JSON.stringify(expectedMetadata, null, 2)}\n`);

  return targetBinaryPath;
}

export function resolveElectronPath() {
  const require = createRequire(import.meta.url);
  const electronBinaryPath = require("electron");

  if (process.platform !== "darwin") {
    return electronBinaryPath;
  }

  return buildMacLauncher(electronBinaryPath);
}
