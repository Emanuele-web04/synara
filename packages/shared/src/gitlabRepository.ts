/** GitLab.com hostname, used when a project reference omits its host. */
export const GITLAB_DEFAULT_HOST = "gitlab.com";

const HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?$/i;
const PROJECT_SEGMENT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** GitLab accepts self-hosted instances, so any DNS-shaped host with an optional port qualifies. */
export function isValidGitLabHost(host: string): boolean {
  const normalized = host.trim();
  if (normalized.length === 0 || normalized.length > 253) return false;
  return HOST_PATTERN.test(normalized);
}

/**
 * Validate a GitLab project path. Unlike GitHub, GitLab nests projects under groups and subgroups,
 * so a path carries between two and twenty-one segments (one project plus up to twenty groups).
 */
export function isValidGitLabProjectPath(path: string): boolean {
  const normalized = path.trim();
  if (normalized.length === 0 || normalized.length > 255) return false;

  const segments = normalized.split("/");
  if (segments.length < 2 || segments.length > 21) return false;

  return segments.every(
    (segment) =>
      segment !== "." &&
      segment !== ".." &&
      !segment.toLowerCase().endsWith(".git") &&
      PROJECT_SEGMENT_PATTERN.test(segment),
  );
}

/** Build the canonical `host/group/.../project` reference used across contracts and caches. */
export function gitlabRepositoryReference(host: string, fullPath: string): string {
  return `${host.trim().toLowerCase()}/${fullPath.trim()}`;
}

/** Split a canonical GitLab reference back into its hostname and project path. */
export function parseGitLabRepositoryReference(
  reference: string | null | undefined,
): { host: string; fullPath: string } | null {
  const normalized = reference?.trim() ?? "";
  const separator = normalized.indexOf("/");
  if (separator <= 0) return null;

  const host = normalized.slice(0, separator).toLowerCase();
  const fullPath = normalized.slice(separator + 1);
  // The leading segment must be a hostname: the dot is what distinguishes a GitLab reference from
  // a GitHub `owner/repository` pair, because GitHub owners cannot contain dots.
  if (!host.includes(".") || !isValidGitLabHost(host)) return null;
  if (!isValidGitLabProjectPath(fullPath)) return null;

  return { host, fullPath };
}

/**
 * Parse the input surface accepted when provisioning a GitLab project: `group/project`,
 * `host/group/project`, or a credential-free GitLab project URL.
 */
export function parseGitLabRepositoryInput(
  input: string | null | undefined,
  defaultHost: string = GITLAB_DEFAULT_HOST,
): string | null {
  const trimmed = input?.trim() ?? "";
  if (trimmed.length === 0) return null;

  const urlMatch = /^https?:\/\/([^/\s]+)\/(.+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (urlMatch) {
    const host = urlMatch[1] ?? "";
    const fullPath = urlMatch[2] ?? "";
    // `/-/` introduces GitLab's per-resource routes (tree, merge_requests, ...), never a project.
    if (fullPath.split("/").includes("-")) return null;
    if (!isValidGitLabHost(host) || !isValidGitLabProjectPath(fullPath)) return null;
    return gitlabRepositoryReference(host, fullPath);
  }

  const reference = parseGitLabRepositoryReference(trimmed);
  if (reference) return gitlabRepositoryReference(reference.host, reference.fullPath);

  return isValidGitLabProjectPath(trimmed) && isValidGitLabHost(defaultHost)
    ? gitlabRepositoryReference(defaultHost, trimmed)
    : null;
}

/** Extract the project reference and MR number from a GitLab merge-request web URL. */
export function parseGitLabMergeRequestUrl(
  url: string | null | undefined,
): { reference: string; number: number } | null {
  const match = /^https?:\/\/([^/\s]+)\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/i.exec(
    url?.trim() ?? "",
  );
  if (!match) return null;

  const host = match[1] ?? "";
  const fullPath = match[2] ?? "";
  const number = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  if (!isValidGitLabHost(host) || !isValidGitLabProjectPath(fullPath)) return null;

  return { reference: gitlabRepositoryReference(host, fullPath), number };
}

/** Web URL for a merge request on a canonical GitLab reference. */
export function gitlabMergeRequestUrl(reference: string, number: number): string | null {
  const parsed = parseGitLabRepositoryReference(reference);
  return parsed ? `https://${parsed.host}/${parsed.fullPath}/-/merge_requests/${number}` : null;
}

/** Web URL for a canonical GitLab reference. */
export function gitlabProjectWebUrl(reference: string): string | null {
  const parsed = parseGitLabRepositoryReference(reference);
  return parsed ? `https://${parsed.host}/${parsed.fullPath}` : null;
}

/** REST path prefix for a project; GitLab requires the project path to be URL-encoded whole. */
export function gitlabProjectApiPath(reference: string): string | null {
  const parsed = parseGitLabRepositoryReference(reference);
  return parsed ? `projects/${encodeURIComponent(parsed.fullPath)}` : null;
}

/** Self-hosted GitLab returns host-relative URLs for avatars, pipelines, and jobs. */
export function gitlabAbsoluteUrl(host: string, value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/")) return `https://${host.trim().toLowerCase()}${trimmed}`;
  return null;
}
