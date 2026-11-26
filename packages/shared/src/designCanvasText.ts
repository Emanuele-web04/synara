// FILE: designCanvasText.ts
// Purpose: Rich text in the canvas layer model. A text block is an element that holds text
//          layers and, for styled ranges, plain `span` layers that hold only text and only
//          typography declarations. A styled range is therefore an ordinary inline element layer
//          with its own stable ID: no new node type, so stored works and agents' HTML need nothing
//          new. The editor, the agent reads, the code export and the store share these rules, so
//          they agree on what one block of text is and how an edit to it is written.
// Layer: Shared canvas model (pure, no DOM)
// Exports: DESIGN_TEXT_TAGS, DESIGN_TEXT_RANGE_PROPERTIES, designTextBlockKind,
//          isDesignTextRangeSpan, designTextRuns, normalizeDesignTextRuns, styleDesignTextRange,
//          designTextEditOperations and the style helpers they use

import type { DesignLayer, DesignLayerAppliedEdit } from "@synara/contracts";
import { DESIGN_VOID_TAGS, declaredStyles, designStyleKey } from "./designCanvasLayers";

type Nodes = ReadonlyMap<string, DesignLayer>;
type ElementLayer = Extract<DesignLayer, { type: "element" }>;
export type DesignTextStylePatch = Readonly<Record<string, string | null>>;

/**
 * Elements that hold text even when empty; an empty `div` is a box, not a text layer. Only tags
 * a layer can have (`DESIGN_HTML_TAGS`): the importer stores `abbr`, `cite`, `q`, `time` and
 * other phrasing tags as `span`, and `legend` as `div`.
 */
export const DESIGN_TEXT_TAGS: ReadonlySet<string> = new Set(
  "a b blockquote button caption code dd dt em figcaption h1 h2 h3 h4 h5 h6 i label li mark p pre small span strong sub sup td th".split(
    " ",
  ),
);
/** Elements that never hold editable text, whatever their children. */
const NOT_TEXT_TAGS = new Set(["img", "input", "br", "hr", "select", "textarea", "svg"]);
/** Text blocks whose content the HTML parser keeps as text only: no styled ranges inside. */
const PLAIN_ONLY_TAGS = new Set(["option", "optgroup"]);

/**
 * What a styled range may declare: font, size, weight, colour, letter spacing, line height,
 * case, decoration and text stroke, and no backgrounds; anything else belongs to the block.
 */
export const DESIGN_TEXT_RANGE_PROPERTIES: ReadonlySet<string> = new Set([
  "color",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "line-height",
  "text-transform",
  "text-decoration",
  "text-decoration-line",
  "text-decoration-style",
  "text-decoration-color",
  "text-decoration-thickness",
  "text-decoration-skip-ink",
  "text-underline-offset",
  "text-underline-position",
  "-webkit-text-stroke",
  "-webkit-text-stroke-width",
  "-webkit-text-stroke-color",
  "paint-order",
]);

/** Decoration is drawn by the box that declares it, so a span cannot take it away. */
export const DESIGN_TEXT_DECORATION_PROPERTIES: ReadonlySet<string> = new Set([
  "text-decoration",
  "text-decoration-line",
  "text-decoration-style",
  "text-decoration-color",
  "text-decoration-thickness",
  "text-decoration-skip-ink",
  "text-underline-offset",
  "text-underline-position",
]);

export const isDesignTextRangeProperty = (property: string) =>
  DESIGN_TEXT_RANGE_PROPERTIES.has(designStyleKey(property));

/** Whether an inline style declares only what a styled range may carry. */
export function isDesignTextRangeStyle(style: string | undefined): boolean {
  for (const property of declaredStyles(style ?? "").keys())
    if (!DESIGN_TEXT_RANGE_PROPERTIES.has(property)) return false;
  return true;
}

const textOf = (nodes: Nodes, node: ElementLayer) =>
  node.children
    .map((id) => {
      const child = nodes.get(id);
      return child?.type === "text" ? child.text : "";
    })
    .join("");

/**
 * A styled range: a `span` with no attribute but its style, only range declarations, and only
 * text inside. Any other span (a class, a layer name, padding, a nested element) is a layer of
 * its own, as before.
 */
export function isDesignTextRangeSpan(nodes: Nodes, id: string): boolean {
  const node = nodes.get(id);
  return (
    node?.type === "element" &&
    node.tag === "span" &&
    Object.keys(node.attributes).every((name) => name === "style") &&
    isDesignTextRangeStyle(node.attributes.style) &&
    node.children.every((child) => nodes.get(child)?.type === "text")
  );
}

/**
 * The one predicate for text blocks. "plain": an element that holds only text (or nothing, when
 * its tag holds text): edited in place as before. "rich": text with styled ranges, edited in
 * place as one block; its spans are not layers on the canvas or in the layers panel. A range
 * is part of a text: the block also holds text of its own or another range. A span holding all
 * of the text (a button's label) is a layer of its own, so that block is null, like
 * anything else that keeps its children as layers. A flex or grid container is never rich:
 * there each span is a box of its own.
 */
export function designTextBlockKind(nodes: Nodes, id: string): "plain" | "rich" | null {
  const node = nodes.get(id);
  if (node?.type !== "element" || NOT_TEXT_TAGS.has(node.tag) || DESIGN_VOID_TAGS.has(node.tag))
    return null;
  if (node.children.length === 0) return DESIGN_TEXT_TAGS.has(node.tag) ? "plain" : null;
  let ranges = 0;
  let parts = 0;
  for (const child of node.children) {
    const layer = nodes.get(child);
    if (layer?.type === "text") {
      if (layer.text.trim()) parts++;
      continue;
    }
    if (layer?.type !== "element" || !isDesignTextRangeSpan(nodes, child)) return null;
    ranges++;
    if (textOf(nodes, layer).trim()) parts++;
  }
  if (ranges === 0) return "plain";
  if (parts < 2 || PLAIN_ONLY_TAGS.has(node.tag)) return null;
  const display = declaredStyles(node.attributes.style ?? "").get("display") ?? "";
  return /\b(?:flex|grid)\b/i.test(display) ? null : "rich";
}

export const isDesignTextBlock = (nodes: Nodes, id: string) =>
  designTextBlockKind(nodes, id) !== null;

/** Whether styled ranges may be written into this text block (the parser keeps them). */
export function canHoldDesignTextRanges(nodes: Nodes, id: string): boolean {
  const node = nodes.get(id);
  if (node?.type !== "element" || PLAIN_ONLY_TAGS.has(node.tag)) return false;
  const display = declaredStyles(node.attributes.style ?? "").get("display") ?? "";
  return !/\b(?:flex|grid)\b/i.test(display);
}

/** The range spans of a rich text block, in order (none for any other layer). */
export function designTextRangeSpans(nodes: Nodes, id: string): string[] {
  const node = nodes.get(id);
  if (node?.type !== "element" || designTextBlockKind(nodes, id) !== "rich") return [];
  return node.children.filter((child) => nodes.get(child)?.type === "element");
}

/** One run of a text block: characters that share one style. */
export type DesignTextRun = {
  text: string;
  /** Range declarations; empty for text with the block's own style. */
  style: string;
  /** The span layer these characters came from, so an edit can keep its ID. */
  source?: string;
};

/** A text block as runs: its own text unstyled, each span's text with the span's style. */
export function designTextRuns(nodes: Nodes, id: string): DesignTextRun[] {
  const node = nodes.get(id);
  if (node?.type !== "element") return [];
  return node.children.flatMap((childId): DesignTextRun[] => {
    const child = nodes.get(childId);
    if (child?.type === "text") return [{ text: child.text, style: "" }];
    if (child?.type !== "element") return [];
    return [{ text: textOf(nodes, child), style: child.attributes.style ?? "", source: child.id }];
  });
}

/** Every character of a text block, its spans' text included. */
export const designTextBlockText = (nodes: Nodes, id: string) =>
  designTextRuns(nodes, id)
    .map((run) => run.text)
    .join("");

const serialize = (declarations: ReadonlyMap<string, string>) =>
  [...declarations].map(([property, value]) => `${property}:${value}`).join(";");

/** Whether two inline styles declare the same values, in any order. */
export function sameDesignTextStyle(a: string, b: string): boolean {
  if (a === b) return true;
  const left = declaredStyles(a);
  const right = declaredStyles(b);
  if (left.size !== right.size) return false;
  for (const [property, value] of left) if (right.get(property) !== value) return false;
  return true;
}

/**
 * `style` with `patch` applied: null removes a declaration, and a declaration that is set moves
 * last, so it wins over a shorthand declared before it.
 */
export function patchDesignTextStyle(style: string, patch: DesignTextStylePatch): string {
  const declarations = declaredStyles(style);
  for (const [property, value] of Object.entries(patch)) {
    const key = designStyleKey(property);
    declarations.delete(key);
    if (value !== null && value.trim()) declarations.set(key, value.trim());
  }
  return serialize(declarations);
}

/** A nested range read back as one: the inner declarations win over the outer ones. */
export const overlayDesignTextStyle = (outer: string, inner: string) =>
  patchDesignTextStyle(outer, Object.fromEntries(declaredStyles(inner)));

/** Only what a styled range may declare. */
function rangeStyle(style: string): string {
  const declarations = declaredStyles(style);
  for (const property of declarations.keys())
    if (!DESIGN_TEXT_RANGE_PROPERTIES.has(property)) declarations.delete(property);
  return serialize(declarations);
}

/**
 * The normal form a commit writes: empty runs dropped, declarations a range may not carry left
 * out, runs without declarations unstyled (their span unwrapped), and neighbours with the same
 * style merged into one, which keeps the first span it came from. Runs are flat by type, so
 * spans never nest. Idempotent.
 */
export function normalizeDesignTextRuns(runs: readonly DesignTextRun[]): DesignTextRun[] {
  const result: DesignTextRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const style = isDesignTextRangeStyle(run.style) ? run.style : rangeStyle(run.style);
    const own = declaredStyles(style).size > 0 ? style : "";
    const last = result.at(-1);
    if (last && sameDesignTextStyle(last.style, own)) {
      last.text += run.text;
      if (last.source === undefined && own && run.source !== undefined) last.source = run.source;
      continue;
    }
    result.push({
      text: run.text,
      style: own,
      ...(own && run.source !== undefined ? { source: run.source } : {}),
    });
  }
  return result;
}

/**
 * Applies `patch` to the characters `[start, end)`: runs are split at both ends and every piece
 * keeps the span it came from. Properties a range may not declare are ignored.
 */
export function styleDesignTextRange(
  runs: readonly DesignTextRun[],
  start: number,
  end: number,
  patch: DesignTextStylePatch,
): DesignTextRun[] {
  const applied = Object.fromEntries(
    Object.entries(patch).filter(([property]) => isDesignTextRangeProperty(property)),
  );
  const result: DesignTextRun[] = [];
  let offset = 0;
  for (const run of runs) {
    const from = Math.max(0, start - offset);
    const to = Math.min(run.text.length, end - offset);
    offset += run.text.length;
    if (from >= to) {
      result.push(run);
      continue;
    }
    const piece = (text: string, style: string) => {
      if (text)
        result.push({ text, style, ...(run.source !== undefined ? { source: run.source } : {}) });
    };
    piece(run.text.slice(0, from), run.style);
    piece(run.text.slice(from, to), patchDesignTextStyle(run.style, applied));
    piece(run.text.slice(to), run.style);
  }
  return normalizeDesignTextRuns(result);
}

/** Every run restyled with `patch` (the whole block), e.g. to clear range overrides. */
export const styleDesignTextRuns = (runs: readonly DesignTextRun[], patch: DesignTextStylePatch) =>
  styleDesignTextRange(runs, 0, Number.MAX_SAFE_INTEGER, patch);

/**
 * A range over all of a block's text is the block's own style (else the span would read as a
 * layer of its own): it comes back as `style` for the block, with the text unstyled.
 */
export function hoistDesignTextRuns(runs: readonly DesignTextRun[]): {
  runs: DesignTextRun[];
  style: ReadonlyMap<string, string> | null;
} {
  const normal = normalizeDesignTextRuns(runs);
  const only = normal.length === 1 ? normal[0]! : null;
  if (!only?.style) return { runs: normal, style: null };
  return { runs: [{ text: only.text, style: "" }], style: declaredStyles(only.style) };
}

/** Adds `declarations` to every run that does not declare them itself (moving them off the block). */
export function pushDownDesignTextStyle(
  runs: readonly DesignTextRun[],
  declarations: ReadonlyMap<string, string>,
): DesignTextRun[] {
  return normalizeDesignTextRuns(
    runs.map((run) => {
      const own = declaredStyles(run.style);
      const added = new Map([...declarations].filter(([property]) => !own.has(property)));
      return added.size === 0 ? run : { ...run, style: serialize(new Map([...added, ...own])) };
    }),
  );
}

const sameRuns = (a: readonly DesignTextRun[], b: readonly DesignTextRun[]) =>
  a.length === b.length &&
  a.every(
    (run, index) => run.text === b[index]!.text && sameDesignTextStyle(run.style, b[index]!.style),
  );

/**
 * The layer edit that turns a text block's children into `runs`, written with the operations
 * every client already replays: deletes (in document order, so an undo puts each back before
 * its old neighbour), set_attributes and set_text on what is kept, and insert_layers with IDs
 * from `newId` for new spans and text. Kept layers never move: a span keeps its ID for the first
 * styled run that came from it, in order, and unstyled runs reuse the block's own text layers
 * between them, so ranges an edit does not touch keep their identity. Null when the runs already
 * match the block (also when only the spans' grouping differs).
 */
export function designTextEditOperations(
  nodes: Nodes,
  containerId: string,
  runs: readonly DesignTextRun[],
  newId: () => string,
): DesignLayerAppliedEdit[] | null {
  const container = nodes.get(containerId);
  if (container?.type !== "element") return null;
  const desired = normalizeDesignTextRuns(runs);
  if (sameRuns(desired, normalizeDesignTextRuns(designTextRuns(nodes, containerId)))) return null;
  const children = container.children;
  const position = new Map(children.map((id, index) => [id, index]));
  const kept: (string | null)[] = desired.map(() => null);
  let last = -1;
  desired.forEach((run, index) => {
    const at = run.source === undefined ? undefined : position.get(run.source);
    if (!run.style || at === undefined || at <= last || !isDesignTextRangeSpan(nodes, run.source!))
      return;
    kept[index] = run.source!;
    last = at;
  });
  let lower = -1;
  desired.forEach((run, index) => {
    const own = kept[index];
    if (own) {
      lower = position.get(own)!;
      return;
    }
    if (run.style) return;
    let upper = children.length;
    for (let next = index + 1; next < desired.length; next++) {
      const id = kept[next];
      if (id && nodes.get(id)?.type === "element") {
        upper = position.get(id)!;
        break;
      }
    }
    const reuse = children.findIndex(
      (id, at) => at > lower && at < upper && nodes.get(id)?.type === "text",
    );
    if (reuse >= 0) {
      kept[index] = children[reuse]!;
      lower = reuse;
    }
  });
  const operations: DesignLayerAppliedEdit[] = [];
  const keptIds = new Set(kept.filter((id): id is string => id !== null));
  for (const id of children) if (!keptIds.has(id)) operations.push({ type: "delete", nodeId: id });
  desired.forEach((run, index) => {
    const id = kept[index];
    const node = id ? nodes.get(id) : undefined;
    if (!node) return;
    if (node.type === "text") {
      if (node.text !== run.text)
        operations.push({ type: "set_text", nodeId: node.id, text: run.text });
      return;
    }
    if (!sameDesignTextStyle(node.attributes.style ?? "", run.style))
      operations.push({
        type: "set_attributes",
        nodeId: node.id,
        attributes: { style: run.style },
      });
    const [first, ...others] = node.children;
    for (const other of others) operations.push({ type: "delete", nodeId: other });
    const firstNode = first === undefined ? undefined : nodes.get(first);
    if (firstNode?.type === "text") {
      if (firstNode.text !== run.text)
        operations.push({ type: "set_text", nodeId: firstNode.id, text: run.text });
    } else {
      const textId = newId();
      operations.push({
        type: "insert_layers",
        parentId: node.id,
        layers: { roots: [textId], nodes: [{ id: textId, type: "text", text: run.text }] },
      });
    }
  });
  let pending: { roots: string[]; nodes: DesignLayer[] } | null = null;
  const flush = (beforeId?: string) => {
    if (!pending) return;
    operations.push({
      type: "insert_layers",
      parentId: containerId,
      ...(beforeId === undefined ? {} : { beforeId }),
      layers: pending,
    });
    pending = null;
  };
  desired.forEach((run, index) => {
    const id = kept[index];
    if (id) {
      flush(id);
      return;
    }
    pending ??= { roots: [], nodes: [] };
    const textId = newId();
    if (!run.style) {
      pending.roots.push(textId);
      pending.nodes.push({ id: textId, type: "text", text: run.text });
      return;
    }
    const spanId = newId();
    pending.roots.push(spanId);
    pending.nodes.push(
      {
        id: spanId,
        type: "element",
        tag: "span",
        attributes: { style: run.style },
        children: [textId],
      },
      { id: textId, type: "text", text: run.text },
    );
  });
  flush();
  return operations;
}
