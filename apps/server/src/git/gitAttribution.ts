// FILE: gitAttribution.ts
// Purpose: The optional "Created with Synara" footer appended to the description of a
//          pull request Synara creates.
// Layer: Git text helpers (pure)
// Exports: PULL_REQUEST_ATTRIBUTION_FOOTER, appendPullRequestAttribution

/** Last line of a pull request description Synara creates. */
export const PULL_REQUEST_ATTRIBUTION_FOOTER = "Created with [Synara](https://www.trysynara.com/)";

// The linked footer, its plain form, and small URL variations all count as already attributed.
const PULL_REQUEST_FOOTER_PATTERN =
  /^created with (?:synara|\[synara\]\(https?:\/\/(?:www\.)?trysynara\.com\/?\))$/i;

/**
 * Ends a pull request description with the Synara footer, separated by a blank line.
 * A description that already carries the footer anywhere is returned unchanged.
 */
export function appendPullRequestAttribution(body: string): string {
  if (body.split(/\r?\n/).some((line) => PULL_REQUEST_FOOTER_PATTERN.test(line.trim()))) {
    return body;
  }
  const trimmed = body.trimEnd();
  return trimmed.length > 0
    ? `${trimmed}\n\n${PULL_REQUEST_ATTRIBUTION_FOOTER}`
    : PULL_REQUEST_ATTRIBUTION_FOOTER;
}
