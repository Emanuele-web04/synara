// FILE: assistantSelections.ts
// Purpose: Normalize, serialize, and strip assistant quote selections from user prompts.
// Layer: Chat composer and transcript helpers

import { CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS } from "@synara/contracts";

import type { ChatAssistantSelectionAttachment } from "../types";
import { randomUUID } from "./utils";

const TRAILING_ASSISTANT_SELECTIONS_PATTERN =
  /\n*<assistant_selection>\n([\s\S]*?)\n<\/assistant_selection>\s*$/;
const EMBEDDED_ASSISTANT_SELECTIONS_PATTERN =
  /\n*<assistant_selection>\n[\s\S]*?\n<\/assistant_selection>(?=\n*(<terminal_context>\n[\s\S]*?\n<\/terminal_context>\s*)?(<file_comments>\n[\s\S]*?\n<\/file_comments>\s*)?(<pasted_text>\n[\s\S]*?\n<\/pasted_text>\s*)?(<pull_request_context>\n[\s\S]*?\n<\/pull_request_context>\s*)?$)/;

export interface ExtractedAssistantSelections {
  promptText: string;
  selections: ParsedAssistantSelectionEntry[];
}

export interface ParsedAssistantSelectionEntry {
  assistantMessageId: string;
  text: string;
  comment?: string;
}

type AssistantSelectionContent = Pick<
  ChatAssistantSelectionAttachment,
  "assistantMessageId" | "text" | "comment"
>;

export const ASSISTANT_SELECTION_COMMENT_MAX_CHARS = 4_000;
const ASSISTANT_SELECTION_COMMENT_HEADER = "- comment:";

export type AssistantSelectionValidationError = "empty" | "too-long";

export function normalizeAssistantSelectionText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .trim();
}

export function normalizeAssistantSelectionComment(comment: string | undefined): string {
  if (!comment) return "";
  return comment
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, ASSISTANT_SELECTION_COMMENT_MAX_CHARS)
    .trim();
}

export function getAssistantSelectionValidationError(
  selection: Pick<ChatAssistantSelectionAttachment, "assistantMessageId" | "text">,
): AssistantSelectionValidationError | null {
  const assistantMessageId = selection.assistantMessageId.trim();
  const text = normalizeAssistantSelectionText(selection.text);
  if (assistantMessageId.length === 0 || text.length === 0) {
    return "empty";
  }
  if (text.length > CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS) {
    return "too-long";
  }
  return null;
}

export function normalizeAssistantSelectionAttachment(
  selection: AssistantSelectionContent,
): AssistantSelectionContent | null {
  const validationError = getAssistantSelectionValidationError(selection);
  if (validationError) {
    return null;
  }
  const assistantMessageId = selection.assistantMessageId.trim();
  const text = normalizeAssistantSelectionText(selection.text);
  const comment = normalizeAssistantSelectionComment(selection.comment);
  return {
    assistantMessageId,
    text,
    ...(comment.length > 0 ? { comment } : {}),
  };
}

export function createAssistantSelectionAttachment(
  input: AssistantSelectionContent,
): ChatAssistantSelectionAttachment | null {
  const normalized = normalizeAssistantSelectionAttachment(input);
  if (!normalized) {
    return null;
  }

  return {
    type: "assistant-selection",
    id: randomUUID(),
    ...normalized,
  };
}

export function formatAssistantSelectionQueuePreview(selectionCount: number): string {
  return selectionCount === 1 ? "1 referenced selection" : "Referenced selections";
}

export function formatAssistantSelectionTitleSeed(selectionCount: number): string {
  return selectionCount === 1
    ? "Referenced assistant selection"
    : "Referenced assistant selections";
}

export function buildAssistantSelectionsPromptBlock(
  selections: ReadonlyArray<AssistantSelectionContent>,
): string {
  const normalizedSelections = selections
    .map((selection) => normalizeAssistantSelectionAttachment(selection))
    .filter((selection): selection is AssistantSelectionContent => selection !== null);
  if (normalizedSelections.length === 0) {
    return "";
  }

  const lines: string[] = [];
  for (const selection of normalizedSelections) {
    lines.push(`- assistant message ${selection.assistantMessageId}:`);
    for (const line of selection.text.split("\n")) {
      lines.push(`  ${line}`);
    }
    // Quote lines are always indented, so an unindented header can't be forged by the quote.
    if (selection.comment) {
      lines.push(ASSISTANT_SELECTION_COMMENT_HEADER);
      for (const line of selection.comment.split("\n")) {
        lines.push(`  ${line}`);
      }
    }
  }
  return ["<assistant_selection>", ...lines, "</assistant_selection>"].join("\n");
}

export function appendAssistantSelectionsToPrompt(
  prompt: string,
  selections: ReadonlyArray<AssistantSelectionContent>,
): string {
  const trimmedPrompt = prompt.trim();
  const block = buildAssistantSelectionsPromptBlock(selections);
  if (block.length === 0) {
    return trimmedPrompt;
  }
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${block}` : block;
}

export function extractTrailingAssistantSelections(prompt: string): ExtractedAssistantSelections {
  const match = TRAILING_ASSISTANT_SELECTIONS_PATTERN.exec(prompt);
  if (!match) {
    return {
      promptText: prompt,
      selections: [],
    };
  }

  return {
    promptText: prompt.slice(0, match.index).replace(/\n+$/, ""),
    selections: parseAssistantSelectionEntries(match[1] ?? ""),
  };
}

export function stripEmbeddedAssistantSelections(prompt: string): string {
  return prompt.replace(EMBEDDED_ASSISTANT_SELECTIONS_PATTERN, "");
}

function parseAssistantSelectionEntries(block: string): ParsedAssistantSelectionEntry[] {
  const entries: ParsedAssistantSelectionEntry[] = [];
  let current: {
    assistantMessageId: string;
    lines: string[];
    commentLines: string[] | null;
  } | null = null;

  const commitCurrent = () => {
    if (!current) return;
    const text = current.lines.join("\n").trimEnd();
    const comment = current.commentLines?.join("\n").trim() ?? "";
    if (text.length > 0) {
      entries.push({
        assistantMessageId: current.assistantMessageId,
        text,
        ...(comment.length > 0 ? { comment } : {}),
      });
    }
    current = null;
  };

  for (const rawLine of block.split("\n")) {
    const headerMatch = /^- assistant message (.+):$/.exec(rawLine);
    if (headerMatch) {
      commitCurrent();
      current = {
        assistantMessageId: headerMatch[1]!.trim(),
        lines: [],
        commentLines: null,
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (rawLine === ASSISTANT_SELECTION_COMMENT_HEADER && current.commentLines === null) {
      current.commentLines = [];
      continue;
    }
    const target = current.commentLines ?? current.lines;
    if (rawLine.startsWith("  ")) {
      target.push(rawLine.slice(2));
      continue;
    }
    if (rawLine.length === 0) {
      target.push("");
    }
  }

  commitCurrent();
  return entries;
}

export function mergeAssistantSelectionComments(
  attachments: ReadonlyArray<ChatAssistantSelectionAttachment>,
  parsedEntries: ReadonlyArray<ParsedAssistantSelectionEntry>,
): ChatAssistantSelectionAttachment[] {
  const remaining = parsedEntries.filter((entry) => entry.comment);
  return attachments.map((attachment) => {
    const index = remaining.findIndex(
      (entry) =>
        entry.assistantMessageId === attachment.assistantMessageId &&
        entry.text === attachment.text,
    );
    const comment = index === -1 ? undefined : remaining.splice(index, 1)[0]?.comment;
    return comment ? { ...attachment, comment } : attachment;
  });
}
