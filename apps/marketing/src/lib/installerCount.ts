// FILE: installerCount.ts
// Purpose: Fetches, summarizes, and falls back for installer download totals.
// Layer: Server utility
// Depends on: GitHub Releases API, src/data/installer-downloads.json, optional GITHUB_TOKEN

import "server-only";

import { unstable_cache } from "next/cache";

import storedInstallerDownloads from "@/data/installer-downloads.json";

const RELEASES_API_URL = "https://api.github.com/repos/Emanuele-web04/synara/releases?per_page=100";

const INSTALLER_FILE_PATTERN = /\.(dmg|exe|AppImage)$/i;

type GitHubReleaseAsset = {
  download_count?: number;
  name?: string;
};

type GitHubRelease = {
  assets?: GitHubReleaseAsset[];
};

export function getStoredInstallerCount(): number | null {
  return storedInstallerDownloads.count > 0 ? storedInstallerDownloads.count : null;
}

// Counts only actual installer artifacts so updater metadata and blockmaps do not inflate totals.
export function countInstallerDownloads(releases: GitHubRelease[]): number {
  return releases.reduce((total, release) => {
    const releaseTotal =
      release.assets?.reduce((assetTotal, asset) => {
        if (!asset.name || !INSTALLER_FILE_PATTERN.test(asset.name)) {
          return assetTotal;
        }

        return assetTotal + (asset.download_count ?? 0);
      }, 0) ?? 0;

    return total + releaseTotal;
  }, 0);
}

// Once a day is plenty for a marketing counter; the stored snapshot is refreshed
// on the same cadence. One GitHub call per day per instance instead of per visit.
const INSTALLER_COUNT_CACHE_TTL_SECONDS = 24 * 60 * 60;

// Live GitHub total. Throws when the API is unavailable or reports zero so the
// caching wrapper below never memoizes a failure.
async function fetchLiveInstallerCount(): Promise<number> {
  const headers: HeadersInit = {
    Accept: "application/vnd.github+json",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  // The releases payload (~3 MB with every asset listed) is over Next's 2 MB
  // per-entry data cache limit, so `next: { revalidate }` on this fetch would
  // silently never cache. The fetch stays uncached and the *computed count* is
  // what gets cached below.
  const response = await fetch(RELEASES_API_URL, {
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`GitHub releases request failed with status ${response.status}`);
  }

  const releases = (await response.json()) as GitHubRelease[];
  const count = countInstallerDownloads(releases);

  // New releases can briefly report zero while assets/download counts settle.
  if (count <= 0) {
    throw new Error("GitHub releases reported no installer downloads");
  }
  return count;
}

// Cached for a day (same approach as the testimonial tweets in tweets.ts), so
// homepage SSR stops paying a full GitHub Releases round-trip per visit and
// GitHub API usage drops to one call per day per instance. Only a successful
// live count is cached: `unstable_cache` does not memoize a rejected call, so
// an outage retries on the next request instead of pinning the fallback.
const fetchCachedInstallerCount = unstable_cache(
  fetchLiveInstallerCount,
  ["synara-installer-count"],
  {
    revalidate: INSTALLER_COUNT_CACHE_TTL_SECONDS,
  },
);

// Fetches live GitHub totals first, then falls back to the daily Codex-updated snapshot.
export async function getInstallerCount(): Promise<number | null> {
  if (process.env.VISUAL_TEST === "1") return getStoredInstallerCount();

  try {
    return await fetchCachedInstallerCount();
  } catch {
    return getStoredInstallerCount();
  }
}
