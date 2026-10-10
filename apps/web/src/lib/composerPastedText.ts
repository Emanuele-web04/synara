// FILE: composerPastedText.ts
// Purpose: Shared helpers for the composer "collapsed big paste" feature. A large
//   paste is held as an attachment card above the composer (not inline text); its
//   full content rides to the provider in a trailing <pasted_text> block and is
//   parsed back out to render the same card in the transcript.
// Layer: Web composer utility
// Depends on: nothing (kept import-free so both composer state and message display
//   can consume it without cycles).

export interface PastedTextDraft {
  id: string;
  createdAt: string;
  text: string;
  // Cached metrics so cards render a label without recomputing on every render.
  lineCount: number;
  charCount: number;
}

export interface ParsedPastedTextEntry {
  index: number;
  text: string;
  lineCount: number;
  charCount: number;
}

export interface ExtractedPastedTexts {
  promptText: string;
  pastedTexts: ParsedPastedTextEntry[];
  previewTitle: string | null;
}

// A paste only collapses once it is large enough that inlining it would flood the
// composer. Either dimension trips the threshold.
export const PASTED_TEXT_MIN_LINES = 25;
export const PASTED_TEXT_MIN_CHARS = 4000;

const TRAILING_PASTED_TEXT_BLOCK_PATTERN = /\n*<pasted_text>\n([\s\S]*?)\n<\/pasted_text>\s*$/;
const PASTED_TEXT_ENTRY_PATTERN = /\[#(\d+)\]\n([\s\S]*?)\n\[\/#\1\]/g;

interface SerializedPastedTextEntry {
  readonly text: string;
}

export function normalizePastedTextContent(text: string): string {
  // Normalize line endings only; leading/trailing whitespace can be meaningful in
  // pasted content, so we never trim it.
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function countPastedTextLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

export function shouldCollapsePastedText(text: string): boolean {
  const normalized = normalizePastedTextContent(text);
  if (normalized.length === 0) {
    return false;
  }
  return (
    normalized.length >= PASTED_TEXT_MIN_CHARS ||
    countPastedTextLines(normalized) >= PASTED_TEXT_MIN_LINES
  );
}

export function createPastedTextDraft(input: {
  id: string;
  createdAt: string;
  text: string;
}): PastedTextDraft {
  const text = normalizePastedTextContent(input.text);
  return {
    id: input.id,
    createdAt: input.createdAt,
    text,
    lineCount: countPastedTextLines(text),
    charCount: text.length,
  };
}

export function hasPastedText(pasted: { text: string }): boolean {
  return normalizePastedTextContent(pasted.text).length > 0;
}

export function filterPastedTextsWithText<T extends { text: string }>(
  pastedTexts: ReadonlyArray<T>,
): T[] {
  return pastedTexts.filter((pasted) => hasPastedText(pasted));
}

export function formatPastedTextCountLabel(metrics: {
  lineCount: number;
  charCount: number;
}): string {
  if (metrics.lineCount > 1) {
    return `${metrics.lineCount.toLocaleString()} lines`;
  }
  return `${metrics.charCount.toLocaleString()} chars`;
}

// First non-empty line, trimmed; used as the card's title preview.
export function pastedTextTitle(text: string): string {
  const normalized = normalizePastedTextContent(text);
  for (const line of normalized.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed.length > 140 ? `${trimmed.slice(0, 137)}...` : trimmed;
    }
  }
  return "Pasted text";
}

// --- Send-time serialization (cards -> trailing block)

export function buildPastedTextBlock(pastedTexts: ReadonlyArray<{ text: string }>): string {
  const usable = filterPastedTextsWithText(pastedTexts);
  if (usable.length === 0) {
    return "";
  }
  const payload: SerializedPastedTextEntry[] = usable.map((pasted) => ({
    text: normalizePastedTextContent(pasted.text),
  }));
  return ["<pasted_text>", JSON.stringify(payload), "</pasted_text>"].join("\n");
}

export function appendPastedTextsToPrompt(
  prompt: string,
  pastedTexts: ReadonlyArray<{ text: string }>,
): string {
  const block = buildPastedTextBlock(pastedTexts);
  const trimmed = prompt.trim();
  if (block.length === 0) {
    return trimmed;
  }
  return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
}

// --- Display-time extraction (trailing block -> cards)

function buildParsedPastedTextEntry(index: number, text: string): ParsedPastedTextEntry {
  return {
    index,
    text,
    lineCount: countPastedTextLines(text),
    charCount: text.length,
  };
}

function parseJsonPastedTextEntries(block: string): ParsedPastedTextEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(block.trim());
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.flatMap((entry, index) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const text = (entry as { readonly text?: unknown }).text;
      return typeof text === "string" ? [buildParsedPastedTextEntry(index + 1, text)] : [];
    });
  } catch {
    return null;
  }
}

// Legacy delimiter parsing keeps already-sent messages renderable after the
// serializer moved to JSON to avoid collisions with arbitrary pasted content.
function parseLegacyPastedTextEntries(block: string): ParsedPastedTextEntry[] {
  const entries: ParsedPastedTextEntry[] = [];
  for (const match of block.matchAll(PASTED_TEXT_ENTRY_PATTERN)) {
    const index = Number.parseInt(match[1] ?? "", 10);
    const text = match[2] ?? "";
    if (!Number.isFinite(index)) {
      continue;
    }
    entries.push(buildParsedPastedTextEntry(index, text));
  }
  return entries;
}

function parsePastedTextEntries(block: string): ParsedPastedTextEntry[] {
  return parseJsonPastedTextEntries(block) ?? parseLegacyPastedTextEntries(block);
}

export function extractTrailingPastedTexts(prompt: string): ExtractedPastedTexts {
  const match = TRAILING_PASTED_TEXT_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return { promptText: prompt, pastedTexts: [], previewTitle: null };
  }
  const promptText = prompt.slice(0, match.index).replace(/\n+$/, "");
  const pastedTexts = parsePastedTextEntries(match[1] ?? "");
  const previewTitle =
    pastedTexts.length > 0
      ? pastedTexts.map((entry) => pastedTextTitle(entry.text)).join("\n")
      : null;
  return { promptText, pastedTexts, previewTitle };
}
