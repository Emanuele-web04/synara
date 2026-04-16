// FILE: electron-builder-after-pack.cjs
// Purpose: Restores the legacy macOS icon fallback when the main bundle uses Icon Composer assets.
// Layer: Build hook
// Depends on: electron-builder afterPack hook context and macOS plutil availability.

const { copyFileSync, existsSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

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

// Keep a classic .icns entry in the app bundle so pre-Tahoe macOS can still resolve the icon.
exports.default = async function afterPack(context) {
  const appDir = typeof context?.appDir === "string" ? context.appDir : process.cwd();
  const appOutDir = typeof context?.appOutDir === "string" ? context.appOutDir : "";
  if (!appOutDir) {
    return;
  }

  const productFilename = context?.packager?.appInfo?.productFilename;
  const preferredBundlePath =
    typeof productFilename === "string" ? join(appOutDir, `${productFilename}.app`) : null;
  const appBundlePath =
    preferredBundlePath && existsSync(preferredBundlePath)
      ? preferredBundlePath
      : readdirSync(appOutDir)
          .filter((entry) => entry.endsWith(".app"))
          .map((entry) => join(appOutDir, entry))[0];

  if (!appBundlePath || !existsSync(appBundlePath)) {
    throw new Error(`Could not find packaged macOS app bundle inside ${appOutDir}`);
  }

  const sourceIcnsPath = join(appDir, "apps", "desktop", "resources", "icon.icns");
  if (!existsSync(sourceIcnsPath)) {
    throw new Error(`Missing legacy macOS icon at ${sourceIcnsPath}`);
  }

  const resourcesDir = join(appBundlePath, "Contents", "Resources");
  const plistPath = join(appBundlePath, "Contents", "Info.plist");
  copyFileSync(sourceIcnsPath, join(resourcesDir, "icon.icns"));
  setPlistString(plistPath, "CFBundleIconFile", "icon.icns");
};
