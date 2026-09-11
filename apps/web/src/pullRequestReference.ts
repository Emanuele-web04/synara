import { parsePullRequestUrl } from "@synara/shared/gitHostRepository";

// `#12` (GitHub) and `!12` (GitLab) both mean "this repository's request number 12"; the server
// normalizes either sigil to the bare number before it reaches gh or glab.
const PULL_REQUEST_NUMBER_PATTERN = /^[#!]?(\d+)$/;

export function parsePullRequestReference(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // A pull-request or merge-request URL is passed through verbatim: it carries its own host.
  if (parsePullRequestUrl(trimmed)) {
    return trimmed;
  }

  const numberMatch = PULL_REQUEST_NUMBER_PATTERN.exec(trimmed);
  if (numberMatch?.[1]) {
    return /^[#!]/.test(trimmed) ? `#${numberMatch[1]}` : numberMatch[1];
  }

  return null;
}
