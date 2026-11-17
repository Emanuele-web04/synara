// FILE: markdownPlainText.ts
// Purpose: Reduces assistant Markdown to one line of readable plain text and caps it, so
//          notification bodies and thread list previews never show Markdown syntax.
// Layer: Shared runtime utility
// Exports: markdownToPlainText, truncatePlainText

const PROTECTED_CODE_START = "";
const PROTECTED_CODE_END = "";

function markdownColumnWidth(value: string): number {
  let columns = 0;
  for (const character of value) {
    columns = character === "\t" ? columns + (4 - (columns % 4)) : columns + 1;
  }
  return columns;
}

function findMarkdownContainerBoundary(
  text: string,
  contentStart: number,
  quotePrefix: string,
  quoteDepth: number,
  listContinuationIndent: number,
): number | null {
  if (quoteDepth === 0 && listContinuationIndent === 0) {
    return null;
  }

  const quotePattern = new RegExp(`^${quotePrefix}`);
  let lineStart = contentStart;

  while (lineStart < text.length) {
    const nextNewline = text.indexOf("\n", lineStart);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    const quoteMatch = quotePattern.exec(line);

    if (quoteDepth > 0 && !quoteMatch) {
      return lineStart;
    }

    const content = line.slice(quoteMatch?.[0].length ?? 0);
    if (listContinuationIndent > 0 && content.trim().length > 0) {
      const indentation = content.match(/^[ \t]*/)?.[0] ?? "";
      if (markdownColumnWidth(indentation) < listContinuationIndent) {
        return lineStart;
      }
    }

    if (nextNewline === -1) {
      break;
    }
    lineStart = nextNewline + 1;
  }

  return null;
}

function protectMarkdownFencedBlocks(text: string, protect: (content: string) => string): string {
  const openingPattern =
    /(^|\n)((?:[ \t]{0,3}(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+))*[ \t]{0,3})(`{3,}|~{3,})([^\r\n]*)\r?\n/g;
  let result = "";
  let cursor = 0;
  let openingMatch: RegExpExecArray | null;

  while ((openingMatch = openingPattern.exec(text)) !== null) {
    const linePrefix = openingMatch[1] ?? "";
    const containerPrefix = openingMatch[2] ?? "";
    const fence = openingMatch[3] ?? "";
    const info = openingMatch[4] ?? "";
    const fenceCharacter = fence[0];

    // Backticks are not valid inside a backtick fence's info string. Treat
    // such a line as prose so same-line multi-backtick code remains inline.
    if (fenceCharacter === "`" && info.includes("`")) {
      continue;
    }

    const quoteDepth = containerPrefix.match(/>/g)?.length ?? 0;
    const quotePrefix = `(?:[ \\t]{0,3}>[ \\t]?){${quoteDepth}}`;
    const prefixWithoutBlockquotes = containerPrefix.replace(/[ \t]{0,3}>[ \t]?/g, "");
    const listContinuationIndent = /(?:[-+*]|\d{1,9}[.)])[ \t]+/.test(prefixWithoutBlockquotes)
      ? markdownColumnWidth(prefixWithoutBlockquotes)
      : 0;
    const closingPattern = new RegExp(
      `(^|\\n)${quotePrefix}([ \\t]*)${fenceCharacter}{${fence.length},}[ \\t]*\\r?(?=\\n|$)`,
      "g",
    );
    closingPattern.lastIndex = openingPattern.lastIndex;
    let closingMatch: RegExpExecArray | null = null;
    let closingCandidate: RegExpExecArray | null;
    const minimumClosingIndent = listContinuationIndent;
    const maximumClosingIndent = listContinuationIndent + 3;

    while ((closingCandidate = closingPattern.exec(text)) !== null) {
      const closingColumns = markdownColumnWidth(closingCandidate[2] ?? "");
      if (closingColumns >= minimumClosingIndent && closingColumns <= maximumClosingIndent) {
        closingMatch = closingCandidate;
        break;
      }
    }
    const containerBoundary = findMarkdownContainerBoundary(
      text,
      openingPattern.lastIndex,
      quotePrefix,
      quoteDepth,
      listContinuationIndent,
    );
    const boundaryPrecedesClosing =
      containerBoundary !== null &&
      (closingMatch === null || containerBoundary < closingMatch.index);
    const effectiveClosingMatch = boundaryPrecedesClosing ? null : closingMatch;
    const contentEnd = boundaryPrecedesClosing
      ? containerBoundary
      : (effectiveClosingMatch?.index ?? text.length);
    const content = text
      .slice(openingPattern.lastIndex, contentEnd)
      .replace(new RegExp(`(^|\\n)${quotePrefix}`, "g"), "$1");

    result += text.slice(cursor, openingMatch.index);
    result += linePrefix;
    result += protect(content);

    if (!effectiveClosingMatch) {
      cursor = contentEnd;
      if (containerBoundary === null) {
        break;
      }
      openingPattern.lastIndex = cursor;
      continue;
    }

    cursor = closingPattern.lastIndex;
    openingPattern.lastIndex = cursor;
  }

  return result + text.slice(cursor);
}

function protectMarkdownEscapes(text: string, protect: (content: string) => string): string {
  return text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, (_match, punctuation: string) =>
    protect(punctuation),
  );
}

function protectMarkdownInlineCode(text: string, protect: (content: string) => string): string {
  const runs: Array<{ start: number; end: number; length: number }> = [];
  let index = 0;

  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }

    const start = index;
    while (text[index] === "`") {
      index += 1;
    }
    runs.push({ start, end: index, length: index - start });
  }

  const nextMatchingRun = Array.from<number | undefined>({ length: runs.length });
  const nextRunByLength = new Map<number, number>();

  for (let runIndex = runs.length - 1; runIndex >= 0; runIndex -= 1) {
    const run = runs[runIndex];
    if (!run) {
      continue;
    }
    nextMatchingRun[runIndex] = nextRunByLength.get(run.length);
    nextRunByLength.set(run.length, runIndex);
  }

  let result = "";
  let cursor = 0;
  let runIndex = 0;

  while (runIndex < runs.length) {
    const openingRun = runs[runIndex];
    const closingRunIndex = nextMatchingRun[runIndex];
    if (!openingRun || closingRunIndex === undefined) {
      runIndex += 1;
      continue;
    }
    const closingRun = runs[closingRunIndex];
    if (!closingRun) {
      runIndex += 1;
      continue;
    }

    result += text.slice(cursor, openingRun.start);
    result += protect(text.slice(openingRun.end, closingRun.start));
    cursor = closingRun.end;
    runIndex = closingRunIndex + 1;
  }

  return result + text.slice(cursor);
}

function protectMarkdownCode(text: string): {
  protectedText: string;
  restore: (value: string) => string;
} {
  const segments: string[] = [];
  const protect = (content: string): string => {
    const token = `${PROTECTED_CODE_START}${segments.length}${PROTECTED_CODE_END}`;
    segments.push(content);
    return token;
  };

  const protectedBlocks = protectMarkdownFencedBlocks(text, protect);
  const protectedEscapes = protectMarkdownEscapes(protectedBlocks, protect);
  const protectedText = protectMarkdownInlineCode(protectedEscapes, protect);

  return {
    protectedText,
    restore: (value) =>
      value.replace(
        new RegExp(`${PROTECTED_CODE_START}(\\d+)${PROTECTED_CODE_END}`, "g"),
        (_match, index: string) => segments[Number(index)] ?? "",
      ),
  };
}

function buildMatchingMarkdownDelimiters(
  text: string,
  openDelimiter: "[" | "(",
  closeDelimiter: "]" | ")",
): ReadonlyMap<number, number> {
  const openingIndexes: number[] = [];
  const matches = new Map<number, number>();

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === openDelimiter) {
      openingIndexes.push(index);
      continue;
    }
    if (character === closeDelimiter) {
      const openingIndex = openingIndexes.pop();
      if (openingIndex !== undefined) {
        matches.set(openingIndex, index);
      }
    }
  }

  return matches;
}

function normalizeMarkdownReferenceLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

const MARKDOWN_REFERENCE_DEFINITION_PATTERN =
  /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(?:<[^<>\r\n]*>|[^\s<>]+)(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^)\r\n]*\)))?[ \t]*$/gm;

function collectMarkdownReferenceLabels(text: string): ReadonlySet<string> {
  const labels = new Set<string>();

  for (const match of text.matchAll(MARKDOWN_REFERENCE_DEFINITION_PATTERN)) {
    const label = match[1];
    if (label) {
      labels.add(normalizeMarkdownReferenceLabel(label));
    }
  }
  return labels;
}

function removeMarkdownReferenceDefinitions(text: string): string {
  return text.replace(MARKDOWN_REFERENCE_DEFINITION_PATTERN, "");
}

function stripMarkdownLinks(text: string, referenceLabels: ReadonlySet<string>): string {
  const labelMatches = buildMatchingMarkdownDelimiters(text, "[", "]");
  const destinationMatches = buildMatchingMarkdownDelimiters(text, "(", ")");
  let result = "";
  let index = 0;

  while (index < text.length) {
    const isImage = text[index] === "!" && text[index + 1] === "[";
    const labelOpenIndex = isImage ? index + 1 : index;
    if (text[labelOpenIndex] !== "[") {
      result += text[index];
      index += 1;
      continue;
    }

    const labelCloseIndex = labelMatches.get(labelOpenIndex);
    if (labelCloseIndex === undefined) {
      result += text[index];
      index += 1;
      continue;
    }

    const destinationOpenIndex = labelCloseIndex + 1;
    if (text[destinationOpenIndex] === "(") {
      const destinationCloseIndex = destinationMatches.get(destinationOpenIndex);
      if (destinationCloseIndex === undefined) {
        result += text[index];
        index += 1;
        continue;
      }

      if (isImage) {
        result += " ";
      } else {
        result += text.slice(labelOpenIndex + 1, labelCloseIndex);
      }
      index = destinationCloseIndex + 1;
      continue;
    }

    const label = text.slice(labelOpenIndex + 1, labelCloseIndex);
    if (text[destinationOpenIndex] === "[") {
      const referenceCloseIndex = labelMatches.get(destinationOpenIndex);
      if (referenceCloseIndex === undefined) {
        result += text[index];
        index += 1;
        continue;
      }
      const explicitReference = text.slice(destinationOpenIndex + 1, referenceCloseIndex);
      const reference = explicitReference.length > 0 ? explicitReference : label;
      if (!referenceLabels.has(normalizeMarkdownReferenceLabel(reference))) {
        result += text[index];
        index += 1;
        continue;
      }

      result += isImage ? " " : label;
      index = referenceCloseIndex + 1;
      continue;
    }

    if (!referenceLabels.has(normalizeMarkdownReferenceLabel(label))) {
      result += text[index];
      index += 1;
      continue;
    }

    result += isImage ? " " : label;
    index = labelCloseIndex + 1;
  }

  return result;
}

/**
 * Rich assistant output as one line of readable text: code and escapes stay literal while their
 * markup goes, links keep their label, images drop out, list items become " · " separators, and
 * every run of whitespace (newlines included) collapses to one space. Returns "" when nothing
 * readable is left.
 */
export function markdownToPlainText(markdown: string): string {
  const { protectedText, restore } = protectMarkdownCode(markdown);
  const referenceLabels = collectMarkdownReferenceLabels(protectedText);
  const withoutReferenceDefinitions = removeMarkdownReferenceDefinitions(protectedText);
  const cleaned = stripMarkdownLinks(withoutReferenceDefinitions, referenceLabels)
    .replace(/`+/g, "")
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?)/gm, "")
    .replace(/^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, " · ")
    .replace(/\*\*([^\s*\n](?:[^*\n]*[^\s*\n])?)\*\*/g, "$1")
    .replace(
      /(^|[^\p{L}\p{N}\p{M}_])__([^\s_\n](?:[^_\n]*[^\s_\n])?)__(?=$|[^\p{L}\p{N}\p{M}_])/gu,
      "$1$2",
    )
    .replace(/~~([^\s~\n](?:[^~\n]*[^\s~\n])?)~~/g, "$1")
    .replace(
      /(^|[^\p{L}\p{N}\p{M}_])\*([^\s*\n](?:[^*\n]*[^\s*\n])?)\*(?=$|[^\p{L}\p{N}\p{M}_])/gu,
      "$1$2",
    )
    .replace(
      /(^|[^\p{L}\p{N}\p{M}_])_([^\s_\n](?:[^_\n]*[^\s_\n])?)_(?=$|[^\p{L}\p{N}\p{M}_])/gu,
      "$1$2",
    );
  return restore(cleaned).trim().replace(/\s+/g, " ");
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Grapheme boundaries are found only in this many code units before the cut, which covers
// any real cluster (long emoji ZWJ sequences included) without segmenting the whole text.
const GRAPHEME_CUT_WINDOW = 64;

/**
 * Caps `text` at `maxLength` UTF-16 code units, the trailing "…" included. The cut lands on a
 * grapheme boundary, so an emoji, flag or accented letter is never split.
 */
export function truncatePlainText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  const budget = maxLength - 1;
  const windowStart = Math.max(0, budget - GRAPHEME_CUT_WINDOW);
  // One code point past the budget decides whether a boundary falls exactly on it.
  const window = text.slice(windowStart, budget + 2);
  let end = windowStart;
  for (const { index } of graphemeSegmenter.segment(window)) {
    const boundary = windowStart + index;
    if (boundary > budget) {
      break;
    }
    end = boundary;
  }
  return `${text.slice(0, end).trimEnd()}…`;
}
