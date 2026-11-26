import type { DesignFrame, DesignLayerTree } from "@synara/contracts";
import {
  DESIGN_LAYER_ATTRIBUTE,
  DESIGN_VOID_TAGS,
  isDesignSvgLayer,
} from "@synara/shared/designCanvasLayers";
import { designTextBlockKind, designTextRangeSpans } from "@synara/shared/designCanvasText";
import { selectionKey, type CanvasSelectionItem } from "../canvasStores";
import { contains, intersects, type ScreenRect } from "./canvasMeasure";

export const FRAME_HOST_ATTRIBUTE = "data-canvas-frame-id";

/** Additive layer flags kept as ordinary data attributes, so agents and old clients keep them. */
export const LAYER_NAME_ATTRIBUTE = "data-name";
export const LAYER_HIDDEN_ATTRIBUTE = "data-hidden";
export const LAYER_LOCKED_ATTRIBUTE = "data-locked";

export type LayerItem = Extract<CanvasSelectionItem, { kind: "layer" }>;

export const isLayerItem = (item: CanvasSelectionItem): item is LayerItem => item.kind === "layer";

export type LayerIndex = {
  parent: ReadonlyMap<string, string | null>;
  nodes: ReadonlyMap<string, DesignLayerTree["nodes"][number]>;
  /** Rich text blocks: indexed as their text alone, their styled-range spans left out. */
  richText: ReadonlySet<string>;
};

/**
 * The frame's layers as the editor selects them. An inline SVG is one leaf layer (selected
 * as a unit): it is indexed without children and its inner nodes are left out, so
 * hit tests, the layers panel, marquees, drilling, Enter and Tab never reach them. A rich text
 * block follows the same rule: it is indexed with only its text, the spans' text included, and
 * its styled-range spans are left out, so it is one text layer everywhere. Copies, history,
 * exports and the text editor read the frame's full tree, so the SVG and the spans travel whole.
 */
export function indexLayers(tree: DesignLayerTree): LayerIndex {
  const all = new Map(tree.nodes.map((node) => [node.id, node]));
  const parent = new Map<string, string | null>();
  const nodes = new Map<string, DesignLayerTree["nodes"][number]>();
  const richText = new Set<string>();
  const visit = (id: string, parentId: string | null) => {
    const node = all.get(id);
    if (!node || nodes.has(id)) return;
    parent.set(id, parentId);
    if (node.type === "element" && isDesignSvgLayer(node)) {
      nodes.set(id, { ...node, children: [] });
      return;
    }
    const spans = node.type === "element" ? designTextRangeSpans(all, id) : [];
    if (node.type === "element" && spans.length > 0) {
      const texts = node.children.flatMap((child) => {
        const layer = all.get(child);
        return layer?.type === "element" ? layer.children : [child];
      });
      nodes.set(id, { ...node, children: texts });
      richText.add(id);
      for (const text of texts) visit(text, id);
      return;
    }
    nodes.set(id, node);
    if (node.type === "element") for (const child of node.children) visit(child, id);
  };
  for (const id of tree.roots) visit(id, null);
  return { parent, nodes, richText };
}

/** Element ancestors from the frame's top level down to `id` itself. */
export function layerChain(index: LayerIndex, id: string): string[] {
  const chain: string[] = [];
  for (let current: string | null = id; current; current = index.parent.get(current) ?? null)
    chain.unshift(current);
  return chain;
}

/** Whether a layer carries one of the `data-*` flags (hidden, locked) as `"true"`. */
export function layerFlag(index: LayerIndex | undefined, id: string, name: string): boolean {
  const node = index?.nodes.get(id);
  return node?.type === "element" && node.attributes[name] === "true";
}

/** A layer's parent and its siblings in paint order (the frame's roots at the top level). */
export function layerSiblings(
  index: LayerIndex,
  roots: readonly string[],
  id: string,
): { parentId: string | null; siblings: readonly string[] } {
  const parentId = index.parent.get(id) ?? null;
  const parent = parentId ? index.nodes.get(parentId) : undefined;
  return { parentId, siblings: parent?.type === "element" ? parent.children : roots };
}

/** The element children of a selection item, in paint order (a frame's top-level layers). */
export function elementChildren(
  index: LayerIndex | undefined,
  roots: readonly string[],
  item: CanvasSelectionItem,
): string[] {
  const node = item.kind === "layer" ? index?.nodes.get(item.layerId) : undefined;
  const children = item.kind === "frame" ? roots : node?.type === "element" ? node.children : [];
  return children.filter((id) => index?.nodes.get(id)?.type === "element");
}

/** `ids` without those whose ancestor is also in `ids`: what a move, copy or delete acts on. */
export function topLayers(index: LayerIndex | undefined, ids: readonly string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    for (let parent = index?.parent.get(id); parent; parent = index?.parent.get(parent))
      if (set.has(parent)) return false;
    return true;
  });
}

/**
 * A text block (`@synara/shared/designCanvasText`) can be edited in place: an element that holds
 * only text, or text with styled ranges (indexed as its text alone). An element with no children
 * at all is text only when its tag holds text.
 */
export const isTextOnly = (index: LayerIndex, id: string): boolean =>
  designTextBlockKind(index.nodes, id) !== null;

/**
 * Whether new layers can go inside this one (a paste into the selection): not text, not a void
 * element, and not an inline SVG, whose content is its own.
 */
export function holdsLayers(index: LayerIndex, id: string): boolean {
  const node = index.nodes.get(id);
  return (
    node?.type === "element" &&
    !DESIGN_VOID_TAGS.has(node.tag) &&
    !isDesignSvgLayer(node) &&
    !isTextOnly(index, id)
  );
}

/** Hit tests allow this much slack around a node, in screen pixels. */
export const HIT_TOLERANCE = 4;

/** Whether a layer or one of its ancestors is locked (locked nodes are not selectable). */
export function isLayerLocked(index: LayerIndex | undefined, id: string): boolean {
  if (!index) return false;
  for (let current: string | null = id; current; current = index.parent.get(current) ?? null)
    if (layerFlag(index, current, LAYER_LOCKED_ATTRIBUTE)) return true;
  return false;
}

/** Whether a layer sits under a locked ancestor (the layers panel's inherited-lock dot). */
export const inheritsLock = (index: LayerIndex | undefined, id: string) =>
  index !== undefined && isLayerLocked(index, index.parent.get(id) ?? "");

/** Whether a layer or one of its ancestors is hidden. */
export function isLayerHidden(index: LayerIndex | undefined, id: string): boolean {
  if (!index) return false;
  for (let current: string | null = id; current; current = index.parent.get(current) ?? null)
    if (layerFlag(index, current, LAYER_HIDDEN_ATTRIBUTE)) return true;
  return false;
}

/** Element layers of a frame in tree pre-order: parents before children, back to front. */
export function preorderLayers(index: LayerIndex, roots: readonly string[]): string[] {
  const order: string[] = [];
  const visit = (id: string) => {
    const node = index.nodes.get(id);
    if (node?.type !== "element") return;
    order.push(id);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return order;
}

/**
 * The hit stack: every layer at the point, ancestors
 * first and the deepest last. `exact` are the layers under the point itself, topmost painted
 * first; `near` are layers within the tolerance around it. A near layer counts only inside the
 * topmost exact one, so a thin line in a card is one click away while a neighbouring button a
 * few pixels off never wins over the button under the pointer. `target` is what a click acts
 * on: the deepest near layer inside the topmost one, else the topmost one.
 */
export function orderHitStack(
  index: LayerIndex,
  roots: readonly string[],
  exact: readonly string[],
  near: Iterable<string>,
): { stack: string[]; target: string | null } {
  const top = exact.find((id) => index.nodes.has(id)) ?? null;
  const inside = (id: string) => {
    if (top === null) return true;
    for (
      let parent = index.parent.get(id) ?? null;
      parent;
      parent = index.parent.get(parent) ?? null
    )
      if (parent === top) return true;
    return false;
  };
  const hits = new Set(exact);
  const nearInside = new Set<string>();
  for (const id of near)
    if (!hits.has(id) && inside(id)) {
      hits.add(id);
      nearInside.add(id);
    }
  const order = preorderLayers(index, roots).filter((id) => hits.has(id));
  const depth = (id: string) => layerChain(index, id).length;
  let target = top;
  for (const id of order)
    if (nearInside.has(id) && (target === top || depth(id) >= depth(target!))) target = id;
  if (target === null) return { stack: order, target: null };
  return { stack: [...order.filter((id) => id !== target), target], target };
}

/** The layer and frame under a pointer event, from the event's composed path. */
export function hitFromPath(path: readonly EventTarget[]): {
  frameId: string;
  layerId: string | null;
} | null {
  let layerId: string | null = null;
  for (const target of path) {
    if (!(target instanceof Element)) continue;
    if (layerId === null && target.hasAttribute(DESIGN_LAYER_ATTRIBUTE))
      layerId = target.getAttribute(DESIGN_LAYER_ATTRIBUTE);
    const frameId = target.getAttribute(FRAME_HOST_ATTRIBUTE);
    if (frameId) return { frameId, layerId };
  }
  return null;
}

/**
 * Full-bleed wrappers (an agent's `<div class="page">`) are treated like the frame itself,
 * so a first click lands on something meaningful instead of a box that covers everything. A
 * wrapper holds other layers; a full-bleed leaf (a background image) is a layer of its own.
 */
function trimWrappers(
  chain: readonly string[],
  frame: Pick<DesignFrame, "width" | "height">,
  index: LayerIndex,
  measure: (id: string) => { width: number; height: number } | null,
): string[] {
  let start = 0;
  while (start < chain.length) {
    const id = chain[start]!;
    const node = index.nodes.get(id);
    const holds =
      node?.type === "element" &&
      node.children.some((child) => index.nodes.get(child)?.type === "element");
    const size = holds ? measure(id) : null;
    if (!size || size.width < frame.width * 0.98 || size.height < frame.height * 0.98) break;
    start++;
  }
  return chain.slice(start);
}

/**
 * The click rules. Without a
 * nested selection a click picks the frame's top-level layer under the pointer (full-bleed
 * wrappers skipped). With a nested selection it picks the hit
 * layer at the selection's depth, so siblings and cousins are one click away; a click inside a
 * selected layer keeps it. Cmd/Ctrl picks the deepest layer. A frame that has layers is not
 * selected by a click on its body (null: the click starts a marquee); its label or Cmd selects
 * it, a selected frame stays selected, and an empty frame selects normally.
 */
export function resolveClickSelection(input: {
  frame: Pick<DesignFrame, "id" | "width" | "height" | "layers">;
  index: LayerIndex;
  hitLayerId: string | null;
  selection: readonly CanvasSelectionItem[];
  deep: boolean;
  measure: (id: string) => { width: number; height: number } | null;
  /** How deep a selected layer of another frame sits (0 for the top level). */
  depthOf?: (item: LayerItem) => number;
}): CanvasSelectionItem | null {
  const { frame, index, hitLayerId, selection } = input;
  const frameItem: CanvasSelectionItem = { kind: "frame", frameId: frame.id };
  const body = () =>
    input.deep ||
    !frame.layers.roots.some((id) => index.nodes.get(id)?.type === "element") ||
    selection.some((item) => item.kind === "frame" && item.frameId === frame.id)
      ? frameItem
      : null;
  if (!hitLayerId || !index.nodes.has(hitLayerId)) return body();
  const layer = (layerId: string): CanvasSelectionItem => ({
    kind: "layer",
    frameId: frame.id,
    layerId,
  });
  if (input.deep) return layer(hitLayerId);
  const chain = layerChain(index, hitLayerId);
  const layers = selection.filter(isLayerItem);
  const inside = layers.find((item) => item.frameId === frame.id && chain.includes(item.layerId));
  if (inside) return layer(inside.layerId);
  // The selection's depth: in this frame first, else in another frame (cousins across frames).
  const reference = layers.find((item) => item.frameId === frame.id) ?? layers[0];
  const depth = !reference
    ? 0
    : reference.frameId === frame.id
      ? layerChain(index, reference.layerId).length - 1
      : (input.depthOf?.(reference) ?? 0);
  if (depth > 0) return layer(chain[Math.min(depth, chain.length - 1)]!);
  const trimmed = trimWrappers(chain, frame, index, input.measure);
  // Only wrappers under the pointer: the click is on what is, in effect, the frame's body.
  return trimmed.length ? layer(trimmed[0]!) : body();
}

/**
 * The double-click drill: one level deeper toward the layer under the
 * pointer, from the selection in that frame.
 */
export function resolveDrillSelection(input: {
  frameId: string;
  index: LayerIndex;
  hitLayerId: string | null;
  current: CanvasSelectionItem | undefined;
}): CanvasSelectionItem | null {
  const { index, hitLayerId, frameId, current } = input;
  if (!hitLayerId) return null;
  const chain = layerChain(index, hitLayerId);
  if (!current || current.kind === "frame" || current.frameId !== frameId)
    return chain[0] ? { kind: "layer", frameId, layerId: chain[0] } : null;
  const at = chain.indexOf(current.layerId);
  const next = at >= 0 ? chain[at + 1] : chain[0];
  return next ? { kind: "layer", frameId, layerId: next } : null;
}

/** A double-click: the second press within this long and this close. */
export const DOUBLE_CLICK_MS = 500;
export const DOUBLE_CLICK_DISTANCE = 5;

/** Whether a press counts as the second click of a double-click. */
export const isDoubleClick = (
  previous: { time: number; x: number; y: number } | null,
  next: { time: number; x: number; y: number },
) =>
  previous !== null &&
  next.time - previous.time <= DOUBLE_CLICK_MS &&
  Math.hypot(next.x - previous.x, next.y - previous.y) <= DOUBLE_CLICK_DISTANCE;

export function parentSelection(
  index: LayerIndex | undefined,
  item: CanvasSelectionItem,
): CanvasSelectionItem | null {
  if (item.kind === "frame") return null;
  const parent = index?.parent.get(item.layerId) ?? null;
  return parent
    ? { kind: "layer", frameId: item.frameId, layerId: parent }
    : { kind: "frame", frameId: item.frameId };
}

/** Text longer than this is cut, with an ellipsis, before it becomes a layer's label. */
const LABEL_TEXT_LIMIT = 120;
/** A text cut to the label limit, an ellipsis marking that it was cut. */
const clipText = (text: string) =>
  text.length > LABEL_TEXT_LIMIT ? `${text.slice(0, LABEL_TEXT_LIMIT - 1).trimEnd()}…` : text;

/**
 * A readable layer name for the layers panel, chips and comments. A text layer is named by its
 * text; a long one is cut with an ellipsis, and the panel's rows truncate it to their width.
 */
export function layerLabel(index: LayerIndex, id: string): string {
  const node = index.nodes.get(id);
  if (!node) return "Layer";
  if (node.type === "element" && node.attributes["data-name"]?.trim())
    return node.attributes["data-name"].trim();
  if (node.type === "text") return clipText(node.text.trim()) || "Text";
  const texts = node.children.flatMap((child) => {
    const layer = index.nodes.get(child);
    return layer?.type === "text" ? [layer.text] : [];
  });
  // A rich block's runs are one text: a range can end inside a word.
  const text = index.richText.has(id)
    ? texts.join("").replace(/\s+/g, " ").trim()
    : texts
        .map((value) => value.trim())
        .join(" ")
        .trim();
  if (text && isTextOnly(index, id)) return clipText(text);
  if (node.tag === "img") return node.attributes.alt?.trim() || "Image";
  if (node.tag === "svg") {
    const name = node.attributes["aria-label"]?.trim();
    return name ? `SVG · ${name.slice(0, 32)}` : "SVG";
  }
  const hint =
    node.attributes["aria-label"] ?? node.attributes.id ?? node.attributes.class?.split(/\s+/)[0];
  const names: Record<string, string> = {
    div: "Frame",
    section: "Section",
    header: "Header",
    footer: "Footer",
    nav: "Nav",
    main: "Main",
    aside: "Aside",
    article: "Article",
    ul: "List",
    ol: "List",
    li: "Item",
    button: "Button",
    a: "Link",
    input: "Input",
    table: "Table",
    span: "Text",
    p: "Paragraph",
  };
  const base = /^h[1-6]$/.test(node.tag) ? "Heading" : (names[node.tag] ?? node.tag);
  return hint ? `${base} · ${hint.slice(0, 32)}` : base;
}

/**
 * Locked layers can't be selected on the canvas: a click lands on the nearest unlocked
 * ancestor above the outermost locked one (or on the frame).
 */
export function unlockedHitLayer(index: LayerIndex, layerId: string | null): string | null {
  if (!layerId) return null;
  let result: string | null = layerId;
  for (let id: string | null = layerId; id; id = index.parent.get(id) ?? null)
    if (layerFlag(index, id, LAYER_LOCKED_ATTRIBUTE)) result = index.parent.get(id) ?? null;
  return result;
}

/** The frame under a world point, front-most first, with the point in that frame's pixels. */
export function frameAtPoint<F extends Pick<DesignFrame, "x" | "y" | "width" | "height">>(
  frames: readonly F[],
  world: { x: number; y: number },
): { frame: F; x: number; y: number } | null {
  for (let at = frames.length - 1; at >= 0; at--) {
    const frame = frames[at]!;
    if (
      world.x >= frame.x &&
      world.y >= frame.y &&
      world.x <= frame.x + frame.width &&
      world.y <= frame.y + frame.height
    )
      return { frame, x: world.x - frame.x, y: world.y - frame.y };
  }
  return null;
}

/** Screen pixels a marquee travels before it selects anything. */
export const MARQUEE_THRESHOLD = 5;

/**
 * What a marquee selects. Without Cmd, a marquee that fully
 * contains a frame selects only the frames it touches. Otherwise fully covered frames are
 * selected, and a partly covered frame contributes the layers the box touches: its top-level
 * layers, or with Cmd the deepest ones, recursing into every container it does not fully
 * contain (a container whose children it misses is picked itself). Touching is enough; boxes
 * are what is visible after clipping (`layerRect`). Hidden and locked layers are skipped with
 * everything inside them.
 */
export function marqueeSelection(input: {
  frames: readonly Pick<DesignFrame, "id" | "layers">[];
  rect: ScreenRect;
  deep: boolean;
  frameRect: (frameId: string) => ScreenRect | null;
  /** A layer's visible box (clipped by its clipping ancestors and its frame), or null. */
  layerRect: (frameId: string, layerId: string) => ScreenRect | null;
  index: (frameId: string) => LayerIndex | undefined;
}): CanvasSelectionItem[] {
  const { rect, deep } = input;
  const touched = input.frames.flatMap((frame) => {
    const screen = input.frameRect(frame.id);
    return screen && intersects(rect, screen) ? [{ frame, screen }] : [];
  });
  if (!deep && touched.some(({ screen }) => contains(rect, screen)))
    return touched.map(({ frame }) => ({ kind: "frame", frameId: frame.id }));
  const picked: CanvasSelectionItem[] = [];
  for (const { frame, screen } of touched) {
    if (contains(rect, screen)) {
      picked.push({ kind: "frame", frameId: frame.id });
      continue;
    }
    const index = input.index(frame.id);
    if (!index) continue;
    const pick = (layerId: string) => picked.push({ kind: "layer", frameId: frame.id, layerId });
    /** Whether the layer or something inside it was picked. */
    const visit = (layerId: string): boolean => {
      const node = index.nodes.get(layerId);
      if (node?.type !== "element") return false;
      if (layerFlag(index, layerId, LAYER_LOCKED_ATTRIBUTE)) return false;
      if (layerFlag(index, layerId, LAYER_HIDDEN_ATTRIBUTE)) return false;
      const box = input.layerRect(frame.id, layerId);
      if (!box || !intersects(rect, box)) return false;
      const children = node.children.filter((id) => index.nodes.get(id)?.type === "element");
      if (!deep || contains(rect, box) || children.length === 0) {
        pick(layerId);
        return true;
      }
      let any = false;
      for (const child of children) if (visit(child)) any = true;
      if (!any) pick(layerId);
      return true;
    };
    frame.layers.roots.forEach(visit);
  }
  return picked;
}

/** Shift-marquee: what it picks toggles against the selection held before it. */
export function toggleSelection(
  prior: readonly CanvasSelectionItem[],
  picked: readonly CanvasSelectionItem[],
): CanvasSelectionItem[] {
  const pickedKeys = new Set(picked.map(selectionKey));
  const priorKeys = new Set(prior.map(selectionKey));
  return [
    ...prior.filter((item) => !pickedKeys.has(selectionKey(item))),
    ...picked.filter((item) => !priorKeys.has(selectionKey(item))),
  ];
}
