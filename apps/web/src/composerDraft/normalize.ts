// FILE: composerDraft/normalize.ts
// Purpose: Dedupe-key derivation and normalization/validation for assistant selections and terminal contexts.
// Layer: Web state store (pure helpers)
// Exports: composerImageDedupKey, terminalContextDedupKey, assistantSelectionDedupKey,
//   normalizeAssistantSelection, normalizeAssistantSelections,
//   normalizeTerminalContextForThread, normalizeTerminalContextsForThread

import type { ThreadId } from "@t3tools/contracts";
import { normalizeAssistantSelectionAttachment } from "../lib/assistantSelections";
import { type TerminalContextDraft, normalizeTerminalContextText } from "../lib/terminalContext";
import type {
  ComposerAssistantSelectionAttachment,
  ComposerImageAttachment,
} from "../composerDraftStore";

export function composerImageDedupKey(image: ComposerImageAttachment): string {
  // Keep this independent from File.lastModified so dedupe is stable for hydrated
  // images reconstructed from localStorage (which get a fresh lastModified value).
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
}

export function terminalContextDedupKey(context: TerminalContextDraft): string {
  return `${context.terminalId}\u0000${context.lineStart}\u0000${context.lineEnd}`;
}

export function assistantSelectionDedupKey(
  selection: Pick<ComposerAssistantSelectionAttachment, "assistantMessageId" | "text">,
): string {
  return `${selection.assistantMessageId}\u0000${selection.text}`;
}

export function normalizeAssistantSelection(
  selection: Pick<ComposerAssistantSelectionAttachment, "id" | "assistantMessageId" | "text">,
): ComposerAssistantSelectionAttachment | null {
  const normalized = normalizeAssistantSelectionAttachment(selection);
  if (!normalized) {
    return null;
  }
  return {
    type: "assistant-selection",
    ...selection,
    assistantMessageId: normalized.assistantMessageId,
    text: normalized.text,
  };
}

export function normalizeAssistantSelections(
  selections: ReadonlyArray<
    Pick<ComposerAssistantSelectionAttachment, "id" | "assistantMessageId" | "text">
  >,
): ComposerAssistantSelectionAttachment[] {
  const normalizedSelections: ComposerAssistantSelectionAttachment[] = [];
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();

  for (const selection of selections) {
    const normalizedSelection = normalizeAssistantSelection(selection);
    if (!normalizedSelection) {
      continue;
    }
    const dedupKey = assistantSelectionDedupKey(normalizedSelection);
    if (existingIds.has(normalizedSelection.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }
    normalizedSelections.push(normalizedSelection);
    existingIds.add(normalizedSelection.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedSelections;
}

export function normalizeTerminalContextForThread(
  threadId: ThreadId,
  context: TerminalContextDraft,
): TerminalContextDraft | null {
  const terminalId = context.terminalId.trim();
  const terminalLabel = context.terminalLabel.trim();
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(context.lineStart));
  const lineEnd = Math.max(lineStart, Math.floor(context.lineEnd));
  return {
    ...context,
    threadId,
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text: normalizeTerminalContextText(context.text),
  };
}

export function normalizeTerminalContextsForThread(
  threadId: ThreadId,
  contexts: ReadonlyArray<TerminalContextDraft>,
): TerminalContextDraft[] {
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();
  const normalizedContexts: TerminalContextDraft[] = [];

  for (const context of contexts) {
    const normalizedContext = normalizeTerminalContextForThread(threadId, context);
    if (!normalizedContext) {
      continue;
    }
    const dedupKey = terminalContextDedupKey(normalizedContext);
    if (existingIds.has(normalizedContext.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }
    normalizedContexts.push(normalizedContext);
    existingIds.add(normalizedContext.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedContexts;
}
