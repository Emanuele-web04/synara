// FILE: bundleSwapDetection.ts
// Purpose: Detects the packaged app.asar being replaced on disk beneath a running app.
// Layer: Desktop update utility
//
// Electron caches the asar header per process, so once app.asar is swapped on disk
// (updater retry, manual reinstall, a local build copied over the bundle) every
// subsequent archive read resolves to stale offsets and returns bytes from the
// wrong file. The failure is silent — masked icons vanish, lazily-loaded route
// chunks arrive corrupted — so the only safe reaction is a restart. These helpers
// hold the pure signature/compare logic; main.ts owns the polling timer, the
// original-fs stat, and the restart prompt.

/** Identity of the on-disk archive as observed at one point in time. */
export interface BundleSignature {
  readonly size: number;
  readonly mtimeMs: number;
  readonly inode: number;
}

/** Subset of fs.Stats the signature needs (keeps tests free of real files). */
export interface BundleStatLike {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

export function bundleSignatureFromStats(stats: BundleStatLike): BundleSignature {
  return { size: stats.size, mtimeMs: stats.mtimeMs, inode: stats.ino };
}

/**
 * Only packaged builds read through an archive; dev runs load plain files that
 * tolerate on-disk edits, so the watcher is pointless (and noisy) there.
 */
export function isWatchableBundlePath(appPath: string): boolean {
  return appPath.endsWith(".asar");
}

/**
 * A null current signature means the archive is momentarily unreadable — mid-swap
 * or a transient stat failure — which is not yet a confirmed replacement; the next
 * poll observes whatever landed. Only a readable archive with a different identity
 * counts as swapped.
 */
export function isBundleSwapped(
  baseline: BundleSignature,
  current: BundleSignature | null,
): boolean {
  if (current === null) {
    return false;
  }
  return (
    current.size !== baseline.size ||
    current.mtimeMs !== baseline.mtimeMs ||
    current.inode !== baseline.inode
  );
}

/**
 * Snapshot extraction needs a stricter check than polling: an unreadable
 * archive cannot prove that the bytes copied from it belong to one generation.
 */
export function isBundleStable(
  baseline: BundleSignature,
  current: BundleSignature | null,
): current is BundleSignature {
  return current !== null && !isBundleSwapped(baseline, current);
}
