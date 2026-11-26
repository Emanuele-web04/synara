import {
  DESIGN_CANVAS_MAX_DEPTH,
  DESIGN_CANVAS_MAX_LAYERS,
  DESIGN_CANVAS_MAX_SVG_LAYERS,
  type DesignLayer,
  type DesignLayerAppliedEdit,
  type DesignLayerTree,
} from "@synara/contracts";
import {
  DESIGN_SVG_TAGS,
  DESIGN_SVG_TEXT_TAGS,
  designSvgAttributeProblem,
} from "./designCanvasSvg";

export const DESIGN_LAYER_ATTRIBUTE = "data-synara-layer-id";
export const DESIGN_HTML_TAGS = new Set(
  "div span p h1 h2 h3 h4 h5 h6 main section article header footer nav aside ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col br hr pre code blockquote strong em b i u s small sub sup mark label button input textarea select option optgroup progress meter details summary figure figcaption img a".split(
    " ",
  ),
);
export const DESIGN_VOID_TAGS = new Set(["br", "hr", "col", "img", "input"]);
const ATTRIBUTES = new Set(
  "id class style title role aria-label aria-hidden aria-labelledby aria-describedby alt width height colspan rowspan type value placeholder checked disabled selected min max step open for name".split(
    " ",
  ),
);

/**
 * Whether a layer may carry `name="value"`. SVG elements (whose names never clash with the HTML
 * tags) follow the SVG subset's per-attribute value rules.
 */
export function isDesignAttributeAllowed(tag: string, name: string, value: string): boolean {
  if (name === DESIGN_LAYER_ATTRIBUTE) return false;
  if (DESIGN_SVG_TAGS.has(tag)) return designSvgAttributeProblem(tag, name, value) === null;
  return (
    ATTRIBUTES.has(name) ||
    /^data-[a-z0-9_.:-]+$/.test(name) ||
    (tag === "img" &&
      name === "src" &&
      /^synara-asset:[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) ||
    (tag === "img" &&
      name === "src" &&
      /^data:image\/(png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=\s]+$/.test(value))
  );
}

/** Custom properties keep their case; every other property name is case-insensitive. */
export const designStyleKey = (property: string) =>
  property.startsWith("--") ? property : property.toLowerCase();

/** Declarations exactly as written (no shorthand expansion), last one wins. */
export function declaredStyles(style: string): Map<string, string> {
  const result = new Map<string, string>();
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const take = (end: number) => {
    const part = style.slice(start, end);
    const colon = part.indexOf(":");
    if (colon > 0) {
      const property = part.slice(0, colon).trim();
      const value = part.slice(colon + 1).trim();
      if (property && value) result.set(designStyleKey(property), value);
    }
    start = end + 1;
  };
  for (let index = 0; index < style.length; index++) {
    const char = style[index]!;
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth === 0) take(index);
  }
  take(style.length);
  return result;
}

/** The SVG layer a node sits in while validating: its layer count so far. */
type SvgScope = { count: number };

/**
 * A bounded, connected forest: every ID occurs once and has exactly one owner. HTML layers use
 * the HTML tags; an `svg` layer holds only the SVG subset (text only inside its `title` and
 * `desc`), at most `DESIGN_CANVAS_MAX_SVG_LAYERS` layers, and no SVG element lives outside one.
 */
export function validateDesignLayers(
  tree: DesignLayerTree,
  /** Where the forest's roots will sit (`insert_layers`): inside an SVG element, they are SVG. */
  context?: { parentTag: string },
): void {
  if (tree.nodes.length > DESIGN_CANVAS_MAX_LAYERS)
    throw new Error(
      `View exceeds its ${DESIGN_CANVAS_MAX_LAYERS.toLocaleString("en-US")}-layer limit.`,
    );
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  if (nodes.size !== tree.nodes.length) throw new Error("Duplicate layer ID.");
  const visited = new Set<string>();
  const visit = (id: string, depth: number, svg: SvgScope | null, parentTag: string | null) => {
    if (depth > DESIGN_CANVAS_MAX_DEPTH) throw new Error("Layer nesting exceeds 64 levels.");
    const node = nodes.get(id);
    if (!node || visited.has(id)) throw new Error("Invalid layer ownership or cycle.");
    visited.add(id);
    if (svg && ++svg.count > DESIGN_CANVAS_MAX_SVG_LAYERS)
      throw new Error(
        `An SVG exceeds its ${DESIGN_CANVAS_MAX_SVG_LAYERS.toLocaleString("en-US")}-layer limit.`,
      );
    if (node.type === "text") {
      if (svg && !DESIGN_SVG_TEXT_TAGS.has(parentTag ?? ""))
        throw new Error("Text inside an SVG belongs in its <title> or <desc>.");
      return;
    }
    let scope = svg;
    if (svg) {
      if (!DESIGN_SVG_TAGS.has(node.tag)) throw new Error("Unsupported SVG element.");
      if (DESIGN_SVG_TEXT_TAGS.has(parentTag ?? ""))
        throw new Error("An SVG <title> or <desc> holds only text.");
    } else if (node.tag === "svg") scope = { count: 1 };
    else if (!DESIGN_HTML_TAGS.has(node.tag))
      throw new Error(
        DESIGN_SVG_TAGS.has(node.tag)
          ? "SVG elements belong inside an <svg> layer."
          : "Unsupported layer element.",
      );
    if (DESIGN_VOID_TAGS.has(node.tag) && node.children.length > 0)
      throw new Error("This element cannot contain children.");
    for (const [name, value] of Object.entries(node.attributes))
      if (!isDesignAttributeAllowed(node.tag, name, value))
        throw new Error(
          scope
            ? `Unsupported SVG attribute ${name} on <${node.tag}>: ${designSvgAttributeProblem(node.tag, name, value) ?? "refused"}.`
            : `Unsupported layer attribute: ${name}`,
        );
    for (const child of node.children) visit(child, depth + 1, scope, node.tag);
  };
  const parentTag = context?.parentTag ?? null;
  const inSvg = parentTag !== null && DESIGN_SVG_TAGS.has(parentTag);
  for (const root of tree.roots) visit(root, 0, inSvg ? { count: 0 } : null, parentTag);
  if (visited.size !== nodes.size) throw new Error("Canvas contains orphan layers.");
}

/** Whether a layer is an inline SVG: one leaf on the canvas, its inner nodes not selectable. */
export const isDesignSvgLayer = (node: DesignLayer | undefined): boolean =>
  node?.type === "element" && node.tag === "svg";

/** The subtree rooted at `id`, as a standalone forest with the same IDs (empty when absent). */
export function designLayerSubtree(tree: DesignLayerTree, id: string): DesignLayerTree {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const collected: DesignLayer[] = [];
  const seen = new Set<string>();
  const visit = (nodeId: string) => {
    const node = nodes.get(nodeId);
    if (!node || seen.has(nodeId)) return;
    seen.add(nodeId);
    collected.push(node);
    if (node.type === "element") node.children.forEach(visit);
  };
  visit(id);
  return { roots: collected.length > 0 ? [id] : [], nodes: collected };
}

type MutableLayer =
  | {
      id: string;
      type: "element";
      tag: string;
      attributes: Record<string, string>;
      children: string[];
    }
  | { id: string; type: "text"; text: string };

function insertChildren(children: string[], ids: readonly string[], beforeId: string | undefined) {
  const index = beforeId === undefined ? children.length : children.indexOf(beforeId);
  if (index < 0) throw new Error("beforeId must identify a child of the destination parent.");
  children.splice(index, 0, ...ids);
}

/**
 * Replays edits the server already applied and validated (see `DesignLayerAppliedEdit`) and
 * returns the same tree the server stored, down to node and attribute order. Layers the edits
 * do not touch keep their object identity, so renderers can skip them.
 */
export function applyDesignLayerEdits(
  tree: DesignLayerTree,
  operations: readonly DesignLayerAppliedEdit[],
): DesignLayerTree {
  if (operations.length === 0) return tree;
  const nodes = new Map<string, DesignLayer>(tree.nodes.map((node) => [node.id, node]));
  const copied = new Set<DesignLayer>();
  let roots: string[] | null = null;
  // The server appends created layers in creation order and drops deleted ones in place.
  const removed = new Set<string>();
  let created: string[] = [];
  const writable = (id: string): MutableLayer => {
    const node = nodes.get(id);
    if (!node) throw new Error(`Layer not found: ${id}.`);
    if (copied.has(node)) return node as MutableLayer;
    const copy: MutableLayer =
      node.type === "element"
        ? { ...node, attributes: { ...node.attributes }, children: [...node.children] }
        : { ...node };
    copied.add(copy);
    nodes.set(id, copy);
    return copy;
  };
  const childrenOf = (parentId: string | null): string[] => {
    if (parentId === null) return (roots ??= [...tree.roots]);
    const parent = writable(parentId);
    if (parent.type !== "element") throw new Error("This operation requires an element layer.");
    return parent.children;
  };
  const detach = (id: string) => {
    for (const node of nodes.values())
      if (node.type === "element" && node.children.includes(id)) {
        const siblings = childrenOf(node.id);
        siblings.splice(siblings.indexOf(id), 1);
        return;
      }
    const siblings = childrenOf(null);
    const index = siblings.indexOf(id);
    if (index < 0) throw new Error("Layer has no parent.");
    siblings.splice(index, 1);
  };
  for (const operation of operations) {
    switch (operation.type) {
      case "set_text": {
        const node = writable(operation.nodeId);
        if (node.type !== "text") throw new Error("set_text requires a text layer.");
        node.text = operation.text;
        break;
      }
      case "set_attributes": {
        const node = writable(operation.nodeId);
        if (node.type !== "element") throw new Error("This operation requires an element layer.");
        for (const [key, value] of Object.entries(operation.attributes)) {
          if (value === null) delete node.attributes[key];
          else node.attributes[key] = value;
        }
        break;
      }
      case "insert_layers": {
        insertChildren(childrenOf(operation.parentId), operation.layers.roots, operation.beforeId);
        for (const node of operation.layers.nodes) {
          nodes.set(node.id, node);
          created.push(node.id);
        }
        break;
      }
      case "move": {
        detach(operation.nodeId);
        insertChildren(childrenOf(operation.parentId), [operation.nodeId], operation.beforeId);
        break;
      }
      case "delete": {
        detach(operation.nodeId);
        const remove = (id: string) => {
          const node = nodes.get(id);
          if (!node) return;
          if (node.type === "element") node.children.forEach(remove);
          nodes.delete(id);
          removed.add(id);
        };
        remove(operation.nodeId);
        created = created.filter((id) => nodes.has(id));
        break;
      }
    }
  }
  const existing = tree.nodes.flatMap((node) => {
    const current = removed.has(node.id) ? undefined : nodes.get(node.id);
    return current ? [current] : [];
  });
  const kept = new Set(existing.map((node) => node.id));
  return {
    roots: roots ?? tree.roots,
    nodes: [
      ...existing,
      ...created.flatMap((id) => {
        const node = nodes.get(id);
        return node && !kept.has(id) ? [node] : [];
      }),
    ],
  };
}

const escapeText = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttribute = (value: string) => escapeText(value).replaceAll('"', "&quot;");

/** Rendering and exported HTML are projections of the persisted layer model. */
export function serializeDesignLayers(tree: DesignLayerTree, includeIds = true): string {
  validateDesignLayers(tree);
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const render = (id: string): string => {
    const node = nodes.get(id)!;
    if (node.type === "text") return escapeText(node.text);
    const attributes = Object.entries(node.attributes)
      .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
      .join("");
    const identity = includeIds ? ` ${DESIGN_LAYER_ATTRIBUTE}="${escapeAttribute(node.id)}"` : "";
    const open = `<${node.tag}${attributes}${identity}>`;
    if (DESIGN_VOID_TAGS.has(node.tag)) return open;
    // HTML strips the first newline in these elements; double it to preserve the model text.
    const children = node.children.map((child) => render(child)).join("");
    const prefix = ["pre", "textarea"].includes(node.tag) && children.startsWith("\n") ? "\n" : "";
    return `${open}${prefix}${children}</${node.tag}>`;
  };
  return tree.roots.map((id) => render(id)).join("");
}
