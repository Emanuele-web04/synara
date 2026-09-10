import {
  isValidGitHubRepositoryNameWithOwner,
  parseGitHubRepositoryNameWithOwnerFromPullRequestUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
} from "./githubRepository";
import {
  gitlabProjectWebUrl,
  gitlabRepositoryReference,
  isValidGitLabProjectPath,
  parseGitLabMergeRequestUrl,
  parseGitLabRepositoryReference,
} from "./gitlabRepository";

export const GIT_HOST_KINDS = ["github", "gitlab"] as const;
export type GitHostKind = (typeof GIT_HOST_KINDS)[number];

/**
 * Canonical repository identity. `reference` is the single string carried by contracts, cache keys,
 * and persisted pins: `owner/repository` for GitHub, `host/group/.../project` for GitLab. `path` is
 * the host-relative display path.
 */
export type RepositoryIdentity =
  | {
      readonly kind: "github";
      readonly reference: string;
      readonly host: "github.com";
      readonly path: string;
    }
  | {
      readonly kind: "gitlab";
      readonly reference: string;
      readonly host: string;
      readonly path: string;
    };

/**
 * Resolve a canonical reference into its identity. GitHub owners cannot contain dots, so a leading
 * segment with a dot unambiguously marks a GitLab reference.
 */
export function parseRepositoryReference(
  reference: string | null | undefined,
): RepositoryIdentity | null {
  const trimmed = reference?.trim() ?? "";
  if (trimmed.length === 0) return null;

  if (isValidGitHubRepositoryNameWithOwner(trimmed)) {
    return { kind: "github", reference: trimmed, host: "github.com", path: trimmed };
  }

  const gitlab = parseGitLabRepositoryReference(trimmed);
  return gitlab
    ? {
        kind: "gitlab",
        reference: gitlabRepositoryReference(gitlab.host, gitlab.fullPath),
        host: gitlab.host,
        path: gitlab.fullPath,
      }
    : null;
}

export function isValidRepositoryReference(reference: string | null | undefined): boolean {
  return parseRepositoryReference(reference) !== null;
}

export function gitHostKindForRepository(reference: string | null | undefined): GitHostKind | null {
  return parseRepositoryReference(reference)?.kind ?? null;
}

/** Split any supported git remote URL form into its hostname and repository path. */
export function parseGitRemoteUrl(
  url: string | null | undefined,
): { host: string; path: string } | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) return null;

  const match =
    /^(?:(?:ssh|https?|git):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)|(?:[^@/\s]+@)?([^/:\s]+):(.+))$/i.exec(
      trimmed,
    );
  if (!match) return null;

  const host = (match[1] ?? match[3] ?? "").toLowerCase();
  let path = match[2] ?? match[4] ?? "";
  path = path.replace(/\/+$/, "");
  if (path.toLowerCase().endsWith(".git")) path = path.slice(0, -4);
  path = path.replace(/^\/+/, "").replace(/\/+$/, "");

  if (host.length === 0 || path.split("/").filter((segment) => segment.length > 0).length < 2) {
    return null;
  }
  return { host, path };
}

/**
 * A host serves GitLab when it is gitlab.com, follows the conventional `gitlab.` prefix, or the
 * local `glab` CLI is configured for it. Every other non-github host stays unsupported so users of
 * other forges see no behaviour change.
 */
export function isGitLabHost(host: string, knownHosts: ReadonlySet<string>): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "gitlab.com" || normalized.startsWith("gitlab.") || knownHosts.has(normalized)
  );
}

export function parseRepositoryIdentityFromRemoteUrl(
  url: string | null | undefined,
  options: { readonly gitlabHosts: ReadonlySet<string> },
): RepositoryIdentity | null {
  const remote = parseGitRemoteUrl(url);
  if (!remote) return null;

  if (remote.host === "github.com") {
    const nameWithOwner = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url);
    return nameWithOwner
      ? { kind: "github", reference: nameWithOwner, host: "github.com", path: nameWithOwner }
      : null;
  }

  if (isGitLabHost(remote.host, options.gitlabHosts) && isValidGitLabProjectPath(remote.path)) {
    return {
      kind: "gitlab",
      reference: gitlabRepositoryReference(remote.host, remote.path),
      host: remote.host,
      path: remote.path,
    };
  }

  return null;
}

/** Compare a remote URL against a known canonical reference without needing the known-host set. */
export function remoteUrlMatchesRepository(
  remoteUrl: string | null | undefined,
  reference: string | null | undefined,
): boolean {
  const identity = parseRepositoryReference(reference);
  const remote = parseGitRemoteUrl(remoteUrl);
  if (!identity || !remote) return false;
  return (
    remote.host === identity.host.toLowerCase() &&
    remote.path.toLowerCase() === identity.path.toLowerCase()
  );
}

/** Resolve a GitHub pull-request or GitLab merge-request web URL into its identity and number. */
export function parsePullRequestUrl(
  url: string | null | undefined,
): { identity: RepositoryIdentity; number: number } | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) return null;

  const githubNameWithOwner = parseGitHubRepositoryNameWithOwnerFromPullRequestUrl(trimmed);
  if (githubNameWithOwner) {
    const numberMatch = /\/pull\/(\d+)(?:[/?#].*)?$/.exec(trimmed);
    const number = Number.parseInt(numberMatch?.[1] ?? "", 10);
    if (!Number.isSafeInteger(number) || number <= 0) return null;
    return {
      identity: {
        kind: "github",
        reference: githubNameWithOwner,
        host: "github.com",
        path: githubNameWithOwner,
      },
      number,
    };
  }

  const gitlab = parseGitLabMergeRequestUrl(trimmed);
  if (!gitlab) return null;
  const identity = parseRepositoryReference(gitlab.reference);
  return identity ? { identity, number: gitlab.number } : null;
}

export function gitHostKindForPullRequestUrl(url: string | null | undefined): GitHostKind | null {
  return parsePullRequestUrl(url)?.identity.kind ?? null;
}

export function repositoryWebUrl(identity: RepositoryIdentity): string {
  return identity.kind === "github"
    ? `https://github.com/${identity.path}`
    : (gitlabProjectWebUrl(identity.reference) ?? `https://${identity.host}/${identity.path}`);
}

export function gitHostDisplayName(kind: GitHostKind): "GitHub" | "GitLab" {
  return kind === "github" ? "GitHub" : "GitLab";
}

export function gitHostCliName(kind: GitHostKind): "gh" | "glab" {
  return kind === "github" ? "gh" : "glab";
}
