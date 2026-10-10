// Electron caches the asar header per process — once app.asar is swapped on disk every later read resolves stale offsets and silently returns wrong bytes (missing icons, corrupted lazy chunks); the only safe reaction is a restart

export interface BundleSignature {
  readonly size: number;
  readonly mtimeMs: number;
  readonly inode: number;
}

export interface BundleStatLike {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

export function bundleSignatureFromStats(stats: BundleStatLike): BundleSignature {
  return { size: stats.size, mtimeMs: stats.mtimeMs, inode: stats.ino };
}

// dev runs load plain files that tolerate on-disk edits — the watcher is pointless and noisy there
export function isWatchableBundlePath(appPath: string): boolean {
  return appPath.endsWith(".asar");
}

// a null signature means the archive is momentarily unreadable (mid-swap, transient stat failure) — only a readable archive with a different identity counts as swapped
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

// extraction needs stricter proof than polling: an unreadable archive can't prove the copied bytes belong to one generation
export function isBundleStable(
  baseline: BundleSignature,
  current: BundleSignature | null,
): current is BundleSignature {
  return current !== null && !isBundleSwapped(baseline, current);
}
