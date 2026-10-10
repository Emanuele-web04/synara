type GitHubUpdateSource = {
  readonly owner: string;
  readonly repo: string;
  readonly host: string;
  readonly protocol: "http" | "https";
};

function normalizeGitHubProtocol(protocol: string | undefined): "http" | "https" {
  return protocol === "http" ? "http" : "https";
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

export function buildGitHubReleasesPageUrl(source: GitHubUpdateSource, tag?: string): string {
  const path =
    tag && tag.trim().length > 0
      ? `/${source.owner}/${source.repo}/releases/tag/${tag.trim()}`
      : `/${source.owner}/${source.repo}/releases/latest`;
  return new URL(path, `${source.protocol}://${source.host}`).toString();
}
