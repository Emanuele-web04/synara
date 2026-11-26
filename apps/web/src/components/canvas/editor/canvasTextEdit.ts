// FILE: canvasTextEdit.ts
// Purpose: The styling side of one in-place text edit: ⌘B, ⌘I, ⌘U and the inspector's text
//          styles on the selected range (or on the whole block when nothing is selected), a local
//          undo history once the editor has rewritten the element, plain-text paste, and the one
//          layer edit the commit saves for the typing and the styling together. Styled ranges
//          are plain spans (`@synara/shared/designCanvasText`); the browser never formats text.
// Layer: Canvas editor input
// Exports: createTextEdit, TextEdit, TextFormat

import type { DesignLayerEdit } from "@synara/contracts";
import { declaredStyles, designStyleKey } from "@synara/shared/designCanvasLayers";
import {
  DESIGN_TEXT_DECORATION_PROPERTIES,
  canHoldDesignTextRanges,
  designTextBlockKind,
  designTextEditOperations,
  designTextRangeSpans,
  hoistDesignTextRuns,
  isDesignTextRangeProperty,
  normalizeDesignTextRuns,
  patchDesignTextStyle,
  pushDownDesignTextStyle,
  sameDesignTextStyle,
  styleDesignTextRange,
  styleDesignTextRuns,
  type DesignTextRun,
  type DesignTextStylePatch,
} from "@synara/shared/designCanvasText";
import { sanitizeDesignStyle, type DesignRenderContext } from "~/lib/designCanvas";
import { canvasId } from "./canvasClipboard";
import type { CanvasEditorApi } from "./CanvasEditorContext";
import {
  insertPlainText,
  readTextRuns,
  savedTextRuns,
  selectTextRange,
  textDomRange,
  textSelectionOf,
  writeTextRuns,
  type ReadText,
  type TextRangeElements,
  type TextSelection,
} from "./canvasRichText";
import type { LayerItem } from "./canvasSelection";
import type { CanvasTextSegment, CanvasTextSession } from "./canvasTextSession";

export type TextFormat = "bold" | "italic" | "underline" | "strikethrough";

export type TextEdit = {
  /** What the inspector reads and styles through. */
  session: CanvasTextSession;
  /** ⌘B / ⌘I / ⌘U / ⌘⇧X: on when any selected character lacks it, else off. */
  toggle: (format: TextFormat) => void;
  /** Undo or redo inside the edit; false leaves it to the browser (nothing was rewritten). */
  history: (direction: "undo" | "redo") => boolean;
  beforeInput: (event: InputEvent) => void;
  /** Something was typed: the inspector re-reads. */
  input: () => void;
  paste: (text: string) => void;
  /** Remembers the selection while it is inside the element. */
  selectionChanged: () => void;
  /** The element lost focus to the inspector: show the kept range; `release` clears it. */
  hold: () => void;
  release: () => void;
  /**
   * What saving the edit sends (null for nothing), ending it: open previews are dropped. A block
   * that holds no styled range saves as plain text did before, through `plain`.
   */
  operations: (
    plain: (typed: string, collapsesNewlines: boolean) => DesignLayerEdit[] | null,
  ) => DesignLayerEdit[] | null;
};

type Snapshot = {
  runs: DesignTextRun[];
  block: Record<string, string | null>;
  selection: TextSelection | null;
};

/** Spans carry these; when equal to the block's own value, a range does not repeat it. */
const INHERITED_RANGE_PROPERTIES = new Set([
  "color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "line-height",
  "text-transform",
  "text-decoration-skip-ink",
  "text-underline-offset",
  "text-underline-position",
  "-webkit-text-stroke-width",
  "-webkit-text-stroke-color",
  "paint-order",
]);
/** Tags the browser draws bold, italic or underlined without a style. */
const BOLD_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "b", "strong", "th"]);
const ITALIC_TAGS = new Set(["em", "i", "cite", "var", "dfn", "address"]);
const UNDERLINE_TAGS = new Set(["a", "u", "ins"]);
const STRIKETHROUGH_TAGS = new Set(["s", "del", "strike"]);
const FORMAT_INPUTS: Readonly<Record<string, TextFormat>> = {
  formatBold: "bold",
  formatItalic: "italic",
  formatUnderline: "underline",
  formatStrikeThrough: "strikethrough",
};
/** Keystrokes typed within this long, of one kind, undo together. */
const TYPING_GROUP_MS = 1000;
const HISTORY_LIMIT = 100;
const HIGHLIGHT_NAME = "synara-canvas-text";

const weightOf = (value: string) =>
  value === "bold" ? 700 : value === "normal" ? 400 : Number.parseFloat(value) || 400;
const decorationLines = (element: Element) =>
  getComputedStyle(element).textDecorationLine.split(/\s+/);

let probe: HTMLElement | null = null;
/** Whether `value` for `property` is what the element computes already. */
function sameAsComputed(property: string, value: string, computed: CSSStyleDeclaration): boolean {
  const current = computed.getPropertyValue(property);
  if (property === "font-weight") return weightOf(value) === weightOf(current);
  probe ??= document.createElement("div");
  probe.style.setProperty(property, value);
  const specified = probe.style.getPropertyValue(property);
  probe.style.removeProperty(property);
  return specified !== "" && specified === current;
}

type Highlights = {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
};
const highlights = (): { registry: Highlights; make: (range: Range) => unknown } | null => {
  const registry = (globalThis.CSS as { highlights?: Highlights } | undefined)?.highlights;
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return registry && Highlight ? { registry, make: (range) => new Highlight(range) } : null;
};

/**
 * Whether the characters an element holds have `format`. Decoration drawn by the block counts
 * for its styled ranges too.
 */
export function isTextFormatOn(format: TextFormat, owner: HTMLElement, block: HTMLElement) {
  const style = getComputedStyle(owner);
  if (format === "bold") return weightOf(style.fontWeight) >= 600;
  if (format === "italic") return /italic|oblique/.test(style.fontStyle);
  const line = format === "underline" ? "underline" : "line-through";
  return (
    decorationLines(owner).includes(line) ||
    (owner !== block && decorationLines(block).includes(line))
  );
}

/**
 * The style ⌘B / ⌘I / ⌘U / ⌘⇧X write: on is bold 700, italic, an underline or a line through
 * (the two lines combine); off on a range
 * goes back to normal (a value equal to the block's is then left off the span), and off on the
 * whole block removes the style, unless its tag or its parent would still show it.
 */
export function textFormatPatch(
  format: TextFormat,
  on: boolean,
  ranged: boolean,
  block: HTMLElement,
): DesignTextStylePatch {
  const tag = block.localName;
  const parent = block.parentElement ? getComputedStyle(block.parentElement) : null;
  if (format === "bold") {
    const implied = BOLD_TAGS.has(tag) || weightOf(parent?.fontWeight ?? "400") >= 600;
    return { "font-weight": !on ? "700" : ranged || implied ? "400" : null };
  }
  if (format === "italic") {
    const implied = ITALIC_TAGS.has(tag) || /italic|oblique/.test(parent?.fontStyle ?? "");
    return { "font-style": !on ? "italic" : ranged || implied ? "normal" : null };
  }
  const line = format === "underline" ? "underline" : "line-through";
  const others = decorationLines(block).filter((value) => value !== "none" && value !== line);
  if (!on) return { "text-decoration-line": [...others, line].join(" ") };
  if (others.length) return { "text-decoration-line": others.join(" ") };
  const implied = (format === "underline" ? UNDERLINE_TAGS : STRIKETHROUGH_TAGS).has(tag);
  return {
    "text-decoration": null,
    "text-decoration-line": !ranged && implied ? "none" : null,
  };
}

export function createTextEdit(context: {
  item: LayerItem;
  element: HTMLElement;
  /** The editor as it is now. */
  editor: () => CanvasEditorApi;
  /** The range or the block's styles changed: the inspector re-reads. */
  changed: () => void;
}): TextEdit {
  const { item, element } = context;
  const frameNodes = () =>
    new Map(
      (context.editor().frame(item.frameId)?.layers.nodes ?? []).map((node) => [node.id, node]),
    );
  const modelStyle = () => {
    const node = frameNodes().get(item.layerId);
    return node?.type === "element" ? (node.attributes.style ?? "") : "";
  };
  const renderContext = (): DesignRenderContext => ({
    fonts: context.editor().fonts,
    assetUrl: () => null,
  });

  // The block's styled ranges as rendered: their spans are what the edit reads back.
  const ranges: TextRangeElements = new WeakMap();
  const initial = frameNodes();
  for (const spanId of designTextRangeSpans(initial, item.layerId)) {
    const node = initial.get(spanId);
    const span = context.editor().elementFor({ ...item, layerId: spanId });
    if (span && node?.type === "element")
      ranges.set(span, { style: node.attributes.style ?? "", source: spanId });
  }
  /** The block had styled ranges when the edit began: it saves through the run diff. */
  const startedRich = designTextBlockKind(initial, item.layerId) === "rich";
  /** The edit rewrote the element, so the browser's own undo no longer matches it. */
  let managed = false;
  /** Styles the edit puts on the block itself, saved with it. */
  let block: Record<string, string | null> = {};
  /** Properties painted on the block so far, so a preview can be taken back. */
  const painted = new Set<string>();
  let saved: TextSelection | null = null;
  /** The state before a preview that was not applied yet. */
  let base: Snapshot | null = null;
  let typing: { at: number; kind: string } | null = null;
  let held = false;
  const undoStack: Snapshot[] = [];
  const redoStack: Snapshot[] = [];

  const read = () => readTextRuns(element, ranges);
  const focused = () => element.matches(":focus");
  const collapses = () => {
    const whiteSpace = getComputedStyle(element).whiteSpace;
    return whiteSpace === "normal" || whiteSpace === "nowrap";
  };
  const selectionOf = (current: ReadText) => textSelectionOf(element, current) ?? saved;
  const snapshot = (): Snapshot => {
    const current = read();
    return {
      runs: current.runs.map((run) => ({ ...run })),
      block: { ...block },
      selection: selectionOf(current),
    };
  };
  const push = (stack: Snapshot[], entry: Snapshot) => {
    stack.push(entry);
    if (stack.length > HISTORY_LIMIT) stack.shift();
  };
  const record = (entry: Snapshot) => {
    push(undoStack, entry);
    redoStack.length = 0;
  };

  const highlight = () => {
    const api = highlights();
    if (!api) return;
    if (!held || !saved || saved.start >= saved.end) {
      api.registry.delete(HIGHLIGHT_NAME);
      return;
    }
    api.registry.set(HIGHLIGHT_NAME, api.make(textDomRange(element, read(), saved)));
  };

  /** Puts `patch` (and the model's value for what it no longer sets) on the block's element. */
  const paintBlock = (patch: Readonly<Record<string, string | null>>) => {
    const declared = declaredStyles(modelStyle());
    for (const property of Object.keys(patch)) painted.add(property);
    for (const property of painted) {
      const value =
        property in patch ? (patch[property] ?? null) : (declared.get(property) ?? null);
      element.style.removeProperty(property);
      if (value === null) continue;
      for (const [name, safe, priority] of sanitizeDesignStyle(
        `${property}:${value}`,
        renderContext(),
      ))
        element.style.setProperty(name, safe, priority);
    }
  };

  const select = (selection: TextSelection | null) => {
    saved = selection;
    if (selection && focused()) selectTextRange(element, read(), selection);
    highlight();
  };

  /** Shows a state: the block's styles, and its runs when they differ from what is shown. */
  const show = (state: Snapshot) => {
    block = { ...state.block };
    paintBlock(block);
    const current = read().runs;
    const same =
      current.length === state.runs.length &&
      current.every(
        (run, index) =>
          run.text === state.runs[index]!.text &&
          sameDesignTextStyle(run.style, state.runs[index]!.style),
      );
    if (same) return;
    writeTextRuns(element, state.runs, ranges, renderContext());
    managed = true;
    select(state.selection);
  };

  /** The elements the characters of `selection` sit in: their styled range, or the block. */
  const ownersOf = (current: ReadText, selection: TextSelection): CanvasTextSegment[] => {
    const owners = new Map<HTMLElement, CanvasTextSegment>();
    for (const [node, start] of current.starts) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const end = start + (node as Text).length;
      if (start === end || end <= selection.start || start >= selection.end) continue;
      let owner: HTMLElement = element;
      let style = "";
      for (
        let parent = node.parentElement;
        parent && parent !== element;
        parent = parent.parentElement
      ) {
        const known = ranges.get(parent);
        if (known) {
          owner = parent;
          style = known.style;
          break;
        }
      }
      owners.set(owner, { element: owner, style });
    }
    return [...owners.values()];
  };

  /** A range declaration equal to what the block gives already is left off the span. */
  const againstBlock = (patch: DesignTextStylePatch): DesignTextStylePatch => {
    const computed = getComputedStyle(element);
    return Object.fromEntries(
      Object.entries(patch).map(([property, value]) => [
        property,
        value !== null &&
        INHERITED_RANGE_PROPERTIES.has(property) &&
        sameAsComputed(property, value, computed)
          ? null
          : value,
      ]),
    );
  };

  const applyPatch = (patch: DesignTextStylePatch, preview: boolean) => {
    const from = base ?? snapshot();
    if (preview) base = from;
    else {
      record(from);
      base = null;
    }
    typing = null;
    const normalized = Object.fromEntries(
      Object.entries(patch).map(([property, value]) => [designStyleKey(property), value]),
    );
    const selection = from.selection;
    const ranged =
      selection !== null &&
      selection.start < selection.end &&
      canHoldDesignTextRanges(frameNodes(), item.layerId);
    const nextBlock = { ...from.block };
    let runs = from.runs;
    if (ranged) {
      const rangePart: Record<string, string | null> = {};
      for (const [property, value] of Object.entries(normalized))
        if (isDesignTextRangeProperty(property)) rangePart[property] = value;
        else nextBlock[property] = value;
      // Decoration is drawn by the box that declares it: to style part of it, every range gets
      // the block's own decoration and the block lets it go.
      if (
        Object.keys(rangePart).some((property) => DESIGN_TEXT_DECORATION_PROPERTIES.has(property))
      ) {
        const own = declaredStyles(patchDesignTextStyle(modelStyle(), nextBlock));
        const moved = new Map(
          [...own].filter(([property]) => DESIGN_TEXT_DECORATION_PROPERTIES.has(property)),
        );
        if (moved.size > 0) {
          runs = pushDownDesignTextStyle(runs, moved);
          for (const property of moved.keys()) nextBlock[property] = null;
        }
      }
      block = nextBlock;
      paintBlock(block);
      runs = styleDesignTextRange(runs, selection.start, selection.end, againstBlock(rangePart));
    } else {
      Object.assign(nextBlock, normalized);
      block = nextBlock;
      paintBlock(block);
      // The whole block takes the value: ranges stop overriding it.
      const cleared = Object.fromEntries(
        Object.keys(normalized)
          .filter((property) => isDesignTextRangeProperty(property))
          .map((property) => [property, null]),
      );
      if (Object.keys(cleared).length > 0) runs = styleDesignTextRuns(runs, cleared);
    }
    show({ runs, block, selection });
    context.changed();
  };

  const toggle = (format: TextFormat) => {
    const current = read();
    const selection = selectionOf(current);
    const ranged =
      selection !== null &&
      selection.start < selection.end &&
      canHoldDesignTextRanges(frameNodes(), item.layerId);
    const owners = ownersOf(
      current,
      ranged ? selection : { start: 0, end: Math.max(1, current.length) },
    ).map((owner) => owner.element);
    const on = (owners.length > 0 ? owners : [element]).every((owner) =>
      isTextFormatOn(format, owner, element),
    );
    applyPatch(textFormatPatch(format, on, ranged, element), false);
  };

  const history = (direction: "undo" | "redo") => {
    if (!managed) return false;
    const from = direction === "undo" ? undoStack : redoStack;
    const to = direction === "undo" ? redoStack : undoStack;
    const entry = from.pop();
    if (!entry) return true;
    push(to, snapshot());
    base = null;
    typing = null;
    show(entry);
    select(entry.selection);
    context.changed();
    return true;
  };

  const session: CanvasTextSession = {
    item,
    element,
    segments: () => {
      const current = read();
      const selection = selectionOf(current);
      if (!selection || selection.start >= selection.end) return null;
      const owners = ownersOf(current, selection);
      return owners.length > 0 ? owners : null;
    },
    preview: (patch) => applyPatch(patch, true),
    apply: (patch) => applyPatch(patch, false),
  };

  return {
    session,
    toggle,
    history,
    beforeInput: (event) => {
      const type = event.inputType;
      // The browser never formats text: formatting is the edit's own spans.
      if (type.startsWith("format")) {
        event.preventDefault();
        const format = FORMAT_INPUTS[type];
        if (format) toggle(format);
        return;
      }
      if (type === "historyUndo" || type === "historyRedo") {
        if (history(type === "historyUndo" ? "undo" : "redo")) event.preventDefault();
        return;
      }
      if (event.isComposing || type === "insertFromPaste") return;
      const kind = type.startsWith("delete") ? "delete" : "insert";
      const now = performance.now();
      if (!typing || typing.kind !== kind || now - typing.at > TYPING_GROUP_MS) record(snapshot());
      typing = { at: now, kind };
    },
    input: () => context.changed(),
    paste: (text) => {
      const value = text.replace(/\r\n?/g, "\n");
      if (!value) return;
      const current = read();
      const selection = selectionOf(current) ?? { start: current.length, end: current.length };
      record(snapshot());
      base = null;
      typing = null;
      const caret = insertPlainText(element, ranges, selection, value, collapses());
      managed = true;
      select({ start: caret, end: caret });
      context.changed();
    },
    selectionChanged: () => {
      const live = textSelectionOf(element, read());
      if (!live || (saved && live.start === saved.start && live.end === saved.end)) return;
      saved = live;
      context.changed();
    },
    hold: () => {
      held = true;
      highlight();
    },
    release: () => {
      held = false;
      highlight();
    },
    operations: (plain) => {
      if (base) show(base);
      base = null;
      held = false;
      highlight();
      const style: Record<string, string | null> = { ...block };
      const collapsesNewlines = collapses();
      const current = read();
      if (!startedRich && current.runs.every((run) => !run.style)) {
        // No styled range before or after: plain text, saved exactly as before.
        const text = plain(element.innerText.replace(/\n$/, ""), collapsesNewlines);
        if (text?.[0]?.type === "delete" || Object.keys(style).length === 0) return text;
        return [{ type: "set_styles", nodeId: item.layerId, styles: style }, ...(text ?? [])];
      }
      const { runs, breaks } = savedTextRuns(current.runs, collapsesNewlines);
      if (normalizeDesignTextRuns(runs).every((run) => !run.text.trim()))
        return [{ type: "delete", nodeId: item.layerId }];
      if (breaks && collapsesNewlines) style["white-space"] = "pre-wrap";
      // One range over all of the text is the block's own style.
      const hoisted = hoistDesignTextRuns(runs);
      if (hoisted.style) for (const [property, value] of hoisted.style) style[property] = value;
      const edits =
        designTextEditOperations(frameNodes(), item.layerId, hoisted.runs, () =>
          canvasId("layer"),
        ) ?? [];
      const operations: DesignLayerEdit[] = [
        ...(Object.keys(style).length > 0
          ? [{ type: "set_styles" as const, nodeId: item.layerId, styles: style }]
          : []),
        ...edits,
      ];
      return operations.length > 0 ? operations : null;
    },
  };
}
