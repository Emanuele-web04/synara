// Electron caches an asar's header per process — swapping app.asar under a running app makes later reads resolve stale offsets and return wrong bytes; serving from a real-disk snapshot prevents the corruption
// keyed by the archive's identity signature — first launch pays one copy, later launches reuse, superseded snapshots pruned best-effort

import fs from "node:fs";
import path from "node:path";

const ASAR_SUFFIX = ".asar";

/** null for plain-directory paths — real files are already immune to archive swaps */
export function findAsarArchivePath(candidatePath: string): string | null {
  const segments = candidatePath.split(/[/\\]/);
  const archiveIndex = segments.findIndex((segment) => segment.endsWith(ASAR_SUFFIX));
  if (archiveIndex === -1) {
    return null;
  }
  return segments.slice(0, archiveIndex + 1).join(path.sep);
}

export function snapshotDirectoryName(signature: string): string {
  return signature.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export interface StaticSnapshotInput {
  readonly sourceDir: string;
  readonly cacheRoot: string;
  /** a new signature forces a fresh snapshot */
  readonly signature: string;
  /** marks a snapshot as complete and the source as sane */
  readonly sentinelFile?: string;
}

export interface StaticSnapshotResult {
  readonly dir: string;
  readonly reused: boolean;
}

function copyDirectoryRecursive(sourceDir: string, targetDir: string): void {
  // manual walk instead of fs.cpSync — Electron's asar-patched fs supports readdir/readFile/stat inside archives but not copyFile
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourcePath, targetPath);
    } else if (entry.isFile()) {
      fs.writeFileSync(targetPath, fs.readFileSync(sourcePath));
    }
  }
}

function pruneStaleSnapshots(cacheRoot: string, keepName: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === keepName) continue;
    try {
      fs.rmSync(path.join(cacheRoot, entry.name), { recursive: true, force: true });
    } catch {
      // a stale snapshot held open elsewhere is disk waste, not a correctness problem — the next launch retries the prune
    }
  }
}

/** copies into a temp dir and atomically renames so a crash can't yield a half-snapshot; a concurrent loser of the rename race reuses the winner's copy; throws — callers fall back to serving sourceDir */
export function ensureStaticSnapshot(input: StaticSnapshotInput): StaticSnapshotResult {
  const sentinelFile = input.sentinelFile ?? "index.html";
  const snapshotName = snapshotDirectoryName(input.signature);
  const snapshotDir = path.join(input.cacheRoot, snapshotName);

  if (fs.existsSync(path.join(snapshotDir, sentinelFile))) {
    pruneStaleSnapshots(input.cacheRoot, snapshotName);
    return { dir: snapshotDir, reused: true };
  }

  if (!fs.existsSync(path.join(input.sourceDir, sentinelFile))) {
    throw new Error(`Static snapshot source is missing ${sentinelFile}: ${input.sourceDir}`);
  }

  fs.mkdirSync(input.cacheRoot, { recursive: true });
  const stagingDir = path.join(input.cacheRoot, `.staging-${snapshotName}-${process.pid}`);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  try {
    copyDirectoryRecursive(input.sourceDir, stagingDir);
    fs.renameSync(stagingDir, snapshotDir);
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    // lost the rename race — the winner's completed copy is equivalent, serve it instead of failing startup
    if (fs.existsSync(path.join(snapshotDir, sentinelFile))) {
      return { dir: snapshotDir, reused: true };
    }
    throw error;
  }

  pruneStaleSnapshots(input.cacheRoot, snapshotName);
  return { dir: snapshotDir, reused: false };
}
