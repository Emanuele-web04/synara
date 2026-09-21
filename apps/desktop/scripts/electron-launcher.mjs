import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { resolveSynaraDesktopFlavor, synaraDesktopIdentity } from "@synara/shared/desktopIdentity";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopFlavor = resolveSynaraDesktopFlavor({
  isDevelopment: true,
  requestedFlavor: process.env.SYNARA_DESKTOP_FLAVOR,
});
const desktopIdentity = synaraDesktopIdentity(desktopFlavor);
const APP_DISPLAY_NAME = desktopIdentity.displayName;
const APP_BUNDLE_ID = desktopIdentity.bundleId;
const LAUNCHER_VERSION = 3;
const ICON_COMPOSER_ASSET_NAME = "Synara";
const ICON_COMPOSER_DEPLOYMENT_TARGET = "26.0";
const MICROPHONE_USAGE_DESCRIPTION =
  "Synara needs microphone access so you can record voice notes and transcribe them into the chat composer.";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const desktopDir = resolve(__dirname, "..");

function setPlistString(plistPath, key, value) {
  const replaceResult = spawnSync("plutil", ["-replace", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (replaceResult.status === 0) {
    return;
  }

  const insertResult = spawnSync("plutil", ["-insert", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (insertResult.status === 0) {
    return;
  }

  const details = [replaceResult.stderr, insertResult.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to update plist key "${key}" at ${plistPath}: ${details}`.trim());
}

const LSREGISTER_PATH =
  "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";

function refreshLaunchServicesRegistration(appBundlePath) {
  if (!existsSync(LSREGISTER_PATH)) {
    return;
  }
  spawnSync(LSREGISTER_PATH, ["-u", appBundlePath], { encoding: "utf8" });
  try {
    const now = new Date();
    utimesSync(appBundlePath, now, now);
  } catch {}
  const result = spawnSync(LSREGISTER_PATH, ["-f", "-R", appBundlePath], { encoding: "utf8" });
  if (result.status !== 0) {
    const details = [result.error?.message, result.stderr].filter(Boolean).join("\n").trim();
    console.warn(
      `[desktop] Failed to refresh the Launch Services registration for ${appBundlePath}; the dock may keep showing the previous icon.${
        details ? ` ${details}` : ""
      }`,
    );
  }
}

function latestMtimeMs(entryPath) {
  const entryStat = statSync(entryPath);
  if (!entryStat.isDirectory()) {
    return entryStat.mtimeMs;
  }
  let latest = entryStat.mtimeMs;
  for (const child of readdirSync(entryPath)) {
    latest = Math.max(latest, latestMtimeMs(join(entryPath, child)));
  }
  return latest;
}

function compileGlassAppIcon(appBundlePath, iconComposerPath, scratchDir) {
  const resourcesDir = join(appBundlePath, "Contents", "Resources");
  const partialPlistPath = join(scratchDir, "icon-partial.plist");
  const result = spawnSync(
    "xcrun",
    [
      "actool",
      iconComposerPath,
      "--compile",
      resourcesDir,
      "--platform",
      "macosx",
      "--minimum-deployment-target",
      ICON_COMPOSER_DEPLOYMENT_TARGET,
      "--app-icon",
      ICON_COMPOSER_ASSET_NAME,
      "--include-all-app-icons",
      "--output-partial-info-plist",
      partialPlistPath,
      "--output-format",
      "human-readable-text",
    ],
    { encoding: "utf8" },
  );
  rmSync(partialPlistPath, { force: true });

  if (result.status !== 0 || !existsSync(join(resourcesDir, "Assets.car"))) {
    const details = [result.error?.message, result.stderr].filter(Boolean).join("\n").trim();
    console.warn(
      `[desktop] Skipping the Liquid Glass app icon; actool did not produce an asset catalog.${
        details ? ` ${details}` : ""
      }`,
    );
    return false;
  }

  setPlistString(
    join(appBundlePath, "Contents", "Info.plist"),
    "CFBundleIconName",
    ICON_COMPOSER_ASSET_NAME,
  );
  return true;
}

function patchMainBundleInfoPlist(appBundlePath, iconPath) {
  const infoPlistPath = join(appBundlePath, "Contents", "Info.plist");
  setPlistString(infoPlistPath, "CFBundleDisplayName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleIdentifier", APP_BUNDLE_ID);
  setPlistString(infoPlistPath, "CFBundleIconFile", "icon.icns");
  setPlistString(infoPlistPath, "NSMicrophoneUsageDescription", MICROPHONE_USAGE_DESCRIPTION);

  const resourcesDir = join(appBundlePath, "Contents", "Resources");
  copyFileSync(iconPath, join(resourcesDir, "icon.icns"));
  copyFileSync(iconPath, join(resourcesDir, "electron.icns"));
}

function patchHelperBundleInfoPlists(appBundlePath) {
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

    setPlistString(helperPlistPath, "CFBundleDisplayName", helperName);
    setPlistString(helperPlistPath, "CFBundleName", helperName);
    setPlistString(helperPlistPath, "CFBundleIdentifier", helperBundleId);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function copyMacAppBundle(sourceAppBundlePath, targetAppBundlePath) {
  const copyResult = spawnSync("ditto", [sourceAppBundlePath, targetAppBundlePath], {
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

function buildMacLauncher(electronBinaryPath) {
  const sourceAppBundlePath = resolve(electronBinaryPath, "../../..");
  const runtimeDir = join(desktopDir, ".electron-runtime");
  const targetAppBundlePath = join(runtimeDir, `${APP_DISPLAY_NAME}.app`);
  const targetBinaryPath = join(targetAppBundlePath, "Contents", "MacOS", "Electron");
  const iconPath = join(desktopDir, "resources", "icon.icns");
  const iconComposerPath = resolve(desktopDir, "../../assets/prod/Synara.icon");
  const hasIconComposerSource = existsSync(iconComposerPath);
  const metadataPath = join(runtimeDir, "metadata.json");

  mkdirSync(runtimeDir, { recursive: true });

  const expectedMetadata = {
    launcherVersion: LAUNCHER_VERSION,
    sourceAppBundlePath,
    sourceAppMtimeMs: statSync(sourceAppBundlePath).mtimeMs,
    iconMtimeMs: statSync(iconPath).mtimeMs,
    iconComposerMtimeMs: hasIconComposerSource ? latestMtimeMs(iconComposerPath) : null,
  };

  const currentMetadata = readJson(metadataPath);
  if (
    existsSync(targetBinaryPath) &&
    currentMetadata &&
    JSON.stringify(currentMetadata) === JSON.stringify(expectedMetadata)
  ) {
    return targetBinaryPath;
  }

  rmSync(targetAppBundlePath, { recursive: true, force: true });
  copyMacAppBundle(sourceAppBundlePath, targetAppBundlePath);
  patchMainBundleInfoPlist(targetAppBundlePath, iconPath);
  if (hasIconComposerSource) {
    compileGlassAppIcon(targetAppBundlePath, iconComposerPath, runtimeDir);
  }
  patchHelperBundleInfoPlists(targetAppBundlePath);
  refreshLaunchServicesRegistration(targetAppBundlePath);
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
