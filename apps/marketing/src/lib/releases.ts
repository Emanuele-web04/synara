// FILE: releases.ts
// Purpose: Fetches the latest GitHub release and maps its assets to a per-platform
//          download map (macOS arm64/x64, Windows, Linux x64/arm64) for /install.
// Layer: Server utility
// Depends on: GitHub Releases API, optional GITHUB_TOKEN, shared asset mapping
// Note: The repo was renamed from its previous identity to synara. We hit the
//       canonical "synara" slug
//       directly so we don't depend on the API following GitHub's 301 redirect.

import "server-only";

import {
  mapReleaseAssets,
  parseReleaseDownloadsSnapshot,
  type GitHubReleaseAssets,
  type ReleaseDownloads,
} from "@synara/shared/releaseDownloads";
import storedLatestReleaseDownloads from "@/data/latest-release-downloads.json";

const REPO = "Emanuele-web04/synara";
const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export const RELEASES_URL = `https://github.com/${REPO}/releases`;

export type { ReleaseDownloads };

const STORED_FALLBACK: unknown = storedLatestReleaseDownloads;

// Last-resort fallback: the public release listing is better than a broken href.
const FALLBACK: ReleaseDownloads = {
  version: null,
  releasesUrl: RELEASES_URL,
  mac: { arm64: RELEASES_URL, x64: RELEASES_URL },
  windows: RELEASES_URL,
  linux: { x64: RELEASES_URL, arm64: RELEASES_URL },
};

// Uses the checked-in snapshot before the generic releases page so installer
// links remain direct even when GitHub's API blocks the production server.
function getFallbackDownloads(): ReleaseDownloads {
  return parseReleaseDownloadsSnapshot(STORED_FALLBACK) ?? FALLBACK;
}

export async function getReleaseDownloads(): Promise<ReleaseDownloads> {
  if (process.env.VISUAL_TEST === "1") return getFallbackDownloads();

  try {
    const headers: HeadersInit = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const response = await fetch(LATEST_RELEASE_API_URL, {
      headers,
      // Release artifacts change rarely; cache for 30 minutes.
      next: { revalidate: 1800 },
    });

    if (!response.ok) return getFallbackDownloads();

    return mapReleaseAssets((await response.json()) as GitHubReleaseAssets, RELEASES_URL);
  } catch {
    return getFallbackDownloads();
  }
}
