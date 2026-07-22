#!/usr/bin/env node

import { chmod, copyFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const helperDir = dirname(fileURLToPath(import.meta.url));
const outputDir = join(helperDir, "build");
const output = join(outputDir, "synara-island-helper");
const temporaryOutput = `${output}.tmp`;
const appBundle = join(outputDir, "Synara Island Preview.app");
const appContents = join(appBundle, "Contents");
const appExecutable = join(appContents, "MacOS", "synara-island-helper");

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code}`));
    });
  });
}

async function read(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${command} exited with status ${code}`));
    });
  });
}

const sources = (await readdir(helperDir))
  .filter((name) => name.endsWith(".swift"))
  .map((name) => join(helperDir, name))
  .sort();

await mkdir(outputDir, { recursive: true });
await rm(temporaryOutput, { force: true });

const sdkVersion = await read("xcrun", ["--sdk", "macosx", "--show-sdk-version"]);
const sdkMajor = Number.parseInt(sdkVersion.split(".")[0] ?? "0", 10);
const sdkFeatureFlags = sdkMajor >= 26 ? ["-DSYNARA_HAS_LIQUID_GLASS"] : [];

await run("xcrun", [
  "swiftc",
  "-parse-as-library",
  "-target",
  "arm64-apple-macos13.0",
  "-framework",
  "AppKit",
  "-framework",
  "SwiftUI",
  "-framework",
  "QuartzCore",
  ...sdkFeatureFlags,
  "-o",
  temporaryOutput,
  ...sources,
]);

await run("codesign", ["--force", "--sign", "-", temporaryOutput]);
await rename(temporaryOutput, output);

await rm(appBundle, { recursive: true, force: true });
await mkdir(join(appContents, "MacOS"), { recursive: true });
await copyFile(output, appExecutable);
await chmod(appExecutable, 0o755);
await writeFile(
  join(appContents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Synara Island Preview</string>
  <key>CFBundleExecutable</key><string>synara-island-helper</string>
  <key>CFBundleIdentifier</key><string>com.synara.island.preview</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Synara Island Preview</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrefersDisplaySafeAreaCompatibilityMode</key><false/>
</dict>
</plist>\n`,
);
await run("codesign", ["--force", "--deep", "--sign", "-", appBundle]);

console.log(appBundle);
