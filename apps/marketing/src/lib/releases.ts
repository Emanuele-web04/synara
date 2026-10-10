// the repo was renamed — hit the canonical synara slug directly instead of depending on the API following GitHub's 301

import "server-only";

import storedLatestReleaseDownloads from "@/data/latest-release-downloads.json";

const REPO = "Emanuele-web04/synara";
const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export const RELEASES_URL = `https://github.com/${REPO}/releases`;

export type ReleaseDownloads = {
  version: string | null;
  // Page that lists every asset — used as the universal fallback target.
  releasesUrl: string;
  mac: { arm64: string; x64: string };
  windows: string;
  linux: string;
};

type GitHubReleaseAsset = {
  name?: string;
  browser_download_url?: string;
};

type GitHubRelease = {
  tag_name?: string;
  html_url?: string;
  assets?: GitHubReleaseAsset[];
};

type StoredReleaseDownloads = ReleaseDownloads & {
  updatedAt?: string;
  source?: string;
};

const STORED_FALLBACK = storedLatestReleaseDownloads as StoredReleaseDownloads;

// Last-resort fallback: the public release listing is better than a broken href.
const FALLBACK: ReleaseDownloads = {
  version: null,
  releasesUrl: RELEASES_URL,
  mac: { arm64: RELEASES_URL, x64: RELEASES_URL },
  windows: RELEASES_URL,
  linux: RELEASES_URL,
};

// the checked-in snapshot beats the generic releases page so installer links stay direct when GitHub's API blocks the production server
function getFallbackDownloads(): ReleaseDownloads {
  return STORED_FALLBACK.version &&
    STORED_FALLBACK.mac?.arm64 &&
    STORED_FALLBACK.mac?.x64 &&
    STORED_FALLBACK.windows &&
    STORED_FALLBACK.linux
    ? {
        version: STORED_FALLBACK.version,
        releasesUrl: STORED_FALLBACK.releasesUrl,
        mac: STORED_FALLBACK.mac,
        windows: STORED_FALLBACK.windows,
        linux: STORED_FALLBACK.linux,
      }
    : FALLBACK;
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

    const release = (await response.json()) as GitHubRelease;
    const assets = release.assets ?? [];
    const releasesUrl = release.html_url ?? RELEASES_URL;

    const urlFor = (pattern: RegExp): string =>
      assets.find((asset) => asset.name && pattern.test(asset.name))?.browser_download_url ??
      releasesUrl;

    return {
      version: release.tag_name ?? null,
      releasesUrl,
      mac: {
        arm64: urlFor(/arm64\.dmg$/i),
        x64: urlFor(/x64\.dmg$/i),
      },
      windows: urlFor(/\.exe$/i),
      linux: urlFor(/\.AppImage$/i),
    };
  } catch {
    return getFallbackDownloads();
  }
}
