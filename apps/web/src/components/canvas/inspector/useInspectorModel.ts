// FILE: useInspectorModel.ts
// Purpose: Reads the selected frames and layers for the inspector (computed values from the
//          live DOM, stored inline declarations from the model) and applies style patches.
// Layer: Canvas editor state
// Depends on: CanvasEditorContext (preview/commit), canvasSelection helpers.

import type { DesignFrame } from "@synara/contracts";
import { isDesignSvgLayer } from "@synara/shared/designCanvasLayers";
import { designSvgUsesCurrentColor } from "@synara/shared/designCanvasSvg";
import { useMemo } from "react";
import type { DesignLayerElement } from "~/lib/designCanvas";
import { selectionKey, type CanvasSelectionItem } from "../canvasStores";
import { useCanvasEditor, type CanvasEditorApi } from "../editor/CanvasEditorContext";
import { layoutOffset, layoutSize } from "../editor/canvasMeasure";
import { isTextOnly, layerLabel } from "../editor/canvasSelection";
import { useCanvasTextSession, type CanvasTextSegment } from "../editor/canvasTextSession";
import {
  declaredValues,
  mergeValues,
  parseCssColor,
  parseInlineStyle,
  toCssColor,
  type Declaration,
  type MaybeMixed,
  type Rgba,
  type StylePatch,
} from "./inspectorValues";

/** Computed properties the inspector shows; read once per DOM change. */
const COMPUTED_PROPERTIES = [
  "display",
  "position",
  "left",
  "top",
  "right",
  "bottom",
  "rotate",
  "transform",
  "overflow-x",
  "overflow-y",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "justify-content",
  "align-items",
  "align-content",
  "align-self",
  "column-gap",
  "row-gap",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "opacity",
  "mix-blend-mode",
  "background-color",
  "background-image",
  "font-family",
  "font-weight",
  "font-style",
  "font-size",
  "line-height",
  "letter-spacing",
  "text-align",
  "color",
  "text-decoration-line",
  "text-decoration-style",
  "text-decoration-color",
  "text-decoration-thickness",
  "text-decoration-skip-ink",
  "text-underline-offset",
  "text-transform",
  "text-wrap-mode",
  "text-wrap-style",
  "white-space",
  "word-break",
  "text-overflow",
  "-webkit-line-clamp",
  "-webkit-text-stroke-width",
  "-webkit-text-stroke-color",
  "paint-order",
  "outline-style",
  "outline-width",
  "outline-color",
  "outline-offset",
  "text-shadow",
  "filter",
  "backdrop-filter",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "box-shadow",
] as const;
export type ComputedProperty = (typeof COMPUTED_PROPERTIES)[number];

/**
 * Longhands read from the stored inline style as the browser expands it, so a shorthand
 * (`background`, `inset`) counts and asset URLs keep their `synara-asset:` form.
 */
const SPECIFIED_PROPERTIES = [
  "left",
  "right",
  "top",
  "bottom",
  "width",
  "height",
  "transform",
  "color",
  "white-space",
  "background-image",
  "background-blend-mode",
  "background-size",
  "background-position",
  "background-repeat",
  "background-clip",
  "background-origin",
  "background-attachment",
  "filter",
  "backdrop-filter",
  "text-decoration-thickness",
  "text-underline-offset",
  "-webkit-text-stroke-color",
  "-webkit-text-stroke-width",
] as const;
export type SpecifiedProperty = (typeof SPECIFIED_PROPERTIES)[number];

let specifiedProbe: HTMLElement | null = null;

/** The specified longhands of one inline style ("" when not declared). */
export function specifiedValues(style: string | undefined): (property: string) => string {
  specifiedProbe ??= document.createElement("div");
  specifiedProbe.style.cssText = style ?? "";
  const values = new Map<string, string>();
  // A shorthand's omitted parts read as `initial`: for the inspector that is "not set".
  const read = (property: string) => {
    const value = specifiedProbe!.style.getPropertyValue(property);
    return value === "initial" ? "" : value;
  };
  for (const property of SPECIFIED_PROPERTIES) values.set(property, read(property));
  const expanded = (property: string) => {
    if (values.has(property)) return values.get(property)!;
    specifiedProbe!.style.cssText = style ?? "";
    const value = read(property);
    values.set(property, value);
    return value;
  };
  specifiedProbe.style.cssText = "";
  return expanded;
}

/** Tags that never hold layout children (no Flex section). */
const LEAF_TAGS = new Set([
  "img",
  "input",
  "br",
  "hr",
  "textarea",
  "select",
  "video",
  "audio",
  "iframe",
  "canvas",
  "svg",
]);

export type InspectorTarget = {
  item: CanvasSelectionItem;
  element: DesignLayerElement;
  frame: DesignFrame;
  isFrame: boolean;
  computed: Readonly<Record<ComputedProperty, string>>;
  /** Stored inline declarations, in order; `declared` keeps the winning value per property. */
  declarations: readonly Declaration[];
  declared: ReadonlyMap<string, string>;
  /** A longhand as the stored style specifies it, shorthands expanded ("" when unset). */
  specified: (property: string) => string;
  /** Layout size in CSS px (unaffected by canvas zoom). */
  size: { width: number; height: number };
  offset: { left: number; top: number };
  parent: {
    display: string;
    direction: string;
    alignItems: string;
    width: number;
    height: number;
  } | null;
  /** The padding box an absolute layer is placed in (its offset parent); null for frames. */
  containing: { width: number; height: number } | null;
  /** Has its own text content (the Text section applies). */
  hasText: boolean;
  /** Can hold laid-out children (the Flex controls apply). */
  container: boolean;
  /** An inline SVG layer, and whether it paints with `currentColor` (its `color` recolors it). */
  svg: { currentColor: boolean } | null;
};

export function readTarget(
  editor: CanvasEditorApi,
  item: CanvasSelectionItem,
): InspectorTarget | null {
  const frame = editor.frame(item.frameId);
  const element = editor.elementFor(item);
  if (!frame || !element?.isConnected) return null;
  const style = getComputedStyle(element);
  const computed = Object.fromEntries(
    COMPUTED_PROPERTIES.map((property) => [property, style.getPropertyValue(property)]),
  ) as Record<ComputedProperty, string>;
  if (item.kind === "frame") {
    const declarations = parseInlineStyle(frame.style);
    return {
      item,
      element,
      frame,
      isFrame: true,
      computed,
      declarations,
      declared: declaredValues(declarations),
      specified: specifiedValues(frame.style),
      size: { width: frame.width, height: frame.height },
      offset: { left: frame.x, top: frame.y },
      parent: null,
      containing: null,
      hasText: false,
      container: true,
      svg: null,
    };
  }
  const index = editor.layers(item.frameId);
  const node = index?.nodes.get(item.layerId);
  if (!index || node?.type !== "element") return null;
  const declarations = parseInlineStyle(node.attributes.style);
  const hasText = node.children.some((child) => {
    const childNode = index.nodes.get(child);
    return childNode?.type === "text" && childNode.text.trim() !== "";
  });
  const parentElement = element.parentElement;
  const parentStyle = parentElement ? getComputedStyle(parentElement) : null;
  const { left, top, parent: offsetParent } = layoutOffset(element);
  return {
    item,
    element,
    frame,
    isFrame: false,
    computed,
    declarations,
    declared: declaredValues(declarations),
    specified: specifiedValues(node.attributes.style),
    containing: offsetParent
      ? { width: offsetParent.clientWidth, height: offsetParent.clientHeight }
      : null,
    size: layoutSize(element),
    offset: { left, top },
    parent:
      parentElement && parentStyle
        ? {
            display: parentStyle.display,
            direction: parentStyle.flexDirection,
            alignItems: parentStyle.alignItems,
            width: parentElement.clientWidth,
            height: parentElement.clientHeight,
          }
        : null,
    hasText,
    container: !LEAF_TAGS.has(node.tag) && !(hasText && isTextOnly(index, item.layerId)),
    svg: isDesignSvgLayer(node)
      ? { currentColor: designSvgUsesCurrentColor(frame.layers, node.id) }
      : null,
  };
}

type PatchSource = StylePatch | ((target: InspectorTarget) => StylePatch | null);

/** Groups targets by identical patch so each distinct patch is sent once. */
function groupPatches(targets: readonly InspectorTarget[], source: PatchSource) {
  const groups = new Map<string, { patch: StylePatch; items: CanvasSelectionItem[] }>();
  for (const target of targets) {
    const patch = typeof source === "function" ? source(target) : source;
    if (!patch || Object.keys(patch).length === 0) continue;
    const key = JSON.stringify(patch);
    const group = groups.get(key) ?? { patch, items: [] };
    group.items.push(target.item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export type InspectorModel = {
  editor: CanvasEditorApi;
  targets: readonly InspectorTarget[];
  readOnly: boolean;
  /** The shared value across the selection, MIXED when it differs. */
  value: <T>(
    read: (target: InspectorTarget) => T,
    equals?: (a: T, b: T) => boolean,
  ) => MaybeMixed<T> | undefined;
  /** Live DOM only: scrubbing, dragging, picking. */
  preview: (source: PatchSource, targets?: readonly InspectorTarget[]) => void;
  /** Persists as one undo step, however many distinct patches the targets need. */
  commit: (source: PatchSource, targets?: readonly InspectorTarget[]) => Promise<void>;
};

/** The model over `targets`, outside React (keyboard commands build one when they run). */
export function makeInspectorModel(
  editor: CanvasEditorApi,
  targets: readonly InspectorTarget[],
): InspectorModel {
  const { readOnly } = editor;
  return {
    editor,
    targets,
    readOnly,
    value: (read, equals) => mergeValues(targets.map(read), equals),
    preview: (source, subset = targets) => {
      if (readOnly) return;
      for (const group of groupPatches(subset, source))
        editor.previewStyles(group.items, group.patch);
    },
    commit: async (source, subset = targets) => {
      if (readOnly) return;
      const groups = groupPatches(subset, source);
      if (groups.length === 0) return;
      await editor.batch(async () => {
        for (const group of groups) await editor.commitStyles(group.items, group.patch);
      });
    },
  };
}

/** The model of the editor's current selection, read now. */
export function inspectorModelOf(editor: CanvasEditorApi): InspectorModel {
  return makeInspectorModel(
    editor,
    editor.selection
      .map((item) => readTarget(editor, item))
      .filter((target): target is InspectorTarget => target !== null),
  );
}

export function useInspectorModel(): InspectorModel {
  const editor = useCanvasEditor();
  const { selection, domVersion, page, readOnly } = editor;
  const targets = useMemo(
    () =>
      selection
        .map((item) => readTarget(editor, item))
        .filter((target): target is InspectorTarget => target !== null),
    // `domVersion` and `page` are the change signals for the live DOM and the stored styles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, domVersion, page],
  );
  // `readOnly` is read through `editor`, which changes with it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => makeInspectorModel(editor, targets), [editor, readOnly, targets]);
}

/** What a styled range reads from its own element; everything else is the block's. */
const RANGE_COMPUTED: readonly ComputedProperty[] = [
  "font-family",
  "font-weight",
  "font-style",
  "font-size",
  "line-height",
  "letter-spacing",
  "color",
  "text-transform",
  "text-decoration-skip-ink",
  "text-underline-offset",
  "-webkit-text-stroke-width",
  "-webkit-text-stroke-color",
  "paint-order",
];
/** Decoration is drawn by the box that declares it: a range without its own shows the block's. */
const RANGE_DECORATION: readonly ComputedProperty[] = [
  "text-decoration-line",
  "text-decoration-style",
  "text-decoration-color",
  "text-decoration-thickness",
];

/** The selected characters of one styled range, read as a target of their own. */
function rangeTarget(
  block: InspectorTarget,
  blockStyle: string,
  segment: CanvasTextSegment,
): InspectorTarget {
  if (segment.element === block.element) return block;
  const style = getComputedStyle(segment.element);
  const computed = { ...block.computed };
  for (const property of RANGE_COMPUTED) computed[property] = style.getPropertyValue(property);
  if (style.textDecorationLine !== "none")
    for (const property of RANGE_DECORATION) computed[property] = style.getPropertyValue(property);
  const declarations = [...block.declarations, ...parseInlineStyle(segment.style)];
  return {
    ...block,
    element: segment.element,
    computed,
    declarations,
    declared: declaredValues(declarations),
    specified: specifiedValues(`${blockStyle};${segment.style}`),
  };
}

/**
 * The Text, Underline and Text stroke sections while their layer is being typed into
 * (inspector typography applies to the selected range while editing). With characters selected,
 * the targets are the styled ranges they sit in, so differing values show as mixed; with a
 * caret, the block. Changes go to the open edit, which saves them with the typing as one step.
 * It re-reads on every caret move without rendering the canvas (`canvasTextSession`).
 */
export function useTextEditingModel(model: InspectorModel): InspectorModel {
  const { session, version } = useCanvasTextSession();
  return useMemo(() => {
    const [only] = model.targets;
    if (!session || !only || model.targets.length !== 1) return model;
    if (selectionKey(only.item) !== selectionKey(session.item)) return model;
    const block = readTarget(model.editor, session.item) ?? only;
    const node = model.editor.layers(session.item.frameId)?.nodes.get(session.item.layerId);
    const blockStyle = node?.type === "element" ? (node.attributes.style ?? "") : "";
    const segments = session.segments();
    const targets = segments
      ? segments.map((segment) => rangeTarget(block, blockStyle, segment))
      : [block];
    const resolve = (source: PatchSource) =>
      typeof source === "function" ? source(targets[0]!) : source;
    return {
      ...model,
      targets,
      value: (read, equals) => mergeValues(targets.map(read), equals),
      preview: (source) => {
        const patch = model.readOnly ? null : resolve(source);
        if (patch) session.preview(patch);
      },
      commit: async (source) => {
        const patch = model.readOnly ? null : resolve(source);
        if (patch) session.apply(patch);
      },
    };
    // `version` is the change signal for the range and the block's live styles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, session, version]);
}

/** The single selected frame or layer's name, as the layers panel shows it; null for several. */
export function selectionName(model: InspectorModel): string | null {
  const [first] = model.targets;
  if (!first || model.targets.length > 1) return null;
  if (first.item.kind === "frame") return first.frame.title;
  const index = model.editor.layers(first.item.frameId);
  return index ? layerLabel(index, first.item.layerId) : first.frame.title;
}

/** What the single selection is, for the header glyph and its tag ("button"). */
export function selectionKind(
  model: InspectorModel,
): { kind: "frame" | "image" | "text" | "container" | "svg"; tag: string | null } | null {
  const [first] = model.targets;
  if (!first || model.targets.length > 1) return null;
  if (first.isFrame) return { kind: "frame", tag: null };
  const tag = first.element.tagName.toLowerCase();
  if (tag === "img") return { kind: "image", tag };
  if (first.svg) return { kind: "svg", tag };
  return { kind: first.container ? "container" : "text", tag };
}

// ── DOM helpers ──────────────────────────────────────────────────────────

let colorContext: CanvasRenderingContext2D | null | undefined;

/** Any CSS color the browser understands (named, hsl, oklch…) as sRGB bytes; null if invalid. */
export function resolveCssColor(text: string): Rgba | null {
  const parsed = parseCssColor(text);
  if (parsed) return parsed;
  const value = text.trim();
  if (!value || typeof CSS === "undefined" || !CSS.supports("color", value)) return null;
  if (colorContext === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    colorContext = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!colorContext) return null;
  colorContext.clearRect(0, 0, 1, 1);
  colorContext.fillStyle = "#000";
  colorContext.fillStyle = value;
  colorContext.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = colorContext.getImageData(0, 0, 1, 1).data;
  return { r, g, b, a: a / 255 };
}

/** Distinct opaque-ish colors used inside a frame, most used first. */
export function collectFrameColors(root: HTMLElement, limit = 14): string[] {
  const counts = new Map<string, number>();
  const add = (value: string) => {
    const color = resolveCssColor(value);
    if (!color || color.a < 0.05) return;
    const key = toCssColor(color);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  const elements = [root, ...root.querySelectorAll<HTMLElement>("*")].slice(0, 2000);
  for (const element of elements) {
    const style = getComputedStyle(element);
    add(style.backgroundColor);
    if (element.childNodes.length > 0) add(style.color);
    if (parseFloat(style.borderTopWidth) > 0) add(style.borderTopColor);
  }
  return [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([color]) => color);
}

/** The positioned wrapper of a frame on the board, for live geometry previews. */
function frameWrapper(editor: CanvasEditorApi, frameId: string): HTMLElement | null {
  const root = editor.elementFor({ kind: "frame", frameId });
  const host =
    root?.getRootNode() instanceof ShadowRoot ? (root.getRootNode() as ShadowRoot).host : null;
  return host instanceof HTMLElement ? host.parentElement : null;
}

export type FrameGeometry = { x: number; y: number; width: number; height: number };

/** Moves or resizes a frame on screen only; the next render (or `restore`) puts it back. */
export function previewFrameGeometry(
  editor: CanvasEditorApi,
  frameId: string,
  geometry: Partial<FrameGeometry>,
): void {
  const wrapper = frameWrapper(editor, frameId);
  if (!wrapper) return;
  if (geometry.x !== undefined) wrapper.style.left = `${geometry.x}px`;
  if (geometry.y !== undefined) wrapper.style.top = `${geometry.y}px`;
  if (geometry.width !== undefined) wrapper.style.width = `${geometry.width}px`;
  if (geometry.height !== undefined) wrapper.style.height = `${geometry.height}px`;
}

export function restoreFrameGeometry(editor: CanvasEditorApi, frame: DesignFrame): void {
  previewFrameGeometry(editor, frame.id, frame);
}
