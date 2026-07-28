// FILE: unifiedPatchStats.ts
// Purpose: Count +additions / -deletions / files from a unified diff without building a
//          parsed representation of it.
// Layer: Shared git utility

/**
 * Totals for one unified patch, or `null` when the patch contains no file sections.
 *
 * `null` rather than a zero-filled record so callers can tell "no diff" from "a diff whose
 * every file happens to be binary" — the badge surfaces treat those differently.
 */
export interface UnifiedPatchTotals {
  additions: number;
  deletions: number;
  fileCount: number;
}

/**
 * Summarize a unified patch by scanning it once, line by line.
 *
 * This exists so the server can answer "how many lines changed?" without shipping the patch
 * text to the renderer. The counting rules deliberately mirror what a full patch parse
 * produces, because both numbers reach the same badge:
 *
 * - `+`/`-` lines count, except the `+++`/`---` file headers that introduce each section.
 * - A file counts once per `diff --git` header. Binary files and pure renames therefore
 *   still raise `fileCount` while contributing no line counts, exactly as a parsed patch
 *   with zero hunks does.
 * - Lines outside any hunk (`index`, `similarity index`, `Binary files … differ`) are
 *   skipped, so a `-` in a commit message or a filename can never be miscounted.
 *
 * `apps/web/src/lib/diffRendering.parity.test.ts` asserts these totals stay equal to the
 * ones the web app derives from a fully parsed patch. Change the rules here only alongside
 * that test.
 */
export function summarizeUnifiedPatchTotals(
  patch: string | null | undefined,
): UnifiedPatchTotals | null {
  if (!patch) return null;
  const trimmed = patch.trim();
  if (trimmed.length === 0) return null;

  let additions = 0;
  let deletions = 0;
  let fileCount = 0;
  // Only lines inside a hunk are content. Headers before the first `@@` of a section carry
  // `+++`/`---` markers that would otherwise read as content lines.
  let insideHunk = false;

  let lineStart = 0;
  while (lineStart <= trimmed.length) {
    let lineEnd = trimmed.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = trimmed.length;
    const firstChar = lineStart < lineEnd ? trimmed.charCodeAt(lineStart) : -1;

    if (firstChar === 100 /* d */ && startsWith(trimmed, lineStart, lineEnd, "diff --git ")) {
      fileCount += 1;
      insideHunk = false;
    } else if (firstChar === 64 /* @ */ && startsWith(trimmed, lineStart, lineEnd, "@@")) {
      insideHunk = true;
    } else if (insideHunk) {
      if (firstChar === 43 /* + */) {
        additions += 1;
      } else if (firstChar === 45 /* - */) {
        deletions += 1;
      }
    }

    lineStart = lineEnd + 1;
  }

  // A patch git produced without `diff --git` headers (for example `diff --no-index` output
  // stitched in for untracked files) still has hunks; count it as a single file rather than
  // reporting zero files for a diff that plainly has content.
  if (fileCount === 0) {
    if (additions === 0 && deletions === 0) return null;
    fileCount = 1;
  }

  return { additions, deletions, fileCount };
}

function startsWith(source: string, lineStart: number, lineEnd: number, prefix: string): boolean {
  if (lineEnd - lineStart < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (source.charCodeAt(lineStart + index) !== prefix.charCodeAt(index)) return false;
  }
  return true;
}
