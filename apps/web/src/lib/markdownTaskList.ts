// FILE: markdownTaskList.ts
// Purpose: Pure helper for interactive GFM task lists in rendered markdown
//          previews: flip the `[ ]` / `[x]` marker on a known source line.
// Layer: Web logic helpers
// Exports: toggleMarkdownTaskMarker

// A GFM task item line: optional blockquote markers and indentation, a list
// bullet (`-`, `*`, `+`, or ordered `1.` / `1)`), then the checkbox marker.
const TASK_MARKER_PATTERN = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[)[ xX](\])/;

/**
 * Returns `contents` with the task marker on `sourceLine` (1-based) set to
 * `checked`, or null when that line does not start a task item (stale line
 * number, file edited meanwhile) so callers skip the write instead of
 * corrupting the file.
 */
export function toggleMarkdownTaskMarker(
  contents: string,
  sourceLine: number,
  checked: boolean,
): string | null {
  const lines = contents.split("\n");
  const index = sourceLine - 1;
  const line = lines[index];
  if (line === undefined) {
    return null;
  }
  const match = TASK_MARKER_PATTERN.exec(line);
  if (!match) {
    return null;
  }
  lines[index] = `${match[1]}${checked ? "x" : " "}${match[2]}${line.slice(match[0].length)}`;
  return lines.join("\n");
}
