// FILE: streamingMarkdownBlocks.ts
// Purpose: Splits streaming assistant markdown into settled top-level blocks
//          and a growing tail, so only the tail is re-parsed per token.
// Layer: Web chat presentation logic
// Exports: splitStreamingMarkdownBlocks, buildStreamingMarkdownChildren,
//          useStreamingMarkdownChildren, StreamingMarkdownBlock, StreamingMarkdownSplit
//
// A boundary is only placed where parsing the two sides separately cannot
// change CommonMark/GFM output:
//   1. at a complete line in column 0 that is an ATX heading, a ``` / ~~~ fence
//      opener, or a thematic break, directly after a blank line, while no
//      top-level fenced code or `$$` math block is open; such a line closes every
//      open list item, blockquote, table, indented code and type 6/7 HTML block;
//   2. at the first non-blank line after a top-level fence (or `$$` block)
//      closes.
// Anything the line scanner cannot classify with certainty (lazy continuation
// lines inside lists, tabs in block structure, HTML blocks that continue past
// one line, list markers that may or may not interrupt a paragraph, empty list
// items) stops further splitting: the rest of the text stays in the tail. Text
// with link reference definitions or footnotes, which resolve across blocks, is
// never split.

import { cloneElement, isValidElement, useRef, type ReactNode } from "react";

export interface StreamingMarkdownBlock {
  /** Source of the block, including its trailing blank lines. */
  readonly text: string;
  /** UTF-16 offset of the block's first character in the full text. */
  readonly offset: number;
  /** 1-based line number of the block's first line in the full text. */
  readonly line: number;
}

export interface StreamingMarkdownSplit {
  /** The text that was split; blocks join back to it byte for byte. */
  readonly text: string;
  /** Settled blocks followed by the tail block. Never empty. */
  readonly blocks: readonly StreamingMarkdownBlock[];
  /** Whether a blank line precedes the tail block (scanner resume state). */
  readonly tailFollowsBlankLine: boolean;
}

// Link reference definitions (`[label]: url`, including footnote definitions
// `[^1]: note`) resolve references across the whole document. A definition
// starts a line after optional container prefixes; a label without a closing
// bracket on its first line may continue on the next one. Over-matching only
// costs the split. References without a definition render as literal text in
// both modes, so they need no bail-out.
const DEFINITION_LINE_PATTERN =
  /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+[ \t>]*)*\[(?:[^\n]*\]:|[^\]\n]*$)/m;
// The still-streaming last line only defines anything once its `]:` arrived.
const STREAMING_DEFINITION_LINE_PATTERN =
  /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+[ \t>]*)*\[[^\n]*\]:/;
const THEMATIC_BREAK_PATTERN = /^(?:(?:\*[ ]*){3,}|(?:-[ ]*){3,}|(?:_[ ]*){3,})$/;
const ATX_HEADING_PATTERN = /^#{1,6}(?: |$)/;
const BACKTICK_FENCE_OPENER_PATTERN = /^(`{3,})[^`]*$/;
const TILDE_FENCE_OPENER_PATTERN = /^(~{3,})/;
const MATH_FENCE_OPENER_PATTERN = /^(\${2,})[^$]*$/;
const FENCE_CLOSER_PATTERN = /^ {0,3}(`{3,}|~{3,}|\${2,})[ \t]*$/;
const BULLET_LIST_MARKER_PATTERN = /^([-*+])(?:( +)(.*))?$/;
const ORDERED_LIST_MARKER_PATTERN = /^(\d{1,9})([.)])(?:( +)(.*))?$/;
// HTML block start conditions 1-5 continue past blank lines.
const MULTILINE_HTML_BLOCK_START_PATTERN =
  /^<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--|\?|![A-Za-z]|!\[CDATA\[)/i;

interface Fence {
  readonly marker: string;
  readonly length: number;
}

interface ListItem {
  readonly contentIndent: number;
  /** Bullet character or ordered delimiter; equal kinds continue one list. */
  readonly kind: string;
}

type LineClass =
  | { readonly type: "indented" | "break" | "heading" | "quote" | "html" | "text" }
  | { readonly type: "fence"; readonly fence: Fence; readonly splittable: boolean }
  | {
      readonly type: "list";
      readonly kind: string;
      readonly canInterruptParagraph: boolean;
      readonly markerWidth: number;
      readonly spacesAfterMarker: number;
      readonly content: string;
    };

function classifyContent(content: string, relativeIndent: number): LineClass {
  if (relativeIndent >= 4) return { type: "indented" };
  if (THEMATIC_BREAK_PATTERN.test(content)) return { type: "break" };
  if (ATX_HEADING_PATTERN.test(content)) return { type: "heading" };
  const fenceMatch =
    BACKTICK_FENCE_OPENER_PATTERN.exec(content) ?? TILDE_FENCE_OPENER_PATTERN.exec(content);
  if (fenceMatch) {
    const sequence = fenceMatch[1]!;
    return {
      type: "fence",
      fence: { marker: sequence[0]!, length: sequence.length },
      splittable: true,
    };
  }
  const mathMatch = MATH_FENCE_OPENER_PATTERN.exec(content);
  if (mathMatch) {
    return {
      type: "fence",
      fence: { marker: "$", length: mathMatch[1]!.length },
      splittable: false,
    };
  }
  if (content.startsWith(">")) return { type: "quote" };
  if (content.startsWith("<")) return { type: "html" };
  const bullet = BULLET_LIST_MARKER_PATTERN.exec(content);
  if (bullet) {
    const itemContent = bullet[3] ?? "";
    return {
      type: "list",
      kind: bullet[1]!,
      canInterruptParagraph: itemContent.trim().length > 0,
      markerWidth: 1,
      spacesAfterMarker: bullet[2]?.length ?? 0,
      content: itemContent,
    };
  }
  const ordered = ORDERED_LIST_MARKER_PATTERN.exec(content);
  if (ordered) {
    const itemContent = ordered[4] ?? "";
    return {
      type: "list",
      kind: ordered[2]!,
      canInterruptParagraph: ordered[1] === "1" && itemContent.trim().length > 0,
      markerWidth: ordered[1]!.length + 1,
      spacesAfterMarker: ordered[3]?.length ?? 0,
      content: itemContent,
    };
  }
  return { type: "text" };
}

function isFenceCloser(line: string, fence: Fence): boolean {
  const match = FENCE_CLOSER_PATTERN.exec(line);
  const sequence = match?.[1];
  return sequence !== undefined && sequence[0] === fence.marker && sequence.length >= fence.length;
}

function leadingSpaceCount(line: string): number {
  let count = 0;
  while (line.charCodeAt(count) === 32) count += 1;
  return count;
}

// Leading whitespace width in columns (tabs advance to the next multiple of 4)
// and the index of the first non-whitespace character.
function leadingColumns(line: string): { readonly columns: number; readonly index: number } {
  let columns = 0;
  let index = 0;
  for (; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    if (code === 32) columns += 1;
    else if (code === 9) columns += 4 - (columns % 4);
    else break;
  }
  return { columns, index };
}

/**
 * Line scanner over complete lines. `isBoundary` reports whether the line about
 * to be scanned starts a new top-level block and never mutates state.
 */
class BlockScanner {
  private readonly stack: ListItem[] = [];
  private topFence: Fence | null = null;
  private innerFence: (Fence & { readonly contentIndent: number }) | null = null;
  private previousBlank: boolean;
  private previousHtmlStart = false;
  private boundaryAfterFence = false;
  /** No further boundary can be placed with certainty. */
  poisoned = false;
  /** A possible reference definition was seen: the text must not be split. */
  hasDefinition = false;

  constructor(previousBlank: boolean) {
    this.previousBlank = previousBlank;
  }

  get followsBlankLine(): boolean {
    return this.previousBlank;
  }

  /** Whether `line`, scanned next, would be fenced code content (or its closer). */
  isFencedContent(line: string): boolean {
    if (this.poisoned) return false;
    if (this.topFence) return true;
    return (
      this.innerFence !== null && leadingColumns(line).columns >= this.innerFence.contentIndent
    );
  }

  isBoundary(line: string): boolean {
    if (this.poisoned || this.topFence || line.trim().length === 0) return false;
    if (this.boundaryAfterFence) return true;
    if (!this.previousBlank || line.charCodeAt(0) === 32 || line.includes("\t")) return false;
    const lineClass = classifyContent(line, 0);
    return (
      lineClass.type === "heading" ||
      lineClass.type === "break" ||
      (lineClass.type === "fence" && lineClass.splittable)
    );
  }

  scan(line: string): void {
    if (this.poisoned) return;
    if (this.topFence) {
      if (isFenceCloser(line, this.topFence)) {
        this.topFence = null;
        this.boundaryAfterFence = true;
      }
      this.previousBlank = false;
      return;
    }
    if (line.trim().length === 0) {
      this.previousBlank = true;
      this.previousHtmlStart = false;
      return;
    }
    this.boundaryAfterFence = false;
    // An HTML-looking line followed by another non-blank line may be a
    // multi-line HTML block or a paragraph; the two parse differently.
    if (this.previousHtmlStart) {
      this.poisoned = true;
      return;
    }
    let mayContinueLazily = !this.previousBlank;
    if (this.innerFence) {
      const { columns, index } = leadingColumns(line);
      if (columns >= this.innerFence.contentIndent) {
        if (
          columns - this.innerFence.contentIndent <= 3 &&
          isFenceCloser(line.slice(index), this.innerFence)
        ) {
          this.innerFence = null;
        }
        this.previousBlank = false;
        return;
      }
      // Fenced code is never lazily continued: this line closes the item.
      this.innerFence = null;
      mayContinueLazily = false;
    }
    // Tabs make list and quote indentation column-dependent.
    if (line.includes("\t")) {
      this.poisoned = true;
      return;
    }
    if (DEFINITION_LINE_PATTERN.test(line)) {
      this.hasDefinition = true;
      return;
    }

    const indent = leadingSpaceCount(line);
    const content = line.slice(indent);
    let lastClosedItem: ListItem | undefined;
    const innermost = this.stack.at(-1);
    if (innermost && indent < innermost.contentIndent) {
      const lineClass = classifyContent(content, 0);
      const interruptsParagraph =
        lineClass.type === "break" ||
        lineClass.type === "heading" ||
        lineClass.type === "fence" ||
        lineClass.type === "quote" ||
        lineClass.type === "list";
      if (mayContinueLazily && !interruptsParagraph) {
        // Possibly a lazy paragraph continuation inside the list item.
        this.poisoned = true;
        return;
      }
      while ((this.stack.at(-1)?.contentIndent ?? -1) > indent) {
        lastClosedItem = this.stack.pop();
      }
    }

    const containerIndent = this.stack.at(-1)?.contentIndent ?? 0;
    this.scanContent(content, indent - containerIndent, indent, lastClosedItem);
    this.previousBlank = false;
  }

  private scanContent(
    content: string,
    relativeIndent: number,
    absoluteIndent: number,
    lastClosedItem: ListItem | undefined,
  ): void {
    const lineClass = classifyContent(content, relativeIndent);
    switch (lineClass.type) {
      case "fence": {
        const innermost = this.stack.at(-1);
        if (innermost) {
          this.innerFence = { ...lineClass.fence, contentIndent: innermost.contentIndent };
        } else {
          this.topFence = lineClass.fence;
        }
        return;
      }
      case "html": {
        if (MULTILINE_HTML_BLOCK_START_PATTERN.test(content)) {
          this.poisoned = true;
          return;
        }
        this.previousHtmlStart = true;
        return;
      }
      case "list": {
        const continuesList = lastClosedItem?.kind === lineClass.kind;
        if (
          lineClass.content.trim().length === 0 ||
          lineClass.spacesAfterMarker > 4 ||
          (!this.previousBlank && !continuesList && !lineClass.canInterruptParagraph)
        ) {
          this.poisoned = true;
          return;
        }
        const contentIndent = absoluteIndent + lineClass.markerWidth + lineClass.spacesAfterMarker;
        this.stack.push({ contentIndent, kind: lineClass.kind });
        // The item's first line may itself open a nested block; nothing in the
        // new item precedes it, so it cannot interrupt a paragraph.
        const wasBlank = this.previousBlank;
        this.previousBlank = true;
        this.scanContent(lineClass.content, 0, contentIndent, undefined);
        this.previousBlank = wasBlank;
        return;
      }
      default:
        return;
    }
  }
}

function singleBlockSplit(text: string): StreamingMarkdownSplit {
  return { text, blocks: [{ text, offset: 0, line: 1 }], tailFollowsBlankLine: false };
}

/**
 * Splits `text` into settled top-level blocks plus the tail block. Passing the
 * previous split resumes scanning at its tail when the settled prefix is
 * unchanged, reusing those block objects. Returns a single block when the text
 * cannot be split safely.
 */
export function splitStreamingMarkdownBlocks(
  text: string,
  previous?: StreamingMarkdownSplit | null,
): StreamingMarkdownSplit {
  if (text.includes("\r")) return singleBlockSplit(text);

  const blocks: StreamingMarkdownBlock[] = [];
  let blockStart = 0;
  let blockLine = 1;
  let blockFollowsBlank = false;
  const previousTail = previous?.blocks.at(-1);
  if (
    previous &&
    previousTail &&
    previousTail.offset > 0 &&
    text.length >= previousTail.offset &&
    text.startsWith(previous.text.slice(0, previousTail.offset))
  ) {
    // Settled blocks end before the tail and never change once text is only
    // appended; the scanner state at a block start is always the initial one.
    blocks.push(...previous.blocks.slice(0, -1));
    blockStart = previousTail.offset;
    blockLine = previousTail.line;
    blockFollowsBlank = previous.tailFollowsBlankLine;
  }

  const scanner = new BlockScanner(blockFollowsBlank);
  let lineStart = blockStart;
  let lineNumber = blockLine;
  for (;;) {
    const lineEnd = text.indexOf("\n", lineStart);
    // The last line is still streaming; its meaning can change.
    if (lineEnd < 0) break;
    const line = text.slice(lineStart, lineEnd);
    if (lineStart > blockStart && scanner.isBoundary(line)) {
      const blockText = text.slice(blockStart, lineStart);
      if (blockText.trim().length > 0) {
        blocks.push({ text: blockText, offset: blockStart, line: blockLine });
        blockStart = lineStart;
        blockLine = lineNumber;
        blockFollowsBlank = scanner.followsBlankLine;
      }
    }
    scanner.scan(line);
    if (scanner.hasDefinition) return singleBlockSplit(text);
    if (scanner.poisoned) break;
    lineStart = lineEnd + 1;
    lineNumber += 1;
  }
  // Lines the scanner did not classify (from an uncertain line on, and the
  // still-streaming last line) can still hold a definition.
  const lastLineStart = text.lastIndexOf("\n") + 1;
  if (
    lineStart < lastLineStart &&
    DEFINITION_LINE_PATTERN.test(text.slice(lineStart, lastLineStart))
  ) {
    return singleBlockSplit(text);
  }
  const lastLine = text.slice(Math.max(lineStart, lastLineStart));
  if (!scanner.isFencedContent(lastLine) && STREAMING_DEFINITION_LINE_PATTERN.test(lastLine)) {
    return singleBlockSplit(text);
  }

  blocks.push({ text: text.slice(blockStart), offset: blockStart, line: blockLine });
  return { text, blocks, tailFollowsBlankLine: blockFollowsBlank };
}

/** One parsed block: its root children, plus the same children keyed for the whole text. */
interface ParsedStreamingMarkdownBlock {
  readonly block: StreamingMarkdownBlock;
  readonly children: readonly ReactNode[];
  /** Per-tag element counts of all earlier blocks, which `keyed` was derived from. */
  readonly keyCountsBefore: string;
  readonly keyed: readonly ReactNode[];
}

export interface StreamingMarkdownChildren<Options extends object> {
  readonly text: string;
  readonly splitBlocks: boolean;
  readonly options: Options;
  readonly parseBlock: (block: StreamingMarkdownBlock, options: Options) => readonly ReactNode[];
  readonly split: StreamingMarkdownSplit | null;
  readonly blocks: readonly ParsedStreamingMarkdownBlock[];
  /** Root children of a single parse of `text`, keys included. */
  readonly children: readonly ReactNode[];
}

// hast-util-to-jsx-runtime keys each element `<tagName>-<index among its
// siblings with that tag name>`; text children carry no key.
const MARKDOWN_ELEMENT_KEY_PATTERN = /^(.+)-(\d+)$/;

function markdownElementKey(child: ReactNode): RegExpExecArray | null {
  return isValidElement(child) && child.key !== null
    ? MARKDOWN_ELEMENT_KEY_PATTERN.exec(child.key)
    : null;
}

function serializeKeyCounts(counts: ReadonlyMap<string, number>): string {
  let serialized = "";
  for (const [name, count] of counts) serialized += `${name}:${count},`;
  return serialized;
}

// Re-keys a block's top-level elements to the keys a single parse of the whole
// text gives them: offset by the elements with the same tag in earlier blocks.
function keyBlockChildren(
  children: readonly ReactNode[],
  countsBefore: ReadonlyMap<string, number>,
): readonly ReactNode[] {
  if (countsBefore.size === 0) return children;
  return children.map((child) => {
    const match = markdownElementKey(child);
    const base = match ? (countsBefore.get(match[1]!) ?? 0) : 0;
    return match && base > 0 && isValidElement(child)
      ? cloneElement(child, { key: `${match[1]!}-${base + Number(match[2])}` })
      : child;
  });
}

function addKeyCounts(children: readonly ReactNode[], counts: Map<string, number>): void {
  for (const child of children) {
    const match = markdownElementKey(child);
    if (match) counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
  }
}

function shallowEqualObjects(previous: object, next: object): boolean {
  const previousEntries = Object.entries(previous);
  if (previousEntries.length !== Object.keys(next).length) return false;
  return previousEntries.every(([key, value]) => (next as Record<string, unknown>)[key] === value);
}

/**
 * Builds the root children of a single markdown parse of `text`. With
 * `splitBlocks`, settled blocks are parsed once and reused from `previous`
 * (same element objects, so React skips them too); only changed blocks, in
 * practice the streaming tail, go through `parseBlock`. Each block's children
 * are re-keyed and joined with the newline text nodes mdast-util-to-hast puts
 * between top-level siblings, so the result equals a single parse element for
 * element and switching `splitBlocks` off updates the same DOM in place.
 */
export function buildStreamingMarkdownChildren<Options extends object>(
  previous: StreamingMarkdownChildren<Options> | null,
  text: string,
  splitBlocks: boolean,
  options: Options,
  parseBlock: (block: StreamingMarkdownBlock, options: Options) => readonly ReactNode[],
): StreamingMarkdownChildren<Options> {
  const reusable =
    previous !== null &&
    previous.parseBlock === parseBlock &&
    shallowEqualObjects(previous.options, options)
      ? previous
      : null;
  if (reusable !== null && reusable.text === text && reusable.splitBlocks === splitBlocks) {
    return reusable;
  }

  const split = splitBlocks ? splitStreamingMarkdownBlocks(text, reusable?.split ?? null) : null;
  const blocks = split?.blocks ?? [{ text, offset: 0, line: 1 }];
  const counts = new Map<string, number>();
  const parsedBlocks: ParsedStreamingMarkdownBlock[] = [];
  const children: ReactNode[] = [];
  for (const [index, block] of blocks.entries()) {
    const cached = reusable?.blocks[index];
    const blockChildren =
      cached !== undefined &&
      cached.block.offset === block.offset &&
      cached.block.text === block.text
        ? cached.children
        : parseBlock(block, options);
    const keyCountsBefore = serializeKeyCounts(counts);
    const keyed =
      cached !== undefined &&
      cached.children === blockChildren &&
      cached.keyCountsBefore === keyCountsBefore
        ? cached.keyed
        : keyBlockChildren(blockChildren, counts);
    addKeyCounts(blockChildren, counts);
    parsedBlocks.push({ block, children: blockChildren, keyCountsBefore, keyed });
    if (children.length > 0 && keyed.length > 0) children.push("\n");
    children.push(...keyed);
  }
  return { text, splitBlocks, options, parseBlock, split, blocks: parsedBlocks, children };
}

/**
 * Hook form of `buildStreamingMarkdownChildren`. `parseBlock` should be a
 * module-level function; `options` is compared field by field.
 *
 * The cache ref is deliberately read and written during render: it is a pure
 * memo cache keyed on the inputs it stores, so a discarded concurrent render at
 * worst stores elements that are still correct for those inputs. React
 * Compiler cannot verify that and skips this hook — keeping the pattern
 * isolated here keeps ChatMarkdown compiler-eligible.
 */
export function useStreamingMarkdownChildren<Options extends object>(
  text: string,
  splitBlocks: boolean,
  options: Options,
  parseBlock: (block: StreamingMarkdownBlock, options: Options) => readonly ReactNode[],
): readonly ReactNode[] {
  const cacheRef = useRef<StreamingMarkdownChildren<Options> | null>(null);
  const next = buildStreamingMarkdownChildren(
    cacheRef.current,
    text,
    splitBlocks,
    options,
    parseBlock,
  );
  cacheRef.current = next;
  return next.children;
}
