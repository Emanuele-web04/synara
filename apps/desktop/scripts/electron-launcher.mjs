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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { TCC_SERVICE_NAMES } from "@synara/shared/computerGrants";
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
const LAUNCHER_VERSION = 6;
// Kept in sync with BRAND_ASSET_PATHS.productionMacIconComposer and the macOS
// icon constants in scripts/lib/desktop-platform-build-config.ts. The packaged
// build compiles the same asset; this launcher does it for dev and Canary,
// which run from a renamed Electron bundle instead of a packaged app.
const ICON_COMPOSER_ASSET_NAME = "Synara";
const ICON_COMPOSER_DEPLOYMENT_TARGET = "26.0";
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

// Same path as LSREGISTER_PATH in src/macIconCacheRefresh.ts; this launcher is
// a standalone module and cannot import from the bundled sources.
const LSREGISTER_PATH =
  "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";

// macOS caches bundle icons by identifier, so a rebuilt runtime keeps painting
// the previous icon until Launch Services re-reads the bundle — re-registering
// alone is not enough once an entry has gone stale. Best effort: a stale icon
// is a better outcome than refusing to launch.
function refreshLaunchServicesRegistration(appBundlePath, runCommand) {
  if (!existsSync(LSREGISTER_PATH)) {
    return;
  }
  runCommand(LSREGISTER_PATH, ["-u", appBundlePath], { encoding: "utf8" });
  // Unregistering is not enough on its own: IconServices keeps serving the
  // cached artwork until the bundle's own modification date moves forward.
  try {
    const now = new Date();
    utimesSync(appBundlePath, now, now);
  } catch {
    // A failed timestamp bump only costs a stale icon, so carry on.
  }
  const result = runCommand(LSREGISTER_PATH, ["-f", "-R", appBundlePath], { encoding: "utf8" });
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

// macOS 26 renders the Liquid Glass material only from a compiled Icon Composer
// asset, never from an ICNS. actool ships with Xcode, so this stays optional: a
// machine without it keeps the flat icon instead of failing to launch.
function compileGlassAppIcon(appBundlePath, iconComposerPath, scratchDir, runCommand) {
  const resourcesDir = join(appBundlePath, "Contents", "Resources");
  const partialPlistPath = join(scratchDir, "icon-partial.plist");
  const result = runCommand(
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
    runCommand,
  );
  return true;
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

function readCdhash(appBundlePath, runCommand) {
  const result = runCommand("/usr/bin/codesign", ["--display", "--verbose=3", appBundlePath], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) return null;
  // codesign prints its description on stderr.
  return (
    /^CDHash=([0-9a-f]+)$/m.exec(`${result.stderr ?? ""}\n${result.stdout ?? ""}`)?.[1] ?? null
  );
}

// macOS pins an ad-hoc bundle's privacy grants to its cdhash. Re-signing a
// changed bundle leaves rows that System Settings still shows switched on but
// that never match again, and neither the toggle nor a re-drop replaces them.
// Clear only this flavor's dead rows so the permission guide adds a valid one.
function resetStalePrivacyGrants(runCommand) {
  for (const service of Object.values(TCC_SERVICE_NAMES)) {
    const result = runCommand("/usr/bin/tccutil", ["reset", service, APP_BUNDLE_ID], {
      encoding: "utf8",
      timeout: 60_000,
    });
    if (result.error || result.status !== 0) {
      console.warn(
        `[electron-launcher] Could not clear the stale ${service} grant for ${APP_BUNDLE_ID}. Remove ${APP_DISPLAY_NAME} from System Settings › Privacy & Security › ${service} and add it again.`,
      );
    }
  }
  console.warn(
    `[electron-launcher] ${APP_DISPLAY_NAME} was re-signed, so its old macOS privacy grants were cleared. Grant Accessibility, Screen Recording and Input Monitoring again.`,
  );
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
  const iconComposerPath = resolve(desktopDirectory, "../../assets/prod/Synara.icon");
  const hasIconComposerSource = existsSync(iconComposerPath);
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
    // Layered artwork lives in several files, so track the newest of them.
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

  const previousCdhash = existsSync(targetBinaryPath)
    ? readCdhash(targetAppBundlePath, runCommand)
    : null;
  // A failed rebuild must not retain metadata that could accept its partial bundle.
  rmSync(metadataPath, { force: true });
  rmSync(targetAppBundlePath, { recursive: true, force: true });
  copyMacAppBundle(sourceAppBundlePath, targetAppBundlePath, runCommand);
  patchMainBundleInfoPlist(targetAppBundlePath, iconPath, runCommand);
  if (hasIconComposerSource) {
    compileGlassAppIcon(targetAppBundlePath, iconComposerPath, runtimeDir, runCommand);
  }
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
  if (previousCdhash && readCdhash(targetAppBundlePath, runCommand) !== previousCdhash) {
    resetStalePrivacyGrants(runCommand);
  }
  refreshLaunchServicesRegistration(targetAppBundlePath, runCommand);
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
