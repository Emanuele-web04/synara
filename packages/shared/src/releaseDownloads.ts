// FILE: releaseDownloads.ts
// Purpose: Maps a GitHub release's assets to the per-platform installer URLs used
//          by the marketing download page and its release snapshot.
// Layer: Pure shared module (no React, no server-only imports)

export interface ReleaseAsset {
  readonly name?: string;
  readonly browser_download_url?: string;
}

export interface GitHubReleaseAssets {
  readonly tag_name?: string;
  readonly html_url?: string;
  readonly assets?: ReadonlyArray<ReleaseAsset>;
}

export interface ReleaseDownloads {
  /** Tag for the latest release (for example "v1.5.1"), or null when unknown. */
  readonly version: string | null;
  /** Page that lists every asset; used as the per-asset fallback target. */
  readonly releasesUrl: string;
  readonly mac: { readonly arm64: string; readonly x64: string };
  readonly windows: string;
  readonly linux: { readonly x64: string; readonly arm64: string };
}

/**
 * Asset-name patterns per target. Linux AppImages are named by architecture
 * (`Synara-<version>-x86_64.AppImage`, `Synara-<version>-arm64.AppImage`), so the
 * Intel pattern must not match the ARM build or vice versa.
 */
export const RELEASE_ASSET_PATTERNS = {
  macArm64: /arm64\.dmg$/i,
  macX64: /x64\.dmg$/i,
  windows: /\.exe$/i,
  linuxX64: /x86_64\.AppImage$/i,
  linuxArm64: /arm64\.AppImage$/i,
} as const;

export function mapReleaseAssets(
  release: GitHubReleaseAssets,
  fallbackUrl: string,
): ReleaseDownloads {
  const assets = release.assets ?? [];
  const releasesUrl = release.html_url ?? fallbackUrl;
  // First asset whose name matches wins; the listing page is the fallback.
  const urlFor = (pattern: RegExp): string =>
    assets.find((asset) => asset.name && pattern.test(asset.name))?.browser_download_url ??
    releasesUrl;

  return {
    version: release.tag_name ?? null,
    releasesUrl,
    mac: {
      arm64: urlFor(RELEASE_ASSET_PATTERNS.macArm64),
      x64: urlFor(RELEASE_ASSET_PATTERNS.macX64),
    },
    windows: urlFor(RELEASE_ASSET_PATTERNS.windows),
    linux: {
      x64: urlFor(RELEASE_ASSET_PATTERNS.linuxX64),
      arm64: urlFor(RELEASE_ASSET_PATTERNS.linuxArm64),
    },
  };
}

/**
 * Narrows a stored offline snapshot. Older snapshots stored `linux` as a single
 * URL string and predate the arm64 build; those are rejected rather than
 * rendered as an install page with a missing architecture link.
 */
export function parseReleaseDownloadsSnapshot(value: unknown): ReleaseDownloads | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Omit<ReleaseDownloads, "linux">> & {
    linux?: Partial<ReleaseDownloads["linux"]> | null;
  };
  const { version, releasesUrl, windows } = candidate;
  const mac = candidate.mac;
  const linux = candidate.linux;
  if (
    typeof version !== "string" ||
    version.length === 0 ||
    typeof releasesUrl !== "string" ||
    releasesUrl.length === 0 ||
    typeof mac?.arm64 !== "string" ||
    mac.arm64.length === 0 ||
    typeof mac?.x64 !== "string" ||
    mac.x64.length === 0 ||
    typeof windows !== "string" ||
    windows.length === 0 ||
    typeof linux?.x64 !== "string" ||
    linux.x64.length === 0 ||
    typeof linux?.arm64 !== "string" ||
    linux.arm64.length === 0
  ) {
    return null;
  }
  return {
    version,
    releasesUrl,
    mac: { arm64: mac.arm64, x64: mac.x64 },
    windows,
    linux: { x64: linux.x64, arm64: linux.arm64 },
  };
}
