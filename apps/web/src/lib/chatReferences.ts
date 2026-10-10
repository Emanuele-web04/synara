import { CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS, type ThreadId } from "@synara/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { requestComposerFocus } from "../composerFocusRequestStore";
import { formatComposerMentionToken } from "./composerMentions";
import { createFileCommentDraft, type FileCommentSelection } from "./fileComments";
import { type PullRequestContextDraft } from "./pullRequestContext";

export interface ChatFileReference {
  path: string;
  startLine?: number;
  endLine?: number;
  // 1-based columns narrow the reference to the exact span (line 21:5-12) so a highlighted word doesn't reference the whole line
  startColumn?: number;
  endColumn?: number;
  // verbatim text for surfaces that can't map selections back to source lines (diff views renumber) — the snippet itself is the reference; ignored when line info is present
  snippet?: string;
}

export const CHAT_FILE_REFERENCE_DRAG_TYPE = "application/x-synara-file-reference";

export function formatLineRangeLabel(startLine: number, endLine: number): string {
  return endLine !== startLine ? `lines ${startLine}-${endLine}` : `line ${startLine}`;
}

// fence longer than any backtick run inside the snippet so selected code containing ``` survives markdown
export function fenceCodeSnippet(snippet: string): string {
  const normalized = snippet.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  const truncated =
    normalized.length > CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS
      ? normalized.slice(0, CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS)
      : normalized;
  const longestBacktickRun = truncated
    .match(/`+/g)
    ?.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, (longestBacktickRun ?? 0) + 1));
  return `${fence}\n${truncated}\n${fence}`;
}

// columns appended only when both ends are known, so a single word reads `line 21:5-12`; null when no line info
export function formatSelectionLabel(reference: ChatFileReference): string | null {
  if (typeof reference.startLine !== "number") {
    return null;
  }
  const endLine = reference.endLine ?? reference.startLine;
  const { startColumn, endColumn } = reference;
  if (typeof startColumn !== "number" || typeof endColumn !== "number") {
    return formatLineRangeLabel(reference.startLine, endLine);
  }
  if (reference.startLine === endLine) {
    const columns = startColumn === endColumn ? `${startColumn}` : `${startColumn}-${endColumn}`;
    return `line ${reference.startLine}:${columns}`;
  }
  return `lines ${reference.startLine}:${startColumn}-${endLine}:${endColumn}`;
}

// range/columns live outside the mention token so provider file resolution keeps working; snippet-only reference when there's no line info
export function formatChatFileReference(reference: ChatFileReference): string {
  const token = formatComposerMentionToken(reference.path);
  const label = formatSelectionLabel(reference);
  if (label) {
    return `${token} (${label})`;
  }
  if (reference.snippet !== undefined && reference.snippet.trim().length > 0) {
    return `${token}\n${fenceCodeSnippet(reference.snippet)}`;
  }
  return token;
}

export function buildWhyChangedPrompt(path: string): string {
  return `Why did we implement the changes in ${formatComposerMentionToken(path)}?`;
}

// "Why" prompt for an arbitrary file or line range. Providers run in the workspace, so the prompt steers them toward git blame/history for evidence.
export function buildWhyLinesPrompt(reference: ChatFileReference): string {
  const token = formatComposerMentionToken(reference.path);
  if (typeof reference.startLine !== "number") {
    return `Why did we implement ${token} this way? Check the git history if needed and explain the reasoning.`;
  }
  const endLine = reference.endLine ?? reference.startLine;
  return `Why were ${formatLineRangeLabel(reference.startLine, endLine)} in ${token} implemented this way? Check git blame/history for the relevant commits and explain the reasoning.`;
}

// diff rows have no stable source line numbers (split/unified renumber) — the quoted code itself is the precise reference
export function buildDiffSelectionReference(path: string, snippet: string): string {
  return formatChatFileReference({ path, snippet });
}

export function appendComposerPromptText(threadId: ThreadId, text: string): void {
  const store = useComposerDraftStore.getState();
  const existingPrompt = store.draftsByThreadId[threadId]?.prompt ?? "";
  const needsSeparator = existingPrompt.length > 0 && !/\s$/.test(existingPrompt);
  store.setPrompt(threadId, `${existingPrompt}${needsSeparator ? " " : ""}${text} `);
  requestComposerFocus(threadId);
}

export function appendChatFileReference(threadId: ThreadId, reference: ChatFileReference): void {
  appendComposerPromptText(threadId, formatChatFileReference(reference));
}

// attach as a composer chip serialized into the prompt on send; focus is pulled to the composer whenever a valid comment is submitted (even on dedupe) so the chip is visible
export function addChatFileComment(threadId: ThreadId, comment: FileCommentSelection): boolean {
  const draft = createFileCommentDraft(comment);
  if (!draft) {
    return false;
  }
  useComposerDraftStore.getState().addFileComment(threadId, draft);
  requestComposerFocus(threadId);
  return true;
}

// card renders above the editor with its prompt serialized on send; focus moves to the composer so the new bubble is visible
export function addChatPullRequestContext(
  threadId: ThreadId,
  context: PullRequestContextDraft,
): boolean {
  const added = useComposerDraftStore.getState().addPullRequestContext(threadId, context);
  if (added) {
    requestComposerFocus(threadId);
  }
  return added;
}

function countNewlines(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      count += 1;
    }
  }
  return count;
}

function columnsOnLastLine(text: string): number {
  return text.length - (text.lastIndexOf("\n") + 1);
}

export function computeSelectionLineRange(
  prefixText: string,
  selectedText: string,
): { startLine: number; endLine: number } {
  const startLine = countNewlines(prefixText) + 1;
  const endLine = startLine + countNewlines(selectedText.replace(/\n+$/, ""));
  return { startLine, endLine };
}

// trailing newlines ignored so a line-spanning selection ends on real content
export function computeSelectionColumns(
  prefixText: string,
  selectedText: string,
): { startColumn: number; endColumn: number } {
  const startColumn = columnsOnLastLine(prefixText) + 1;
  const trimmedSelection = selectedText.replace(/\n+$/, "");
  const endColumn = columnsOnLastLine(prefixText + trimmedSelection);
  return { startColumn, endColumn };
}

export interface SelectionWithin {
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
}

// null when nothing remains — whitespace-only selections mean no selection; shared by surfaces that reference by text (diff rows, rendered markdown)
export function normalizeSelectionSnippet(text: string): string | null {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .trim();
  return normalized.length === 0 ? null : normalized;
}

function getSelectionRangeWithin(
  container: HTMLElement,
): { selection: Selection; range: Range; selectedText: string } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return null;
  }
  const selectedText = range.toString();
  if (selectedText.trim().length === 0) {
    return null;
  }
  return { selection, range, selectedText };
}

// works for plain <pre> and Shiki markup because both keep one \n of text per rendered line
export function getSelectionWithin(container: HTMLElement): SelectionWithin | null {
  const scoped = getSelectionRangeWithin(container);
  if (!scoped) {
    return null;
  }
  const prefixRange = document.createRange();
  prefixRange.selectNodeContents(container);
  prefixRange.setEnd(scoped.range.startContainer, scoped.range.startOffset);
  const prefixText = prefixRange.toString();
  return {
    ...computeSelectionLineRange(prefixText, scoped.selectedText),
    ...computeSelectionColumns(prefixText, scoped.selectedText),
  };
}

// for surfaces whose DOM doesn't mirror source lines 1:1 (rendered markdown) the quoted text itself is the reference
export function getSelectionSnippetWithin(container: HTMLElement): { snippet: string } | null {
  const scoped = getSelectionRangeWithin(container);
  if (!scoped) {
    return null;
  }
  // Selection.toString yields laid-out text (line break between block elements); Range.toString concatenates with no separator
  const snippet = normalizeSelectionSnippet(scoped.selection.toString());
  return snippet === null ? null : { snippet };
}
