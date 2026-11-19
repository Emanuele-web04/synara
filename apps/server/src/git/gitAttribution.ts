// FILE: gitAttribution.ts
// Purpose: The optional "Created with Synara" attribution appended to text Synara writes:
//          the footer of a new pull request description and the trailer of a new commit.
// Layer: Git text helpers (pure)
// Exports: PULL_REQUEST_ATTRIBUTION_FOOTER, COMMIT_ATTRIBUTION_TRAILER,
//          appendPullRequestAttribution, appendCommitAttribution

/** Last line of a pull request description Synara creates. */
export const PULL_REQUEST_ATTRIBUTION_FOOTER = "Created with [Synara](https://www.trysynara.com/)";

/** Git trailer added to the end of a commit message Synara authors. */
export const COMMIT_ATTRIBUTION_TRAILER = "Created-with: Synara";

// The linked footer, its plain form, and small URL variations all count as already attributed.
const PULL_REQUEST_FOOTER_PATTERN =
  /^created with (?:synara|\[synara\]\(https?:\/\/(?:www\.)?trysynara\.com\/?\))$/i;
const COMMIT_TRAILER_PATTERN = /^created-with:\s*synara$/i;
// `Token: value`, as git interpret-trailers reads it (e.g. Co-authored-by, Signed-off-by).
const GIT_TRAILER_LINE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*:\s+\S/;
// Indented lines continue the previous trailer's value.
const GIT_TRAILER_CONTINUATION_PATTERN = /^[ \t]+\S/;

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function hasLineMatching(text: string, pattern: RegExp): boolean {
  return splitLines(text).some((line) => pattern.test(line.trim()));
}

function isTrailerParagraph(paragraph: string): boolean {
  const lines = splitLines(paragraph);
  if (!GIT_TRAILER_LINE_PATTERN.test(lines[0] ?? "")) {
    return false;
  }
  return lines.every(
    (line) => GIT_TRAILER_LINE_PATTERN.test(line) || GIT_TRAILER_CONTINUATION_PATTERN.test(line),
  );
}

/**
 * Ends a pull request description with the Synara footer, separated by a blank line.
 * A description that already carries the footer anywhere is returned unchanged.
 */
export function appendPullRequestAttribution(body: string): string {
  if (hasLineMatching(body, PULL_REQUEST_FOOTER_PATTERN)) {
    return body;
  }
  const trimmed = body.trimEnd();
  return trimmed.length > 0
    ? `${trimmed}\n\n${PULL_REQUEST_ATTRIBUTION_FOOTER}`
    : PULL_REQUEST_ATTRIBUTION_FOOTER;
}

/**
 * Ends a commit message body (never the subject) with the Synara trailer. When the body
 * already ends in a git trailer block, the trailer joins that block so it stays valid;
 * otherwise it starts a new paragraph. A body that already has the trailer is unchanged.
 */
export function appendCommitAttribution(body: string): string {
  if (hasLineMatching(body, COMMIT_TRAILER_PATTERN)) {
    return body;
  }
  const trimmed = body.trimEnd();
  if (trimmed.trim().length === 0) {
    return COMMIT_ATTRIBUTION_TRAILER;
  }
  const paragraphs = trimmed.split(/\r?\n(?:[ \t]*\r?\n)+/);
  const lastParagraph = paragraphs[paragraphs.length - 1] ?? "";
  const separator = isTrailerParagraph(lastParagraph) ? "\n" : "\n\n";
  return `${trimmed}${separator}${COMMIT_ATTRIBUTION_TRAILER}`;
}
