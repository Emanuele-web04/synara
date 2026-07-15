// FILE: mac-update-zip-finalize.ts
// Purpose: Rebuilds and validates macOS Squirrel update zip artifacts before publishing.
// Layer: Release/build helper
// Exports: finalizeMacUpdateZip for build scripts and smoke checks.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  buildMacUpdateZipSymlinkEntries,
  isZipInfoSymlink,
  resolveMacUpdateManifestFileNames,
  resolveSingleMacUpdateZipFileName,
  resolveSingleTopLevelMacAppBundle,
  updateMacUpdateManifestZipEntry,
} from "./mac-update-zip.ts";

export interface FinalizeMacUpdateZipOptions {
  readonly stageDistDir: string;
  readonly signed: boolean;
  readonly verbose?: boolean;
}

export interface FinalizedMacUpdateZip {
  readonly zipPath: string;
  readonly zipFileName: string;
  readonly sha512: string;
  readonly size: number;
  readonly updatedManifestPaths: ReadonlyArray<string>;
  readonly removedZipBlockmapPath: string | null;
}

function readDirectoryEntries(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function findFirstMacAppBundle(root: string): string | null {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) {
      continue;
    }
    for (const entry of readDirectoryEntries(current)) {
      const candidate = join(current, entry);
      let stat;
      try {
        stat = statSync(candidate);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) {
        continue;
      }
      if (entry.endsWith(".app")) {
        return candidate;
      }
      pending.push(candidate);
    }
  }
  return null;
}

// A fully packaged Electron app lists thousands of zip entries, so raise the
// stdout cap well past spawnSync's 1 MB default to avoid spurious ENOBUFS
// failures when reading the archive listing.
const COMMAND_OUTPUT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function runTextCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly verbose?: boolean } = {},
): string {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: COMMAND_OUTPUT_MAX_BUFFER_BYTES,
  });
  if (options.verbose && result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (options.verbose && result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  return result.stdout;
}

function listZipEntries(zipPath: string): string[] {
  return runTextCommand("unzip", ["-Z", "-1", zipPath])
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function assertMacZipFrameworkSymlinks(zipPath: string): string {
  const appBundleName = resolveSingleTopLevelMacAppBundle(listZipEntries(zipPath));
  for (const entry of buildMacUpdateZipSymlinkEntries(appBundleName)) {
    const zipInfo = runTextCommand("unzip", ["-Z", "-v", zipPath, entry]);
    if (!isZipInfoSymlink(zipInfo)) {
      throw new Error(`macOS update zip entry must be a symlink: ${entry}`);
    }
  }
  return appBundleName;
}

function verifyMacAppSignature(appBundlePath: string, requireSignature: boolean): void {
  const codeResourcesPath = join(appBundlePath, "Contents", "_CodeSignature", "CodeResources");
  if (!requireSignature && !existsSync(codeResourcesPath)) {
    return;
  }
  runTextCommand("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appBundlePath]);
}

function computeSha512Base64(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("base64")));
  });
}

// Recreates the update zip with macOS-native metadata, then validates the same
// extracted app shape Squirrel.Mac will hand to ShipIt during installation.
export async function finalizeMacUpdateZip(
  options: FinalizeMacUpdateZipOptions,
): Promise<FinalizedMacUpdateZip> {
  const verbose = options.verbose === true;
  if (process.platform !== "darwin") {
    throw new Error(
      "macOS update zip finalization must run on macOS so ditto/codesign are available.",
    );
  }

  const appBundlePath = findFirstMacAppBundle(options.stageDistDir);
  if (!appBundlePath) {
    throw new Error(`Could not find packaged .app bundle inside ${options.stageDistDir}`);
  }

  const distEntries = readdirSync(options.stageDistDir);
  const zipFileName = resolveSingleMacUpdateZipFileName(distEntries);
  const zipPath = join(options.stageDistDir, zipFileName);
  const appBundleName = basename(appBundlePath);
  const appBundleParent = dirname(appBundlePath);

  rmSync(zipPath, { force: true });
  runTextCommand("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appBundleName, zipPath], {
    cwd: appBundleParent,
    verbose,
  });

  const zippedAppBundleName = assertMacZipFrameworkSymlinks(zipPath);
  verifyMacAppSignature(appBundlePath, options.signed);

  const extractedZipRoot = mkdtempSync(join(tmpdir(), "synara-mac-update-zip-"));
  try {
    runTextCommand("ditto", ["-x", "-k", zipPath, extractedZipRoot], { verbose });
    verifyMacAppSignature(join(extractedZipRoot, zippedAppBundleName), options.signed);
  } finally {
    rmSync(extractedZipRoot, { force: true, recursive: true });
  }

  const zipStat = statSync(zipPath);
  if (!zipStat.isFile()) {
    throw new Error(`Repacked macOS update zip was not created at ${zipPath}`);
  }
  const sha512 = await computeSha512Base64(zipPath);

  const updatedManifestPaths: string[] = [];
  for (const manifestName of resolveMacUpdateManifestFileNames(distEntries)) {
    const manifestPath = join(options.stageDistDir, manifestName);
    const manifest = readFileSync(manifestPath, "utf8");
    const nextManifest = updateMacUpdateManifestZipEntry(manifest, zipFileName, {
      sha512,
      size: zipStat.size,
    });
    writeFileSync(manifestPath, nextManifest);
    updatedManifestPaths.push(manifestPath);
  }

  const staleZipBlockmapPath = `${zipPath}.blockmap`;
  const removedZipBlockmapPath = existsSync(staleZipBlockmapPath) ? staleZipBlockmapPath : null;
  if (removedZipBlockmapPath) {
    rmSync(removedZipBlockmapPath, { force: true });
  }

  return {
    zipPath,
    zipFileName,
    sha512,
    size: zipStat.size,
    updatedManifestPaths,
    removedZipBlockmapPath,
  };
}
