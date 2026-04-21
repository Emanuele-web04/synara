type GitHubUpdateSource = {
  readonly owner: string;
  readonly repo: string;
  readonly host: string;
  readonly protocol: "http" | "https";
};

type GitHubReleaseRecord = {
  readonly tag_name?: unknown;
  readonly draft?: unknown;
  readonly prerelease?: unknown;
};

export type LatestGitHubRelease = {
  readonly tag: string;
  readonly version: string;
};

type ParsedVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
};

function normalizeGitHubProtocol(protocol: string | undefined): "http" | "https" {
  return protocol === "http" ? "http" : "https";
}

function parseStableSemver(rawTag: string): ParsedVersion | null {
  const match = rawTag.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareParsedVersions(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

function getGitHubApiBaseUrl(source: GitHubUpdateSource): URL {
  if (source.host === "github.com" || source.host === "api.github.com") {
    return new URL(`${source.protocol}://api.github.com`);
  }
  return new URL(`${source.protocol}://${source.host}/api/v3`);
}

export function resolveGitHubUpdateSource(
  rawConfig: Record<string, string> | null,
): GitHubUpdateSource | null {
  if (rawConfig?.provider !== "github") {
    return null;
  }

  const owner = rawConfig.owner?.trim();
  const repo = rawConfig.repo?.trim();
  if (!owner || !repo) {
    return null;
  }

  return {
    owner,
    repo,
    host: rawConfig.host?.trim() || "github.com",
    protocol: normalizeGitHubProtocol(rawConfig.protocol?.trim()),
  };
}

export function pickLatestStableGitHubRelease(
  releases: ReadonlyArray<GitHubReleaseRecord>,
): LatestGitHubRelease | null {
  let best: LatestGitHubRelease | null = null;
  let bestVersion: ParsedVersion | null = null;

  for (const release of releases) {
    if (release.draft === true || release.prerelease === true) {
      continue;
    }

    const tag = typeof release.tag_name === "string" ? release.tag_name.trim() : "";
    if (tag.length === 0) {
      continue;
    }

    const version = parseStableSemver(tag);
    if (version === null) {
      continue;
    }

    if (bestVersion === null || compareParsedVersions(version, bestVersion) > 0) {
      bestVersion = version;
      best = {
        tag,
        version: `${version.major}.${version.minor}.${version.patch}`,
      };
    }
  }

  return best;
}

export function buildGitHubReleaseDownloadBaseUrl(source: GitHubUpdateSource, tag: string): string {
  return new URL(
    `/${source.owner}/${source.repo}/releases/download/${tag}/`,
    `${source.protocol}://${source.host}`,
  ).toString();
}

export async function resolveLatestStableGitHubRelease(
  source: GitHubUpdateSource,
  token?: string,
): Promise<LatestGitHubRelease | null> {
  const apiBaseUrl = getGitHubApiBaseUrl(source);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  if (token && token.trim().length > 0) {
    headers.Authorization = `token ${token.trim()}`;
  }

  const releases: GitHubReleaseRecord[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const requestUrl = new URL(
      `/repos/${source.owner}/${source.repo}/releases?per_page=100&page=${page}`,
      apiBaseUrl,
    );
    const response = await fetch(requestUrl, { headers });
    if (!response.ok) {
      throw new Error(`GitHub releases request failed (${response.status} ${response.statusText})`);
    }

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload) || payload.length === 0) {
      break;
    }

    releases.push(...(payload as GitHubReleaseRecord[]));
    if (payload.length < 100) {
      break;
    }
  }

  return pickLatestStableGitHubRelease(releases);
}
