// FILE: updatePendingCache.ts
// Purpose: Coordinates safe deletion of electron-updater pending cache artifacts.
// Layer: Desktop update utility
// Exports: PendingUpdateCacheClearQueue plus electron-updater cache path helpers

import * as Path from "node:path";

export function resolveElectronUpdaterCacheDirName(
  rawConfig: Record<string, string> | null,
  appName: string,
): string {
  return rawConfig?.updaterCacheDirName?.trim() || appName;
}

export function resolveElectronUpdaterPendingCacheDir(args: {
  readonly cacheDirName: string | null;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly localAppData?: string | null;
  readonly xdgCacheHome?: string | null;
}): string | null {
  const cacheDir = resolveElectronUpdaterCacheDir(args);
  if (!cacheDir) {
    return null;
  }

  const pathForPlatform = args.platform === "win32" ? Path.win32 : Path.posix;
  return pathForPlatform.join(cacheDir, "pending");
}

export function resolveElectronUpdaterCacheDir(args: {
  readonly cacheDirName: string | null;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly localAppData?: string | null;
  readonly xdgCacheHome?: string | null;
}): string | null {
  if (!args.cacheDirName) {
    return null;
  }

  const pathForPlatform = args.platform === "win32" ? Path.win32 : Path.posix;
  // Match electron-updater's base cache fallback, including empty env vars.
  const baseCachePath =
    args.platform === "win32"
      ? args.localAppData || pathForPlatform.join(args.homeDir, "AppData", "Local")
      : args.platform === "darwin"
        ? pathForPlatform.join(args.homeDir, "Library", "Caches")
        : args.xdgCacheHome || pathForPlatform.join(args.homeDir, ".cache");
  return pathForPlatform.join(baseCachePath, args.cacheDirName);
}

export function resolveElectronUpdaterLegacyZipPath(args: {
  readonly cacheDirName: string | null;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly localAppData?: string | null;
  readonly xdgCacheHome?: string | null;
}): string | null {
  const cacheDir = resolveElectronUpdaterCacheDir(args);
  if (!cacheDir) {
    return null;
  }
  const pathForPlatform = args.platform === "win32" ? Path.win32 : Path.posix;
  return pathForPlatform.join(cacheDir, "update.zip");
}

export class PendingUpdateCacheClearQueue {
  private queuedReason: string | null = null;

  request(reason: string, isDownloadInFlight: boolean, clearNow: (reason: string) => void): void {
    if (isDownloadInFlight) {
      this.queuedReason = reason;
      return;
    }
    clearNow(reason);
  }

  consumeAfterDownload(): string | null {
    const reason = this.queuedReason;
    this.queuedReason = null;
    return reason;
  }
}
