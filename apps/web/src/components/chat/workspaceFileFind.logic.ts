// FILE: workspaceFileFind.logic.ts
// Purpose: Pure matching and navigation helpers for the in-preview file finder.
// Layer: Chat/editor file-preview presentation-adjacent logic (unit-tested)

export interface WorkspaceFileFindRange {
  startOffset: number;
  endOffset: number;
}

export type WorkspaceFileFindStepDirection = "next" | "previous";

/** Window event used by the app-level keybinding dispatcher to target the focused preview. */
export const WORKSPACE_FILE_PREVIEW_FIND_EVENT = "synara:file-preview-find";

/** Whether a mounted preview should expose the in-preview finder. */
export function workspaceFileFindEnabled(input: {
  fileContentsReady: boolean;
  fileIsImage: boolean;
  editableDocument: boolean;
  showMarkdownPreview: boolean;
}): boolean {
  return (
    input.fileContentsReady &&
    !input.fileIsImage &&
    (!input.editableDocument || input.showMarkdownPreview)
  );
}

/**
 * Return non-overlapping, case-insensitive matches in source order.
 *
 * File preview content is already in memory, so matching stays local and can
 * be recomputed after a live file refresh without another RPC.
 */
export function collectWorkspaceFileFindMatches(
  text: string,
  query: string,
  maxMatches = Number.POSITIVE_INFINITY,
): WorkspaceFileFindRange[] {
  const needle = query.trim();
  if (needle.length === 0 || text.length === 0 || maxMatches <= 0) return [];

  // Case conversion can change UTF-16 length (for example, İ becomes i + ◌̇).
  // Match the original text so offsets remain valid for DOM Range boundaries.
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const ranges: WorkspaceFileFindRange[] = [];
  for (const match of text.matchAll(pattern)) {
    ranges.push({ startOffset: match.index, endOffset: match.index + match[0].length });
    if (ranges.length >= maxMatches) break;
  }
  return ranges;
}

/** Wrap the active index so Enter and Shift+Enter cycle through every match. */
export function stepWorkspaceFileFindIndex(
  matchCount: number,
  activeIndex: number,
  direction: WorkspaceFileFindStepDirection,
): number {
  if (matchCount <= 0) return -1;
  const safeIndex = Math.min(Math.max(activeIndex, 0), matchCount - 1);
  return direction === "next"
    ? (safeIndex + 1) % matchCount
    : (safeIndex - 1 + matchCount) % matchCount;
}

/** Resolve a source offset to its zero-based line number for source scrolling. */
export function lineIndexForWorkspaceFileFindOffset(text: string, offset: number): number {
  const boundedOffset = Math.min(Math.max(offset, 0), text.length);
  let line = 0;
  for (let index = 0; index < boundedOffset; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}
