// FILE: staticSnapshot.ts
// Purpose: Materializes a real-on-disk snapshot of static assets that live inside
//          an asar archive, so serving survives the archive being replaced on disk.
// Layer: Shared runtime utility (desktop main + server startup)
//
// Electron caches an asar's header per process. When app.asar is swapped beneath a
// running app (an updater retry racing a relaunch, a reinstall, a build copied over
// the bundle) every later archive read resolves against stale offsets and silently
// returns bytes from the wrong file: masked icons vanish, lazily-loaded route
// chunks arrive corrupted. Files extracted to a plain directory have no such shared
// header — each request opens a real file — so serving the UI from a per-archive
// snapshot prevents the corruption instead of merely detecting it.
//
// Snapshots are keyed by the source archive's identity (size/mtime/inode signature):
// the first launch of a given archive pays one recursive copy, later launches reuse
// it, and superseded snapshots are pruned best-effort.

import fs from "node:fs";
import path from "node:path";

const ASAR_SUFFIX = ".asar";

/**
 * Returns the path of the containing `.asar` archive when `candidatePath` points
 * inside one (`…/app.asar/apps/server/dist/client` → `…/app.asar`), or the path
 * itself when it IS an archive. Null for plain-directory paths, which need no
 * snapshot: real files are already immune to archive swaps.
 */
export function findAsarArchivePath(candidatePath: string): string | null {
  const segments = candidatePath.split(/[/\\]/);
  const archiveIndex = segments.findIndex((segment) => segment.endsWith(ASAR_SUFFIX));
  if (archiveIndex === -1) {
    return null;
  }
  return segments.slice(0, archiveIndex + 1).join(path.sep);
}

/** Turns an archive signature into a filesystem-safe snapshot directory name. */
export function snapshotDirectoryName(signature: string): string {
  return signature.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export interface StaticSnapshotInput {
  /** Directory whose contents must survive archive swaps (may live inside an asar). */
  readonly sourceDir: string;
  /** Real-disk directory that owns every snapshot generation. */
  readonly cacheRoot: string;
  /** Identity of the source archive; a new signature forces a fresh snapshot. */
  readonly signature: string;
  /** File whose presence marks a snapshot as complete and the source as sane. */
  readonly sentinelFile?: string;
}

export interface StaticSnapshotResult {
  readonly dir: string;
  readonly reused: boolean;
}

function copyDirectoryRecursive(sourceDir: string, targetDir: string): void {
  // Manual walk instead of fs.cpSync: reads go through Electron's asar-patched
  // fs, which supports readdir/readFile/stat inside archives but not the copyFile
  // fast path cpSync prefers.
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
      // A stale snapshot held open elsewhere is disk waste, not a correctness
      // problem; the next launch retries the prune.
    }
  }
}

/**
 * Ensures a complete real-disk copy of `sourceDir` exists for `signature` and
 * returns its path. Reuses an existing snapshot when the sentinel file is present;
 * otherwise copies into a temp directory and atomically renames it into place, so
 * a crash mid-copy can never yield a half-snapshot that looks complete, and a
 * concurrent process racing the same signature safely loses the rename and reuses
 * the winner's copy. Throws on failure — callers fall back to serving `sourceDir`.
 */
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
    // Lost the rename race to a concurrent process: its completed copy is
    // equivalent, so serve that instead of failing startup.
    if (fs.existsSync(path.join(snapshotDir, sentinelFile))) {
      return { dir: snapshotDir, reused: true };
    }
    throw error;
  }

  pruneStaleSnapshots(input.cacheRoot, snapshotName);
  return { dir: snapshotDir, reused: false };
}
