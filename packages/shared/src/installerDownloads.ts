// FILE: installerDownloads.ts
// Purpose: Defines the installer artifact/count boundary reused by marketing and analytics.
// Only public GitHub installer counters are interpreted; updater metadata is excluded.

export type InstallerPlatform = "darwin" | "win32" | "linux";

// Keep the existing marketing artifact selection while bounding untrusted names.
export function installerPlatform(name: unknown): InstallerPlatform | null {
  if (typeof name !== "string" || name.length > 512) return null;
  if (/\.dmg$/i.test(name)) return "darwin";
  if (/\.exe$/i.test(name)) return "win32";
  if (/\.AppImage$/i.test(name)) return "linux";
  return null;
}

export function installerDownloadCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Marketing needs a total without retaining GitHub's unrelated release/profile fields.
export function countInstallerDownloads(releases: unknown): number {
  if (!Array.isArray(releases)) throw new Error("Invalid GitHub releases");
  let total = 0;
  for (const release of releases) {
    if (!release || !Array.isArray(release.assets)) continue;
    for (const asset of release.assets) {
      if (!asset || !installerPlatform(asset.name)) continue;
      const count = installerDownloadCount(asset.download_count);
      if (count === null) throw new Error("Invalid GitHub installer counter");
      total += count;
      if (!Number.isSafeInteger(total)) throw new Error("GitHub installer total exceeds bounds");
    }
  }
  return total;
}
