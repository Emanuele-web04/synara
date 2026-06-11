// FILE: chatReferences.ts
// Purpose: Build file/line references and canned prompts, and append them to a
//          thread's composer draft so panels outside ChatView can talk to the chatbox.
// Layer: Web UI utility

import { CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS, type ThreadId } from "@t3tools/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { requestComposerFocus } from "../composerFocusRequestStore";
import { formatComposerMentionToken } from "./composerMentions";

export interface ChatFileReference {
  path: string;
  startLine?: number;
  endLine?: number;
}

// DataTransfer type used when dragging a file row toward the composer. The
// payload is the already-formatted reference text (mention token).
export const CHAT_FILE_REFERENCE_DRAG_TYPE = "application/x-synara-file-reference";

export function formatLineRangeLabel(startLine: number, endLine: number): string {
  return endLine !== startLine ? `lines ${startLine}-${endLine}` : `line ${startLine}`;
}

// `@path` mention token plus a plain-text line suffix. The line range stays out
// of the mention token itself so provider-side file resolution keeps working.
export function formatChatFileReference(reference: ChatFileReference): string {
  const token = formatComposerMentionToken(reference.path);
  if (typeof reference.startLine !== "number") {
    return token;
  }
  const endLine = reference.endLine ?? reference.startLine;
  return `${token} (${formatLineRangeLabel(reference.startLine, endLine)})`;
}

export function buildWhyChangedPrompt(path: string): string {
  return `Why did we implement the changes in ${formatComposerMentionToken(path)}?`;
}

// "Why" prompt for an arbitrary file or line range. Providers run in the
// workspace, so the prompt steers them toward git blame/history for evidence.
export function buildWhyLinesPrompt(reference: ChatFileReference): string {
  const token = formatComposerMentionToken(reference.path);
  if (typeof reference.startLine !== "number") {
    return `Why did we implement ${token} this way? Check the git history if needed and explain the reasoning.`;
  }
  const endLine = reference.endLine ?? reference.startLine;
  return `Why were ${formatLineRangeLabel(reference.startLine, endLine)} in ${token} implemented this way? Check git blame/history for the relevant commits and explain the reasoning.`;
}

// Mention token plus the highlighted diff snippet as a fenced block. Diff rows
// have no stable file line numbers (split/unified views renumber), so the
// quoted code itself is the precise reference.
export function buildDiffSelectionReference(path: string, snippet: string): string {
  const normalized = snippet.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  const truncated =
    normalized.length > CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS
      ? normalized.slice(0, CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS)
      : normalized;
  // Selected code can itself contain ``` fences; the wrapper fence must be
  // longer than any backtick run in the snippet to survive Markdown parsing.
  const longestBacktickRun = truncated
    .match(/`+/g)
    ?.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, (longestBacktickRun ?? 0) + 1));
  return `${formatComposerMentionToken(path)}\n${fence}\n${truncated}\n${fence}`;
}

export function appendComposerPromptText(threadId: ThreadId, text: string): void {
  const store = useComposerDraftStore.getState();
  const existingPrompt = store.draftsByThreadId[threadId]?.prompt ?? "";
  const needsSeparator = existingPrompt.length > 0 && !/\s$/.test(existingPrompt);
  store.setPrompt(threadId, `${existingPrompt}${needsSeparator ? " " : ""}${text} `);
  // Pull the user's attention to the composer so the insert is visible.
  requestComposerFocus(threadId);
}

export function appendChatFileReference(threadId: ThreadId, reference: ChatFileReference): void {
  appendComposerPromptText(threadId, formatChatFileReference(reference));
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

// Pure line-range math, separated from the DOM selection plumbing for testability.
export function computeSelectionLineRange(
  prefixText: string,
  selectedText: string,
): { startLine: number; endLine: number } {
  const startLine = countNewlines(prefixText) + 1;
  const endLine = startLine + countNewlines(selectedText.replace(/\n+$/, ""));
  return { startLine, endLine };
}

// Resolve the 1-based line range of the current text selection inside `container`.
// Works for both plain <pre> contents and Shiki-highlighted markup because both
// keep one "\n" of text content per rendered line.
export function getSelectionLineRangeWithin(
  container: HTMLElement,
): { startLine: number; endLine: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return null;
  }
  const prefixRange = document.createRange();
  prefixRange.selectNodeContents(container);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  return computeSelectionLineRange(prefixRange.toString(), range.toString());
}
