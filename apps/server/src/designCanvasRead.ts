// FILE: designCanvasRead.ts
// Purpose: Cheap agent reads of a frame's layer forest: a compact indented tree and a
//          bounded search by text, layer name or tag.
// Layer: Canvas server, pure (no I/O); sizes come from an open window when it measured them.
// Exports: planDesignLayerTree, formatDesignLayerTree, findDesignLayers

import type { DesignFrame, DesignLayer } from "@synara/contracts";
import {
  designTextBlockKind,
  designTextBlockText,
  designTextRangeSpans,
} from "@synara/shared/designCanvasText";

type ElementLayer = Extract<DesignLayer, { type: "element" }>;
type TextLayer = Extract<DesignLayer, { type: "text" }>;
type Size = { width: number; height: number };

const PREVIEW_CHARS = 48;
export const DESIGN_TREE_DEFAULT_DEPTH = 6;
export const DESIGN_TREE_MAX_DEPTH = 20;
export const DESIGN_TREE_MAX_LINES = 400;

/** One line of design text: whitespace collapsed, quoted and escaped, never a line break. */
const preview = (text: string, length = PREVIEW_CHARS) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(flat.length > length ? `${flat.slice(0, length - 1)}…` : flat);
};
const nameOf = (node: ElementLayer) => node.attributes["data-name"]?.trim() || null;
const isBlank = (node: DesignLayer | undefined) => node?.type === "text" && !node.text.trim();

function indexFrame(frame: Pick<DesignFrame, "layers">) {
  const nodes = new Map(frame.layers.nodes.map((node) => [node.id, node]));
  const parents = new Map<string, string>();
  for (const node of frame.layers.nodes)
    if (node.type === "element") for (const child of node.children) parents.set(child, node.id);
  return { nodes, parents };
}

/** The children a reader cares about: everything but whitespace between elements. */
function visibleChildren(node: ElementLayer, nodes: ReadonlyMap<string, DesignLayer>) {
  return node.children.flatMap((id) => {
    const child = nodes.get(id);
    return child && !isBlank(child) ? [child] : [];
  });
}

type TreeLine =
  | {
      kind: "element";
      level: number;
      node: ElementLayer;
      /** The element's only content is this text layer: shown on the element's line. */
      text: TextLayer | null;
      /** Children beyond the depth limit. */
      hidden: number;
      /** An inline SVG shown as one line: the layers inside it (read it by layerId to list them). */
      svgLayers?: number;
      /** A rich text block shown as one line: its text and how many styled spans it holds. */
      richText?: { text: string; spans: number };
    }
  | { kind: "text"; level: number; node: TextLayer };

export type DesignLayerTreePlan = {
  frame: Pick<DesignFrame, "id" | "title" | "width" | "height" | "revision" | "style" | "layers">;
  rootLayerId: string | null;
  parentId: string | null;
  depth: number;
  lines: TreeLine[];
  /** Layers below the start that the line limit left out. */
  omitted: number;
  /** Element layers on the lines, which an open window can measure. */
  elementIds: string[];
};

/**
 * The lines a tree read shows: from the frame's roots (or one layer) down `depth` levels,
 * at most `maxLines`. Throws when `layerId` is not in the frame.
 */
export function planDesignLayerTree(
  frame: DesignLayerTreePlan["frame"],
  options: { layerId?: string | undefined; depth?: number | undefined; maxLines?: number } = {},
): DesignLayerTreePlan {
  const { nodes, parents } = indexFrame(frame);
  const depth = Math.min(
    DESIGN_TREE_MAX_DEPTH,
    Math.max(1, options.depth ?? DESIGN_TREE_DEFAULT_DEPTH),
  );
  const maxLines = options.maxLines ?? DESIGN_TREE_MAX_LINES;
  const rootLayerId = options.layerId ?? null;
  if (rootLayerId !== null && !nodes.has(rootLayerId))
    throw new Error(`Layer not found: ${rootLayerId}. Read the frame's tree for current IDs.`);
  const lines: TreeLine[] = [];
  let omitted = 0;
  const count = (id: string): number => {
    const node = nodes.get(id);
    if (!node || isBlank(node)) return 0;
    return node.type === "text" ? 1 : 1 + node.children.reduce((sum, c) => sum + count(c), 0);
  };
  const visit = (id: string, level: number) => {
    const node = nodes.get(id);
    if (!node || isBlank(node)) return;
    if (lines.length >= maxLines) {
      omitted += count(id);
      return;
    }
    if (node.type === "text") {
      lines.push({ kind: "text", level, node });
      return;
    }
    // An inline SVG is one layer, as on the canvas; reading it by layerId lists its inside.
    if (node.tag === "svg" && id !== rootLayerId) {
      lines.push({
        kind: "element",
        level,
        node,
        text: null,
        hidden: 0,
        svgLayers: count(id) - 1,
      });
      return;
    }
    // A text block with styled spans is one text layer, as on the canvas; reading it by
    // layerId lists its spans and their text layers.
    const spans = id === rootLayerId ? [] : designTextRangeSpans(nodes, id);
    if (spans.length > 0) {
      lines.push({
        kind: "element",
        level,
        node,
        text: null,
        hidden: 0,
        richText: { text: designTextBlockText(nodes, id), spans: spans.length },
      });
      return;
    }
    const children = visibleChildren(node, nodes);
    const only = children.length === 1 && children[0]!.type === "text" ? children[0]! : null;
    const expand = level < depth && !only;
    lines.push({
      kind: "element",
      level,
      node,
      text: only as TextLayer | null,
      hidden: expand || only ? 0 : children.length,
    });
    if (expand) for (const child of children) visit(child.id, level + 1);
  };
  for (const id of rootLayerId === null ? frame.layers.roots : [rootLayerId]) visit(id, 1);
  return {
    frame,
    rootLayerId,
    parentId: rootLayerId === null ? null : (parents.get(rootLayerId) ?? null),
    depth,
    lines,
    omitted,
    elementIds: lines.flatMap((line) => (line.kind === "element" ? [line.node.id] : [])),
  };
}

const sizeText = (size: Size | undefined) =>
  size ? `${Math.round(size.width)}×${Math.round(size.height)}` : "?";

/**
 * The compact tree: tag, layer name, layer ID, measured size (`?` when no window measured
 * it), a short text preview with the text layer ID that set_text targets, and a child count
 * where the depth limit stopped. Text and names are quoted design content.
 */
export function formatDesignLayerTree(
  plan: DesignLayerTreePlan,
  sizes: ReadonlyMap<string, Size> | null,
): string {
  const { frame } = plan;
  const total = frame.layers.nodes.filter((node) => !isBlank(node)).length;
  const header = [
    `${plan.rootLayerId === null ? "Frame" : `Layer ${plan.rootLayerId} (parent ${plan.parentId ?? "frame root"}) in frame`} ${frame.id} ${preview(frame.title, 80)} ${frame.width}×${frame.height}, revision ${frame.revision}, ${total} layers, depth ${plan.depth}.`,
    sizes
      ? "Sizes are W×H in frame pixels, measured by an open Synara window."
      : "Sizes show ? because no open Synara window measured this frame.",
  ];
  if (plan.rootLayerId === null && frame.style)
    header.push(
      `Frame style: ${frame.style.length > 400 ? `${frame.style.slice(0, 399)}…` : frame.style}`,
    );
  const body = plan.lines.map((line) => {
    const indent = "  ".repeat(line.level - 1);
    if (line.kind === "text") return `${indent}text ${line.node.id} ${preview(line.node.text)}`;
    const { node } = line;
    const name = nameOf(node);
    const flags = [
      node.attributes["data-hidden"] === "true" ? " hidden" : "",
      node.attributes["data-locked"] === "true" ? " locked" : "",
    ].join("");
    const text = line.text
      ? ` text ${line.text.id} ${preview(line.text.text)}`
      : line.richText
        ? ` rich text ${preview(line.richText.text)} (${line.richText.spans} styled span${line.richText.spans === 1 ? "" : "s"})`
        : "";
    const more =
      line.svgLayers !== undefined
        ? ` inline SVG${node.attributes.viewBox ? ` viewBox ${preview(node.attributes.viewBox, 40)}` : ""}, ${line.svgLayers} layers inside`
        : line.hidden > 0
          ? ` +${line.hidden} children`
          : "";
    return `${indent}${node.tag}${name ? ` ${preview(name, 40)}` : ""} ${node.id} ${sizeText(sizes?.get(node.id))}${flags}${text}${more}`;
  });
  if (plan.lines.length === 0) body.push("(no layers)");
  if (plan.omitted > 0)
    body.push(
      `… ${plan.omitted} more layers not shown. Read one subtree with layerId, or a smaller depth.`,
    );
  return [...header, ...body].join("\n");
}

export type DesignLayerQuery = {
  text?: string | undefined;
  name?: string | undefined;
  tag?: string | undefined;
};

/** Case-insensitive; with `*` the pattern is anchored to the whole value, else a substring. */
function matcher(pattern: string): (value: string) => boolean {
  const needle = pattern.trim().toLocaleLowerCase();
  if (!needle.includes("*")) return (value) => value.toLocaleLowerCase().includes(needle);
  const source = needle
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const expression = new RegExp(`^${source}$`, "su");
  return (value) => expression.test(value.toLocaleLowerCase().trim());
}

export type DesignLayerMatch = {
  frameId: string;
  layerId: string;
  tag: string;
  name?: string;
  /**
   * The layer set_text edits: the text layer an element holds directly, or a rich text block's
   * own ID (set_text there makes the whole block plain text).
   */
  textLayerId?: string;
  text?: string;
  /** A rich text block: the styled spans it holds. */
  styledSpans?: number;
  /** Ancestors from the frame root, nearest last. */
  path: string;
};

/**
 * Element layers whose tag, layer name (`data-name`) and directly held text match every
 * given criterion, in document order. `scope` limits the search to one frame or subtree.
 */
export function findDesignLayers(
  frames: readonly Pick<DesignFrame, "id" | "layers">[],
  query: DesignLayerQuery,
  options: { frameId?: string | undefined; layerId?: string | undefined; limit: number },
): { total: number; matches: DesignLayerMatch[] } {
  const tag = query.tag?.trim().toLowerCase();
  const text = query.text ? matcher(query.text) : null;
  const name = query.name ? matcher(query.name) : null;
  const matches: DesignLayerMatch[] = [];
  let total = 0;
  for (const frame of frames) {
    if (options.frameId !== undefined && frame.id !== options.frameId) continue;
    const { nodes, parents } = indexFrame(frame);
    if (options.layerId !== undefined && !nodes.has(options.layerId))
      throw new Error(`Layer not found: ${options.layerId}.`);
    const pathOf = (id: string) => {
      const steps: string[] = [];
      for (let parent = parents.get(id); parent; parent = parents.get(parent)) {
        const node = nodes.get(parent);
        if (node?.type !== "element") break;
        const label = nameOf(node);
        steps.unshift(label ? `${node.tag} ${preview(label, 24)}` : node.tag);
      }
      return steps.length > 4 ? `… > ${steps.slice(-4).join(" > ")}` : steps.join(" > ");
    };
    const visit = (id: string) => {
      const node = nodes.get(id);
      if (node?.type !== "element") return;
      const texts = node.children.flatMap((child) => {
        const layer = nodes.get(child);
        return layer?.type === "text" && layer.text.trim() ? [layer] : [];
      });
      // A rich text block holds its spans' text too, and is found as one layer.
      const spans = designTextRangeSpans(nodes, id);
      const ownText =
        spans.length > 0
          ? designTextBlockText(nodes, id)
          : texts.map((layer) => layer.text).join(" ");
      const label = nameOf(node);
      if (
        (!tag || node.tag === tag) &&
        (!name || (label !== null && name(label))) &&
        (!text || (ownText !== "" && text(ownText)))
      ) {
        total++;
        if (matches.length < options.limit)
          matches.push({
            frameId: frame.id,
            layerId: node.id,
            tag: node.tag,
            ...(label ? { name: label.slice(0, 80) } : {}),
            ...(spans.length > 0
              ? {
                  textLayerId: node.id,
                  text: JSON.parse(preview(ownText, 60)) as string,
                  styledSpans: spans.length,
                }
              : texts.length > 0
                ? { textLayerId: texts[0]!.id, text: JSON.parse(preview(ownText, 60)) as string }
                : {}),
            path: pathOf(node.id),
          });
      }
      // An inline SVG and a rich text block are one layer each: their inside is found through
      // them, not on its own.
      const leaf =
        (node.tag === "svg" || designTextBlockKind(nodes, id) === "rich") &&
        node.id !== options.layerId;
      if (!leaf) node.children.forEach(visit);
    };
    for (const id of options.layerId !== undefined ? [options.layerId] : frame.layers.roots)
      visit(id);
  }
  return { total, matches };
}
