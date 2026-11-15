// FILE: desktop-artifact-naming.ts
// Purpose: Names staged desktop payloads and updater manifests so the build
//          script, provenance record and checkpoint verifier spell them the same way.

export type DesktopArtifactPlatform = "linux" | "mac" | "win";
export type DesktopArtifactArch = "arm64" | "x64" | "universal";

/**
 * Architecture label electron-builder embeds in a payload file name. The
 * AppImage target uses the native x86_64 alias for Intel while every other
 * target keeps the matrix spelling.
 */
export function payloadArchLabel(
  platform: DesktopArtifactPlatform,
  arch: DesktopArtifactArch,
): string {
  if (platform === "linux") return arch === "x64" ? "x86_64" : arch;
  return arch;
}

/** Updater manifest electron-builder writes for the platform's x64 build. */
export function stagedUpdaterManifestSource(platform: DesktopArtifactPlatform): string {
  if (platform === "mac") return "latest-mac.yml";
  if (platform === "linux") return "latest-linux.yml";
  return "latest.yml";
}

/**
 * Updater manifest name the build for this architecture must produce.
 * electron-builder already appends the architecture to non-x64 Linux
 * manifests, so `retargetStagedEntry` only renames entries that still carry the
 * x64 source name; macOS writes `latest-mac.yml` for either architecture, so
 * Intel is retargeted there.
 *
 * - macOS: arm64 keeps `latest-mac.yml`, x64 becomes `latest-mac-x64.yml`.
 * - Linux: x64 keeps `latest-linux.yml`, arm64 is `latest-linux-arm64.yml`.
 * - Windows: one installer architecture, so `latest.yml` stays.
 */
export function stagedUpdaterManifestName(
  platform: DesktopArtifactPlatform,
  arch: DesktopArtifactArch,
): string {
  if (platform === "mac" && arch !== "arm64") return `latest-mac-${arch}.yml`;
  if (platform === "linux" && arch !== "x64") return `latest-linux-${arch}.yml`;
  return stagedUpdaterManifestSource(platform);
}

/** Renames the staged updater manifest entry, leaving every other file alone. */
export function retargetStagedEntry(
  entry: string,
  platform: DesktopArtifactPlatform,
  arch: DesktopArtifactArch,
): string {
  return entry === stagedUpdaterManifestSource(platform)
    ? stagedUpdaterManifestName(platform, arch)
    : entry;
}
