// FILE: pullRequestComment.logic.ts
// Purpose: Pure detector for "finding-style" review comments (bots like Cursor Bugbot post a
//          leading markdown H1/H2/H3 title followed by a "High|Medium|Low Severity" line) so the
//          detail panel's comment cards can elevate them into a styled title + severity
//          subheading instead of rendering the raw markdown heading inline. Ordinary comments
//          that don't match this shape fall back to plain markdown rendering untouched.
// Layer: Web domain helpers (no React)
// Exports: PullRequestCommentSeverity, ParsedFindingComment, parseFindingComment

export type PullRequestCommentSeverity = "High" | "Medium" | "Low";

export interface ParsedFindingComment {
  title: string;
  severity: PullRequestCommentSeverity;
  /** Remaining body markdown, with the title heading and severity line removed. */
  body: string;
}

const HEADING_LINE_RE = /^#{1,3}\s+(.+?)\s*$/;
const SEVERITY_LINE_RE = /^(high|medium|low)\s+severity$/i;

function normalizeSeverityLine(raw: string): string {
  const withoutHeading = raw.trim().replace(/^#{1,4}\s+/, "");
  const emphasis = /^(\*\*|__)(.+)\1$/.exec(withoutHeading);
  return (emphasis?.[2] ?? withoutHeading).trim();
}

function titleCaseSeverity(raw: string): PullRequestCommentSeverity {
  const lower = raw.toLowerCase();
  return (lower.charAt(0).toUpperCase() + lower.slice(1)) as PullRequestCommentSeverity;
}

function nextNonBlankIndex(lines: readonly string[], from: number): number {
  let index = from;
  while (index < lines.length && lines[index]?.trim() === "") index += 1;
  return index;
}

/**
 * Detects a leading H1-H3 title immediately followed (allowing blank lines) by a
 * standalone `High|Medium|Low Severity` line, and returns the title, severity, and remaining body
 * with both lines stripped. Returns null for any comment that doesn't match this exact shape —
 * ordinary comments (including ones that merely start with a heading, or a bot summary line) are
 * left for plain markdown rendering.
 */
export function parseFindingComment(body: string): ParsedFindingComment | null {
  const lines = body.split(/\r?\n/);

  const titleIndex = nextNonBlankIndex(lines, 0);
  const headingMatch = lines[titleIndex]?.match(HEADING_LINE_RE);
  if (!headingMatch) return null;
  const title = headingMatch[1]?.trim();
  if (!title) return null;

  const severityIndex = nextNonBlankIndex(lines, titleIndex + 1);
  const severityMatch = normalizeSeverityLine(lines[severityIndex] ?? "").match(SEVERITY_LINE_RE);
  if (!severityMatch || severityIndex >= lines.length) return null;
  const severityWord = severityMatch[1];
  if (!severityWord) return null;

  const restIndex = nextNonBlankIndex(lines, severityIndex + 1);
  const restBody = lines.slice(restIndex).join("\n").trim();

  return {
    title,
    severity: titleCaseSeverity(severityWord),
    body: restBody,
  };
}
