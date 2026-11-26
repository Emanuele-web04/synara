// FILE: canvasRichText.ts
// Purpose: The DOM side of editing a text block in place: its runs (text and styled ranges)
//          read back from the element being typed into, runs written back to it through the
//          canvas sanitizer, character offsets for the selection, and the text a commit saves.
//          Only text and the editor's own spans are read back: markup the browser adds while
//          typing counts as its text and line breaks, never as styles, so it never reaches the
//          store.
// Layer: Canvas editor input
// Exports: readTextRuns, writeTextRuns, textSelectionOf, selectTextRange, insertPlainText,
//          savedTextRuns, HARD_BREAK, types

import { overlayDesignTextStyle, type DesignTextRun } from "@synara/shared/designCanvasText";
import { sanitizeDesignStyle, type DesignRenderContext } from "~/lib/designCanvas";

/**
 * A line break the browser made (a `br`, or a block it inserted on Enter) while the edit is open.
 * It differs from a newline character in the text, which renders by the block's `white-space`.
 */
export const HARD_BREAK = "\u2028";

/** The span elements of the block being edited: each one's stored style and span layer ID. */
export type TextRangeElements = WeakMap<Element, { style: string; source?: string }>;

/** Elements a browser may wrap typed lines in. */
const LINE_TAGS = new Set(["div", "p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"]);

export type ReadText = {
  runs: DesignTextRun[];
  /** Where each node of the element starts, in characters, in document order. */
  starts: ReadonlyMap<Node, number>;
  length: number;
};

/** The element's text as runs, with the style and span each character sits in. */
export function readTextRuns(element: HTMLElement, ranges: TextRangeElements): ReadText {
  const runs: DesignTextRun[] = [];
  const starts = new Map<Node, number>();
  let length = 0;
  const push = (text: string, style: string, source: string | undefined) => {
    runs.push({ text, style, ...(source === undefined ? {} : { source }) });
    length += text.length;
  };
  const visit = (parent: Node, style: string, source: string | undefined) => {
    for (const child of parent.childNodes) {
      starts.set(child, length);
      if (child.nodeType === Node.TEXT_NODE) {
        push((child as Text).data, style, source);
        continue;
      }
      if (!(child instanceof Element)) continue;
      if (child.localName === "br") {
        push(HARD_BREAK, style, source);
        continue;
      }
      const range = ranges.get(child);
      const last = runs.at(-1)?.text.at(-1);
      if (!range && LINE_TAGS.has(child.localName) && length > 0 && last !== HARD_BREAK)
        push(HARD_BREAK, style, source);
      visit(
        child,
        range ? overlayDesignTextStyle(style, range.style) : style,
        range?.source ?? source,
      );
    }
  };
  visit(element, "", undefined);
  // A trailing `br` only holds the caret on an empty last line; it renders nothing.
  const tail = runs.at(-1);
  if (tail?.text.endsWith(HARD_BREAK)) {
    tail.text = tail.text.slice(0, -1);
    length--;
  }
  return { runs, starts, length };
}

/** Replaces the element's content with `runs`: text, `br` for hard breaks, one span per range. */
export function writeTextRuns(
  element: HTMLElement,
  runs: readonly DesignTextRun[],
  ranges: TextRangeElements,
  context: DesignRenderContext,
): void {
  const owner = element.ownerDocument;
  const content = (text: string): Node[] =>
    text.split(HARD_BREAK).flatMap((part, index) => {
      const nodes: Node[] = index > 0 ? [owner.createElement("br")] : [];
      if (part) nodes.push(owner.createTextNode(part));
      return nodes;
    });
  const nodes = runs.flatMap((run): Node[] => {
    if (!run.style) return content(run.text);
    const span = owner.createElement("span");
    for (const [property, value, priority] of sanitizeDesignStyle(run.style, context))
      span.style.setProperty(property, value, priority);
    span.append(...content(run.text));
    ranges.set(span, {
      style: run.style,
      ...(run.source === undefined ? {} : { source: run.source }),
    });
    return [span];
  });
  element.replaceChildren(...nodes);
}

/** The DOM range the document's selection holds inside `element`'s shadow root, if any. */
function liveRange(element: HTMLElement): Range | StaticRange | null {
  const root = element.getRootNode();
  const shadow = root instanceof ShadowRoot ? root : null;
  const scoped = (shadow as (ShadowRoot & { getSelection?: () => Selection | null }) | null)
    ?.getSelection;
  const selection = scoped ? scoped.call(shadow) : document.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const composed = (
    selection as Selection & {
      getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[];
    }
  ).getComposedRanges;
  const range =
    !scoped && shadow && composed
      ? (composed.call(selection, { shadowRoots: [shadow] })[0] ?? null)
      : selection.getRangeAt(0);
  if (!range || !element.contains(range.startContainer) || !element.contains(range.endContainer))
    return null;
  return range;
}

/** The character offset of a DOM position inside `element`, as `readTextRuns` counts them. */
function offsetOf(read: ReadText, element: HTMLElement, node: Node, offset: number): number {
  const clamp = (value: number) => Math.max(0, Math.min(read.length, value));
  if (node.nodeType === Node.TEXT_NODE) return clamp((read.starts.get(node) ?? 0) + offset);
  const child = node.childNodes[offset];
  if (child) return clamp(read.starts.get(child) ?? read.length);
  // The end of `node`: where the next node after it starts.
  for (
    let current: Node | null = node;
    current && current !== element;
    current = current.parentNode
  )
    if (current.nextSibling) return clamp(read.starts.get(current.nextSibling) ?? read.length);
  return read.length;
}

export type TextSelection = { start: number; end: number };

/** The selection inside `element` as character offsets, or null when it is elsewhere. */
export function textSelectionOf(element: HTMLElement, read: ReadText): TextSelection | null {
  const range = liveRange(element);
  if (!range) return null;
  const a = offsetOf(read, element, range.startContainer, range.startOffset);
  const b = offsetOf(read, element, range.endContainer, range.endOffset);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/**
 * The DOM position of a character offset. A start prefers the text node that begins there, an
 * end (and a caret) the one that ends there, so a range keeps to the runs it covers and a caret
 * after a styled word keeps typing in its style.
 */
function positionOf(
  element: HTMLElement,
  read: ReadText,
  offset: number,
  prefer: "start" | "end",
): { node: Node; offset: number } {
  let fallback: { node: Node; offset: number } | null = null;
  for (const [node, start] of read.starts) {
    if (node.nodeType === Node.TEXT_NODE) {
      const end = start + (node as Text).length;
      const inside =
        prefer === "start" ? offset >= start && offset < end : offset > start && offset <= end;
      if (inside) return { node, offset: offset - start };
      if (offset >= start && offset <= end) fallback ??= { node, offset: offset - start };
    } else if (node instanceof Element && node.localName === "br" && node.parentNode) {
      const index = [...node.parentNode.childNodes].indexOf(node as ChildNode);
      if (offset === start) fallback ??= { node: node.parentNode, offset: index };
      else if (offset === start + 1) fallback ??= { node: node.parentNode, offset: index + 1 };
    }
  }
  return fallback ?? { node: element, offset: offset <= 0 ? 0 : element.childNodes.length };
}

/** Selects characters `[start, end)` of `element` (a caret when they are equal). */
export function selectTextRange(element: HTMLElement, read: ReadText, selection: TextSelection) {
  const range = element.ownerDocument.createRange();
  const collapsed = selection.start === selection.end;
  const from = positionOf(element, read, selection.start, collapsed ? "end" : "start");
  const to = collapsed ? from : positionOf(element, read, selection.end, "end");
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  const api = document.getSelection();
  api?.removeAllRanges();
  api?.addRange(range);
}

/** A DOM range over characters `[start, end)`, for highlighting a selection kept while blurred. */
export function textDomRange(
  element: HTMLElement,
  read: ReadText,
  selection: TextSelection,
): Range {
  const range = element.ownerDocument.createRange();
  const from = positionOf(element, read, selection.start, "start");
  const to = positionOf(element, read, selection.end, "end");
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

/**
 * Pasted text goes in as plain text where the selection is, never as markup: inside a styled
 * range it takes that range's style. Line breaks become `br` where the block collapses newlines.
 * Returns the caret offset after the inserted text.
 */
export function insertPlainText(
  element: HTMLElement,
  ranges: TextRangeElements,
  selection: TextSelection,
  text: string,
  collapsesNewlines: boolean,
): number {
  const read = readTextRuns(element, ranges);
  const range = textDomRange(element, read, selection);
  range.deleteContents();
  const owner = element.ownerDocument;
  const fragment = owner.createDocumentFragment();
  const lines = collapsesNewlines ? text.split("\n") : [text];
  lines.forEach((line, index) => {
    if (index > 0) fragment.append(owner.createElement("br"));
    if (line) fragment.append(owner.createTextNode(line));
  });
  range.insertNode(fragment);
  return selection.start + text.length;
}

/**
 * The runs a commit saves. Without hard breaks the text is exactly what the element holds, so
 * nothing the user did not touch changes. With them, a block that collapses whitespace keeps
 * its text as shown (spaces collapsed, none at line ends) and needs `white-space: pre-wrap`,
 * as a plain text edit does; hard breaks become newlines.
 */
export function savedTextRuns(
  runs: readonly DesignTextRun[],
  collapsesNewlines: boolean,
): { runs: DesignTextRun[]; breaks: boolean } {
  const breaks = runs.some((run) => run.text.includes(HARD_BREAK));
  if (!breaks) return { runs: [...runs], breaks };
  const text = runs.map((run) => run.text).join("");
  // What each UTF-16 unit becomes: itself, a newline for a hard break, a space, or nothing.
  const out: (string | null)[] = [];
  let last: "edge" | "space" | "char" = "edge";
  let pendingSpace = -1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === HARD_BREAK) {
      if (last === "space") out[pendingSpace] = null;
      out[index] = "\n";
      last = "edge";
    } else if (!collapsesNewlines || !/[ \t\n\r\f]/.test(char)) {
      out[index] = char;
      last = "char";
    } else if (last === "char") {
      out[index] = " ";
      last = "space";
      pendingSpace = index;
    } else out[index] = null;
  }
  if (last === "space") out[pendingSpace] = null;
  let at = 0;
  const saved = runs.map((run) => {
    let value = "";
    for (let index = 0; index < run.text.length; index++) value += out[at++] ?? "";
    return { ...run, text: value };
  });
  return { runs: saved, breaks };
}
