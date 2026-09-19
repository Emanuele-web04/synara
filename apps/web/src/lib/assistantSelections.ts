// FILE: assistantSelections.ts
// Purpose: Normalize, serialize, and strip assistant quote selections from user prompts.
// Layer: Chat composer and transcript helpers

import {
  CHAT_ASSISTANT_SELECTION_COMMENT_MAX_CHARS,
  CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS,
} from "@synara/contracts";

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

export type AssistantSelectionValidationError = "empty" | "too-long";

export function normalizeAssistantSelectionText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/^\n+|\n+$/g, "")
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

export function normalizeAssistantSelectionComment(
  comment: string | null | undefined,
): string | undefined {
  if (typeof comment !== "string") {
    return undefined;
  }
  const normalized = normalizeAssistantSelectionText(comment).slice(
    0,
    CHAT_ASSISTANT_SELECTION_COMMENT_MAX_CHARS,
  );
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeAssistantSelectionAttachment(
  selection: Pick<ChatAssistantSelectionAttachment, "assistantMessageId" | "text"> & {
    comment?: string | null | undefined;
  },
):
  | (Pick<ChatAssistantSelectionAttachment, "assistantMessageId" | "text"> & {
      comment?: string;
    })
  | null {
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
    ...(comment !== undefined ? { comment } : {}),
  };
}

export function createAssistantSelectionAttachment(input: {
  assistantMessageId: string;
  text: string;
  comment?: string | null | undefined;
}): ChatAssistantSelectionAttachment | null {
  const normalized = normalizeAssistantSelectionAttachment(input);
  if (!normalized) {
    return null;
  }

  return {
    type: "assistant-selection",
    id: randomUUID(),
    assistantMessageId: normalized.assistantMessageId,
    text: normalized.text,
    ...(normalized.comment !== undefined ? { comment: normalized.comment } : {}),
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
  selections: ReadonlyArray<
    Pick<ChatAssistantSelectionAttachment, "assistantMessageId" | "text"> & {
      comment?: string | null | undefined;
    }
  >,
): string {
  const normalizedSelections = selections
    .map((selection) => normalizeAssistantSelectionAttachment(selection))
    .filter(
      (
        selection,
      ): selection is Pick<ChatAssistantSelectionAttachment, "assistantMessageId" | "text"> & {
        comment?: string;
      } => selection !== null,
    );
  if (normalizedSelections.length === 0) {
    return "";
  }

  const lines: string[] = [];
  for (const selection of normalizedSelections) {
    lines.push(`- assistant message ${selection.assistantMessageId}:`);
    for (const line of selection.text.split("\n")) {
      lines.push(`  ${line}`);
    }
    if (selection.comment !== undefined) {
      // Entry lines are always indented, so a column-0 "- user note:" item can
      // never be confused for quoted text. It binds to the entry above it.
      lines.push("- user note:");
      for (const line of selection.comment.split("\n")) {
        lines.push(`  ${line}`);
      }
    }
  }
  return ["<assistant_selection>", ...lines, "</assistant_selection>"].join("\n");
}

export function appendAssistantSelectionsToPrompt(
  prompt: string,
  selections: ReadonlyArray<
    Pick<ChatAssistantSelectionAttachment, "assistantMessageId" | "text"> & {
      comment?: string | null | undefined;
    }
  >,
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
    commentLines: string[];
    mode: "quote" | "comment";
  } | null = null;

  const commitCurrent = () => {
    if (!current) return;
    const text = current.lines.join("\n").trimEnd();
    if (text.length > 0) {
      const comment = current.commentLines.join("\n").trimEnd();
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
        commentLines: [],
        mode: "quote",
      };
      continue;
    }
    if (rawLine === "- user note:") {
      if (current) {
        current.mode = "comment";
      }
      continue;
    }
    if (!current) {
      continue;
    }
    if (rawLine.startsWith("  ")) {
      if (current.mode === "comment") {
        current.commentLines.push(rawLine.slice(2));
      } else {
        current.lines.push(rawLine.slice(2));
      }
      continue;
    }
    if (rawLine.length === 0) {
      if (current.mode === "comment") {
        current.commentLines.push("");
      } else {
        current.lines.push("");
      }
    }
  }

  commitCurrent();
  return entries;
}
