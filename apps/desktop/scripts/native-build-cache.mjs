// FILE: native-build-cache.mjs
// Purpose: Shared steps for the macOS native builds (AppSnap helper, window-material addon):
//          running build commands, reusing a fingerprinted signed build, and installing one.
// Layer: Desktop build scripts

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: desktopDirectory,
    encoding: "utf8",
    env: options.env ?? process.env,
  });
  if (result.status === 0) {
    return;
  }

  const details = [result.stdout, result.stderr]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
  const suffix = details ? `\n${details}` : "";
  throw new Error(
    `Native build command failed (${command} ${arguments_.join(" ")}): ${result.status ?? "unknown"}${suffix}`,
  );
}

export function isUsableCachedBuild(outputPath, metadataPath, fingerprint) {
  if (!existsSync(outputPath) || !existsSync(metadataPath)) {
    return false;
  }
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (metadata.fingerprint !== fingerprint) {
      return false;
    }
    const verification = spawnSync("codesign", ["--verify", "--strict", outputPath], {
      encoding: "utf8",
    });
    return verification.status === 0;
  } catch {
    return false;
  }
}

/**
 * Ad-hoc signs `builtPath` and moves it to `outputPath` with its fingerprint metadata.
 * electron-builder replaces the ad-hoc signature with the release identity because the
 * packaged paths are listed in mac.binaries.
 */
export function installSignedBuild({ builtPath, outputPath, metadataPath, fingerprint, mode }) {
  run("codesign", ["--force", "--sign", "-", "--timestamp=none", builtPath]);

  mkdirSync(dirname(outputPath), { recursive: true });
  const pendingOutputPath = `${outputPath}.tmp-${process.pid}`;
  rmSync(pendingOutputPath, { force: true });
  copyFileSync(builtPath, pendingOutputPath);
  chmodSync(pendingOutputPath, mode);
  rmSync(outputPath, { force: true });
  renameSync(pendingOutputPath, outputPath);

  const pendingMetadataPath = `${metadataPath}.tmp-${process.pid}`;
  rmSync(pendingMetadataPath, { force: true });
  writeFileSync(pendingMetadataPath, `${JSON.stringify({ fingerprint })}\n`, { mode: 0o600 });
  rmSync(metadataPath, { force: true });
  renameSync(pendingMetadataPath, metadataPath);
}
