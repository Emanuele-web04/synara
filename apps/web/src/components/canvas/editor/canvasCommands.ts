// FILE: canvasCommands.ts
// Purpose: Every editor command the keyboard, the context menus, the layers panel and the
//          tools share: delete, duplicate, copy, arrange, nudge, wrap, flags, selection moves
//          and creating frames, layers and images. Built once per editor; each command reads
//          the editor as it is when it runs, so a menu opened right after a click acts on
//          that click's selection. Every command is one undo step.
// Layer: Canvas editor commands
// Exports: makeCanvasCommands, arrangedOrder, CanvasCommands

import type {
  CanvasFrameLayoutPatch,
  CanvasImportImageInput,
  CanvasWorkCover,
  DesignFrame,
  DesignLayerEdit,
} from "@synara/contracts";
import {
  DESIGN_FRAME_MAX_HEIGHT,
  DESIGN_FRAME_MAX_WIDTH,
  DESIGN_FRAME_MIN_SIZE,
} from "@synara/contracts";
import { declaredStyles } from "@synara/shared/designCanvasLayers";
import {
  designTextEditOperations,
  designTextRangeSpans,
  designTextRuns,
  styleDesignTextRuns,
} from "@synara/shared/designCanvasText";
import type { CanvasSelectionItem } from "../canvasStores";
import { selectionKey } from "../canvasStores";
import {
  canvasId,
  copyFrames,
  copyLayers,
  layersHtml,
  prepareCanvasImage,
  writeClipboard,
} from "./canvasClipboard";
import type { CanvasEditorApi } from "./CanvasEditorContext";
import { placementOf, subtreeOf } from "./canvasHistory";
import { isFreePositioned, positionedOffset, type Point, type WorldRect } from "./canvasMeasure";
import type {
  CanvasArrangeMode,
  CanvasTextAlign,
  CanvasTextFormat,
  CanvasTextStep,
} from "./canvasShortcuts";
import { isTextFormatOn, textFormatPatch } from "./canvasTextEdit";
import {
  elementChildren,
  frameAtPoint,
  isLayerItem,
  isLayerLocked,
  isTextOnly,
  preorderLayers,
  LAYER_HIDDEN_ATTRIBUTE,
  LAYER_LOCKED_ATTRIBUTE,
  LAYER_NAME_ATTRIBUTE,
  layerFlag,
  layerSiblings,
  parentSelection,
  topLayers,
  type LayerItem,
} from "./canvasSelection";

const FRAME_GAP = 80;
/** Images are placed at most this big on their longer side (world pixels). */
const IMAGE_MAX_SIDE = 800;

const clampSize = (value: number, max: number) =>
  Math.round(Math.max(DESIGN_FRAME_MIN_SIZE, Math.min(max, value)));

function layersByFrame(items: readonly CanvasSelectionItem[]) {
  const byFrame = new Map<string, string[]>();
  for (const item of items) {
    if (!isLayerItem(item)) continue;
    const list = byFrame.get(item.frameId) ?? [];
    list.push(item.layerId);
    byFrame.set(item.frameId, list);
  }
  return byFrame;
}

/**
 * Siblings after the arrange commands. Front and back move the selected layers to one end
 * and keep their order; forward and backward step each one past its unselected neighbour.
 */
export function arrangedOrder(
  siblings: readonly string[],
  selected: ReadonlySet<string>,
  mode: CanvasArrangeMode,
): string[] {
  const order = [...siblings];
  const picked = order.filter((id) => selected.has(id));
  const rest = order.filter((id) => !selected.has(id));
  if (mode === "front") return [...rest, ...picked];
  if (mode === "back") return [...picked, ...rest];
  const swap = (at: number, other: number) => {
    [order[at], order[other]] = [order[other]!, order[at]!];
  };
  if (mode === "forward") {
    for (let at = order.length - 2; at >= 0; at--)
      if (selected.has(order[at]!) && !selected.has(order[at + 1]!)) swap(at, at + 1);
  } else {
    for (let at = 1; at < order.length; at++)
      if (selected.has(order[at]!) && !selected.has(order[at - 1]!)) swap(at, at - 1);
  }
  return order;
}

/** The moves that turn `siblings` into `order`, applied one after another. */
function movesToward(
  siblings: readonly string[],
  order: readonly string[],
  selected: ReadonlySet<string>,
) {
  if (order.every((id, at) => siblings[at] === id)) return [];
  const moves: { nodeId: string; beforeId: string | undefined }[] = [];
  // Last first: each layer's successor in `order` is already where it ends up.
  for (let at = order.length - 1; at >= 0; at--)
    if (selected.has(order[at]!)) moves.push({ nodeId: order[at]!, beforeId: order[at + 1] });
  return moves;
}

export type CanvasCommandOptions = {
  /** The title of a page's n-th frame ("Frame 3"). */
  frameTitle: (number: number) => string;
  /** Saves an image asset to the work through the editor's write path. */
  importImage: (input: CanvasImportImageInput) => Promise<unknown>;
  /** Reports a command that failed outside an editor write (an unreadable image). */
  fail: (cause: unknown) => void;
  /** Saves the work's cover frame (its library thumbnail); null goes back to the first frame. */
  saveCover?: ((cover: CanvasWorkCover | null) => Promise<unknown>) | undefined;
};

let copiedStyle: string | null = null;

/** A layer tree with new IDs throughout (moved into a frame that already uses some of its). */
function withFreshIds(tree: ReturnType<typeof subtreeOf>): ReturnType<typeof subtreeOf> {
  const ids = new Map(tree.nodes.map((node) => [node.id, canvasId("l")]));
  return {
    roots: tree.roots.map((id) => ids.get(id)!),
    nodes: tree.nodes.map((node) =>
      node.type === "element"
        ? { ...node, id: ids.get(node.id)!, children: node.children.map((id) => ids.get(id)!) }
        : { ...node, id: ids.get(node.id)! },
    ),
  };
}

export function makeCanvasCommands(
  getEditor: () => CanvasEditorApi,
  options: CanvasCommandOptions,
) {
  const writable = () => !getEditor().readOnly;
  const elementFlag = (item: LayerItem, name: string) =>
    layerFlag(getEditor().layers(item.frameId), item.layerId, name);

  const remove = () => {
    const editor = getEditor();
    const { selection } = editor;
    return editor.batch(async () => {
      if (editor.readOnly || selection.length === 0) return;
      const frameIds = selection
        .filter((item) => item.kind === "frame")
        .map((item) => item.frameId);
      if (frameIds.length)
        await editor.run({ kind: "layout", frames: frameIds.map((id) => ({ id, remove: true })) });
      for (const [frameId, ids] of layersByFrame(selection)) {
        if (frameIds.includes(frameId)) continue;
        await editor.run({
          kind: "edit",
          frameId,
          operations: topLayers(editor.layers(frameId), ids).map(
            (nodeId): DesignLayerEdit => ({ type: "delete", nodeId }),
          ),
        });
      }
      editor.select([]);
    });
  };

  const duplicate = () => {
    const editor = getEditor();
    const { selection } = editor;
    return editor.batch(async () => {
      if (editor.readOnly || selection.length === 0) return;
      const created: CanvasSelectionItem[] = [];
      for (const item of selection) {
        const frame = editor.frame(item.frameId);
        if (!frame) continue;
        if (item.kind === "frame") {
          const id = canvasId("frame");
          await editor.run({
            kind: "restore",
            frames: [
              {
                ...structuredClone(frame),
                id,
                title: `${frame.title} copy`,
                x: frame.x + frame.width + FRAME_GAP,
                revision: 1,
              },
            ],
            removeFrameIds: [],
          });
          created.push({ kind: "frame", frameId: id });
        } else {
          // Not a copy: what was copied stays on the clipboard.
          const result = await editor.run({
            kind: "edit",
            frameId: frame.id,
            operations: [
              {
                type: "insert_html",
                ...placementOf(frame.layers, item.layerId),
                html: layersHtml(frame, [item.layerId]),
              },
            ],
          });
          const layerId = result?.createdNodeIds[0];
          if (layerId) created.push({ kind: "layer", frameId: frame.id, layerId });
        }
      }
      if (created.length) editor.select(created);
    });
  };

  const copy = async () => {
    const editor = getEditor();
    const { selection } = editor;
    const frames = selection
      .filter((item) => item.kind === "frame")
      .map((item) => editor.frame(item.frameId))
      .filter((frame): frame is DesignFrame => frame !== undefined);
    if (frames.length) return writeClipboard(copyFrames(frames));
    const first = selection.find(isLayerItem);
    const frame = first ? editor.frame(first.frameId) : undefined;
    if (!first || !frame) return;
    const ids = selection
      .filter((item): item is LayerItem => isLayerItem(item) && item.frameId === frame.id)
      .map((item) => item.layerId);
    await writeClipboard(copyLayers(frame, topLayers(editor.layers(frame.id), ids)));
  };

  /** Moves layers within their parents; one step per move, so each inverts on its own. */
  const arrangeItems = (items: readonly LayerItem[], mode: CanvasArrangeMode) => {
    const editor = getEditor();
    return editor.batch(async () => {
      if (editor.readOnly) return;
      const groups = new Map<
        string,
        { frameId: string; parentId: string | null; ids: Set<string> }
      >();
      for (const item of items) {
        const index = editor.layers(item.frameId);
        const frame = editor.frame(item.frameId);
        if (!index || !frame) continue;
        const { parentId } = layerSiblings(index, frame.layers.roots, item.layerId);
        const key = `${item.frameId}/${parentId ?? ""}`;
        const group = groups.get(key) ?? { frameId: item.frameId, parentId, ids: new Set() };
        group.ids.add(item.layerId);
        groups.set(key, group);
      }
      for (const { frameId, parentId, ids } of groups.values()) {
        const index = editor.layers(frameId)!;
        const frame = editor.frame(frameId)!;
        const { siblings } = layerSiblings(index, frame.layers.roots, [...ids][0]!);
        for (const move of movesToward(siblings, arrangedOrder(siblings, ids, mode), ids))
          await editor.run({
            kind: "edit",
            frameId,
            operations: [
              {
                type: "move",
                nodeId: move.nodeId,
                parentId,
                ...(move.beforeId ? { beforeId: move.beforeId } : {}),
              },
            ],
          });
      }
    });
  };

  /** ] / [ (front / back) and ⌘] / ⌘[ (one step). Later siblings paint on top. */
  const arrange = (mode: CanvasArrangeMode) =>
    arrangeItems(getEditor().selection.filter(isLayerItem), mode);

  /**
   * Where held arrow keys have moved each item to, until the saves behind them land: a key
   * repeat arrives before the previous nudge is saved and rendered, so it continues from here.
   */
  const nudgeTargets = new Map<string, Point>();
  let nudgesInFlight = 0;

  /** Arrow keys: frames and freely placed layers move; flow layers reorder along their axis. */
  const nudge = (dx: number, dy: number) => {
    const editor = getEditor();
    const { selection } = editor;
    nudgesInFlight++;
    return editor
      .batch(async () => {
        if (editor.readOnly) return;
        const framePatches: CanvasFrameLayoutPatch[] = [];
        for (const item of selection) {
          const key = selectionKey(item);
          // Locked frames and layers stay where they are.
          if (
            editor.frame(item.frameId)?.locked ||
            (item.kind === "layer" && isLayerLocked(editor.layers(item.frameId), item.layerId))
          )
            continue;
          if (item.kind === "frame") {
            const frame = editor.frame(item.frameId);
            if (!frame) continue;
            const from = nudgeTargets.get(key) ?? { x: frame.x, y: frame.y };
            const to = { x: from.x + dx, y: from.y + dy };
            nudgeTargets.set(key, to);
            framePatches.push({ id: frame.id, ...to });
            continue;
          }
          const element = editor.elementFor(item);
          if (!element) continue;
          if (isFreePositioned(element)) {
            const from = nudgeTargets.get(key) ?? positionedOffset(element);
            const to = { x: from.x + dx, y: from.y + dy };
            nudgeTargets.set(key, to);
            await editor.commitStyles([item], { left: `${to.x}px`, top: `${to.y}px` });
            continue;
          }
          const parent = element.parentElement;
          const style = parent ? getComputedStyle(parent) : null;
          const row =
            style?.display.includes("flex") === true && style.flexDirection.startsWith("row");
          const delta = row ? dx : dy;
          if (delta === 0) continue;
          const reversed = style?.flexDirection.endsWith("reverse") === true;
          await arrangeItems([item], delta > 0 !== reversed ? "forward" : "backward");
        }
        if (framePatches.length) await editor.run({ kind: "layout", frames: framePatches });
      })
      .finally(() => {
        // Once the last save has rendered, positions are read from the canvas again.
        if (--nudgesInFlight === 0)
          requestAnimationFrame(() => {
            if (nudgesInFlight === 0) nudgeTargets.clear();
          });
      });
  };

  /** ⌘⌥G (and ⇧A with several layers): wrap siblings in a new flex frame. */
  const wrap = (style = "display:flex;flex-direction:column") => {
    const editor = getEditor();
    const { selection } = editor;
    return editor.batch(async () => {
      if (editor.readOnly) return;
      const layers = selection.filter(isLayerItem);
      const first = layers[0];
      const frame = first ? editor.frame(first.frameId) : undefined;
      const index = first ? editor.layers(first.frameId) : undefined;
      if (!first || !frame || !index) return;
      const { parentId, siblings } = layerSiblings(index, frame.layers.roots, first.layerId);
      const ids = siblings.filter((id) =>
        layers.some((item) => item.frameId === first.frameId && item.layerId === id),
      );
      if (ids.length === 0) return;
      const created = await editor.run({
        kind: "edit",
        frameId: first.frameId,
        operations: [
          {
            type: "insert_html",
            parentId,
            beforeId: ids[0]!,
            html: `<div style="${style}"></div>`,
          },
        ],
      });
      const wrapper = created?.createdNodeIds[0];
      if (!wrapper) return;
      await editor.run({
        kind: "edit",
        frameId: first.frameId,
        operations: ids.map(
          (nodeId): DesignLayerEdit => ({ type: "move", nodeId, parentId: wrapper }),
        ),
      });
      editor.select([{ kind: "layer", frameId: first.frameId, layerId: wrapper }]);
    });
  };

  /** ⌘⇧G: replace a container with its children, in place. */
  const ungroup = () => {
    const editor = getEditor();
    const { selection } = editor;
    return editor.batch(async () => {
      if (editor.readOnly) return;
      const next: CanvasSelectionItem[] = [];
      for (const item of selection.filter(isLayerItem)) {
        const frame = editor.frame(item.frameId);
        const index = editor.layers(item.frameId);
        const node = index?.nodes.get(item.layerId);
        if (!frame || !index || node?.type !== "element" || node.children.length === 0) continue;
        const { parentId } = layerSiblings(index, frame.layers.roots, item.layerId);
        await editor.run({
          kind: "edit",
          frameId: item.frameId,
          operations: [
            ...node.children.map(
              (nodeId): DesignLayerEdit => ({
                type: "move",
                nodeId,
                parentId,
                beforeId: item.layerId,
              }),
            ),
            { type: "delete", nodeId: item.layerId },
          ],
        });
        for (const id of node.children)
          if (index.nodes.get(id)?.type === "element")
            next.push({ kind: "layer", frameId: item.frameId, layerId: id });
      }
      if (next.length) editor.select(next);
    });
  };

  /** ⌥⇧A / Remove flex: the flex layout and its spacing go; children keep their order. */
  const removeFlex = () => {
    const editor = getEditor();
    const flexed = editor.selection.filter((item) => {
      const element = editor.elementFor(item);
      return element !== null && getComputedStyle(element).display.includes("flex");
    });
    return editor.commitStyles(flexed, {
      display: null,
      "flex-direction": null,
      "flex-wrap": null,
      "justify-content": null,
      "align-items": null,
      gap: null,
      "row-gap": null,
      "column-gap": null,
    });
  };

  /** Whether every selected item clips its content (Clip content). */
  const clips = () => {
    const editor = getEditor();
    return (
      editor.selection.length > 0 &&
      editor.selection.every((item) => {
        const element = editor.elementFor(item);
        const style = element ? getComputedStyle(element) : null;
        return style !== null && (style.overflowX !== "visible" || style.overflowY !== "visible");
      })
    );
  };
  /** ⌥C: clip content on, unless every selected item already clips. */
  const toggleClip = () =>
    getEditor().commitStyles(
      getEditor().selection,
      clips()
        ? { overflow: null, "overflow-x": null, "overflow-y": null }
        : { "overflow-x": null, "overflow-y": null, overflow: "hidden" },
    );

  /** Digits: 1 is 10% … 0 is 100%, or an exact percentage from two quick digits. */
  const setOpacity = (percent: number) => {
    const editor = getEditor();
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    return editor.commitStyles(editor.selection, {
      opacity: value === 100 ? null : String(value / 100),
    });
  };

  /** Text layers a typography key acts on: the selected ones, and every one inside a frame. */
  const textTargets = (): LayerItem[] => {
    const editor = getEditor();
    const targets = new Map<string, LayerItem>();
    for (const item of editor.selection) {
      const index = editor.layers(item.frameId);
      const frame = editor.frame(item.frameId);
      if (!index || !frame) continue;
      const scope =
        item.kind === "frame"
          ? preorderLayers(index, frame.layers.roots)
          : preorderLayers(index, [item.layerId]);
      for (const layerId of scope)
        if (isTextOnly(index, layerId) && !isLayerLocked(index, layerId))
          targets.set(`${item.frameId}/${layerId}`, {
            kind: "layer",
            frameId: item.frameId,
            layerId,
          });
    }
    return [...targets.values()];
  };

  /** ⌘⌥L / T / R / J. */
  const alignText = (align: CanvasTextAlign) =>
    getEditor().commitStyles(textTargets(), { "text-align": align });

  /**
   * ⌘B / ⌘I / ⌘U on the selected text layers (and every one in a selected frame), when
   * none is being typed into: the whole block, its styled ranges included, gets the format,
   * unless every character has it already, then all lose it. One undo step.
   */
  const formatText = (format: CanvasTextFormat) => {
    const editor = getEditor();
    const blocks = textTargets().flatMap((item) => {
      const element = editor.elementFor(item);
      const frame = editor.frame(item.frameId);
      if (!(element instanceof HTMLElement) || !frame) return [];
      const nodes = new Map(frame.layers.nodes.map((node) => [node.id, node]));
      // The elements holding its characters: the block's own text and each styled range.
      const node = nodes.get(item.layerId);
      const ownText =
        node?.type === "element" &&
        node.children.some((id) => {
          const child = nodes.get(id);
          return child?.type === "text" && child.text.trim() !== "";
        });
      const ranges = designTextRangeSpans(nodes, item.layerId).flatMap((layerId) => {
        const span = editor.elementFor({ ...item, layerId });
        return span instanceof HTMLElement && span.textContent?.trim() ? [span] : [];
      });
      const owners = ownText || ranges.length === 0 ? [element, ...ranges] : ranges;
      return [{ item, element, nodes, owners }];
    });
    if (blocks.length === 0) return Promise.resolve();
    const on = blocks.every((block) =>
      block.owners.every((owner) => isTextFormatOn(format, owner, block.element)),
    );
    const byFrame = new Map<string, DesignLayerEdit[]>();
    for (const { item, element, nodes } of blocks) {
      const patch = textFormatPatch(format, on, false, element);
      // The block takes it, so its ranges stop overriding it.
      const cleared = Object.fromEntries(Object.keys(patch).map((property) => [property, null]));
      const ranges = designTextEditOperations(
        nodes,
        item.layerId,
        styleDesignTextRuns(designTextRuns(nodes, item.layerId), cleared),
        () => canvasId("layer"),
      );
      const operations = byFrame.get(item.frameId) ?? [];
      operations.push(
        { type: "set_styles", nodeId: item.layerId, styles: { ...patch } },
        ...(ranges ?? []),
      );
      byFrame.set(item.frameId, operations);
    }
    return editor.batch(async () => {
      for (const [frameId, operations] of byFrame)
        await editor.run({ kind: "edit", frameId, operations });
    });
  };

  /**
   * The text keys step size, weight, line height and letter spacing: 1 px, 100, 1 px and
   * 0.5 px, from the values as rendered.
   */
  const stepText = (step: CanvasTextStep, direction: 1 | -1) => {
    const editor = getEditor();
    return editor.batch(async () => {
      for (const item of textTargets()) {
        const element = editor.elementFor(item);
        if (!element) continue;
        const style = getComputedStyle(element);
        const size = Number.parseFloat(style.fontSize) || 16;
        const patch =
          step === "size"
            ? { "font-size": `${Math.max(1, Math.round(size) + direction)}px` }
            : step === "weight"
              ? {
                  "font-weight": String(
                    Math.max(
                      100,
                      Math.min(
                        900,
                        (Math.round((Number(style.fontWeight) || 400) / 100) + direction) * 100,
                      ),
                    ),
                  ),
                }
              : step === "line-height"
                ? {
                    "line-height": `${Math.max(1, Math.round(Number.parseFloat(style.lineHeight) || size * 1.2) + direction)}px`,
                  }
                : {
                    "letter-spacing": `${Math.round(((Number.parseFloat(style.letterSpacing) || 0) + direction * 0.5) * 10) / 10}px`,
                  };
        await editor.commitStyles([item], patch);
      }
    });
  };

  /** N / ⇧N: the next or previous frame on the page, selected. */
  const stepFrame = (step: 1 | -1) => {
    const editor = getEditor();
    const frames = editor.page.frames;
    if (frames.length === 0) return null;
    const current = editor.selection[0]?.frameId;
    const at = frames.findIndex((frame) => frame.id === current);
    const next =
      frames[
        at < 0 ? (step > 0 ? 0 : frames.length - 1) : (at + step + frames.length) % frames.length
      ]!;
    editor.select([{ kind: "frame", frameId: next.id }]);
    return next;
  };

  /** ⌘⌥⇧L: every locked layer on the page unlocks, one undo step. */
  const unlockAll = () => {
    const editor = getEditor();
    return editor.batch(async () => {
      if (editor.readOnly) return;
      for (const frame of editor.page.frames) {
        const index = editor.layers(frame.id);
        if (!index) continue;
        const locked = [...index.nodes.keys()].filter((id) =>
          layerFlag(index, id, LAYER_LOCKED_ATTRIBUTE),
        );
        if (locked.length)
          await editor.run({
            kind: "edit",
            frameId: frame.id,
            operations: locked.map(
              (nodeId): DesignLayerEdit => ({
                type: "set_attributes",
                nodeId,
                attributes: { [LAYER_LOCKED_ATTRIBUTE]: null },
              }),
            ),
          });
      }
    });
  };

  /** ⇧A: flex on one container, a flex wrapper around several layers. */
  const addFlex = () => {
    const editor = getEditor();
    if (editor.selection.filter(isLayerItem).length > 1) return wrap();
    return editor.commitStyles(editor.selection, { display: "flex", "flex-direction": "column" });
  };

  const styleOf = (item: CanvasSelectionItem) => {
    const editor = getEditor();
    if (item.kind === "frame") return editor.frame(item.frameId)?.style ?? "";
    const node = editor.layers(item.frameId)?.nodes.get(item.layerId);
    return node?.type === "element" ? (node.attributes.style ?? "") : "";
  };

  /** ⌘⌥C / ⌘⌥V: the whole inline style moves from one layer to others. */
  const copyStyles = () => {
    const first = getEditor().selection[0];
    if (first) copiedStyle = styleOf(first);
  };
  const pasteStyles = () => {
    const editor = getEditor();
    return editor.batch(async () => {
      if (editor.readOnly || copiedStyle === null) return;
      const copied = declaredStyles(copiedStyle);
      for (const item of editor.selection) {
        const patch: Record<string, string | null> = Object.fromEntries(copied);
        for (const key of declaredStyles(styleOf(item)).keys())
          if (!copied.has(key)) patch[key] = null;
        await editor.commitStyles([item], patch);
      }
    });
  };

  /** Sets a `data-*` flag on layers, one edit per frame. */
  const setFlag = (items: readonly LayerItem[], name: string, on: boolean) => {
    const editor = getEditor();
    return editor.batch(async () => {
      if (editor.readOnly) return;
      for (const [frameId, ids] of layersByFrame(items))
        await editor.run({
          kind: "edit",
          frameId,
          operations: ids.map(
            (nodeId): DesignLayerEdit => ({
              type: "set_attributes",
              nodeId,
              attributes: { [name]: on ? "true" : null },
            }),
          ),
        });
    });
  };
  /** ⌘⇧H / ⌘⇧L: on for all unless every selected layer already has it. */
  const toggleFlag = (name: string) => {
    const layers = getEditor().selection.filter(isLayerItem);
    return setFlag(layers, name, !layers.every((item) => elementFlag(item, name)));
  };

  const selectParent = () => {
    const editor = getEditor();
    const first = editor.selection[0];
    if (!first || first.kind === "frame") return;
    const parent = parentSelection(editor.layers(first.frameId), first);
    if (parent) editor.select([parent]);
  };

  /** Enter and "Select children": the element children (a frame's top-level layers). */
  const selectChildren = () => {
    const editor = getEditor();
    const first = editor.selection[0];
    if (!first) return;
    const roots = editor.frame(first.frameId)?.layers.roots ?? [];
    const index = editor.layers(first.frameId);
    const children = elementChildren(index, roots, first).filter((id) => !isLayerLocked(index, id));
    if (children.length)
      editor.select(
        children.map((layerId) => ({ kind: "layer", frameId: first.frameId, layerId })),
      );
  };

  /** ⌘A: the selected layer's siblings, otherwise every frame on the page. */
  const selectSiblings = () => {
    const editor = getEditor();
    const first = editor.selection[0];
    const index = first ? editor.layers(first.frameId) : undefined;
    const frame = first ? editor.frame(first.frameId) : undefined;
    if (first?.kind === "layer" && index && frame) {
      const { siblings } = layerSiblings(index, frame.layers.roots, first.layerId);
      editor.select(
        siblings
          .filter((id) => index.nodes.get(id)?.type === "element" && !isLayerLocked(index, id))
          .map((layerId) => ({ kind: "layer", frameId: first.frameId, layerId })),
      );
    } else editor.select(editor.page.frames.map((item) => ({ kind: "frame", frameId: item.id })));
  };

  /** ⌘⇧A: the selection's siblings that are not selected (frames for frames). */
  const selectOthers = () => {
    const editor = getEditor();
    const { selection } = editor;
    const first = selection[0];
    if (!first) return;
    const chosen = new Set(selection.map(selectionKey));
    if (first.kind === "frame") {
      editor.select(
        editor.page.frames
          .map((frame): CanvasSelectionItem => ({ kind: "frame", frameId: frame.id }))
          .filter((item) => !chosen.has(selectionKey(item))),
      );
      return;
    }
    const index = editor.layers(first.frameId);
    const frame = editor.frame(first.frameId);
    if (!index || !frame) return;
    const { siblings } = layerSiblings(index, frame.layers.roots, first.layerId);
    editor.select(
      siblings
        .filter((id) => index.nodes.get(id)?.type === "element" && !isLayerLocked(index, id))
        .map((layerId): CanvasSelectionItem => ({ kind: "layer", frameId: first.frameId, layerId }))
        .filter((item) => !chosen.has(selectionKey(item))),
    );
  };

  /** Tab / ⇧Tab: the next or previous element sibling, wrapping around. */
  const cycleSibling = (step: 1 | -1) => {
    const editor = getEditor();
    const item = editor.selection[0];
    const index = item ? editor.layers(item.frameId) : undefined;
    const frame = item ? editor.frame(item.frameId) : undefined;
    if (item?.kind !== "layer" || !index || !frame) return;
    const siblings = layerSiblings(index, frame.layers.roots, item.layerId).siblings.filter(
      (id) => index.nodes.get(id)?.type === "element" && !isLayerLocked(index, id),
    );
    const at = siblings.indexOf(item.layerId);
    const next = siblings[(at + step + siblings.length) % siblings.length];
    if (next) editor.select([{ kind: "layer", frameId: item.frameId, layerId: next }]);
  };

  /**
   * Moves layers to a parent (null: a frame's top level) before `beforeId` (none: on top),
   * keeping their order; across frames too (the layers panel). One undo step. A layer
   * moved into another frame keeps its ID unless that frame already uses it.
   */
  const moveLayers = (
    sources: readonly LayerItem[],
    target: { frameId: string; parentId: string | null; beforeId?: string | undefined },
  ) => {
    const editor = getEditor();
    return editor.batch(async () => {
      if (editor.readOnly || sources.length === 0) return;
      const moved: LayerItem[] = [];
      const local = sources.filter((item) => item.frameId === target.frameId);
      if (local.length)
        await editor.run({
          kind: "edit",
          frameId: target.frameId,
          operations: local.map(
            (item): DesignLayerEdit => ({
              type: "move",
              nodeId: item.layerId,
              parentId: target.parentId,
              ...(target.beforeId ? { beforeId: target.beforeId } : {}),
            }),
          ),
        });
      moved.push(...local);
      const destination = editor.frame(target.frameId);
      const remote = sources.filter((item) => item.frameId !== target.frameId);
      if (destination && remote.length) {
        const taken = new Set(destination.layers.nodes.map((node) => node.id));
        const inserts: DesignLayerEdit[] = [];
        for (const item of remote) {
          const source = editor.frame(item.frameId);
          if (!source) continue;
          let tree = subtreeOf(source.layers, item.layerId);
          if (tree.nodes.some((node) => taken.has(node.id))) tree = withFreshIds(tree);
          for (const node of tree.nodes) taken.add(node.id);
          inserts.push({
            type: "insert_layers",
            parentId: target.parentId,
            ...(target.beforeId ? { beforeId: target.beforeId } : {}),
            layers: tree,
          });
          moved.push({ kind: "layer", frameId: target.frameId, layerId: tree.roots[0]! });
        }
        // Into the new frame first, so a refused insert loses nothing.
        if (!(await editor.run({ kind: "edit", frameId: target.frameId, operations: inserts })))
          return;
        for (const [frameId, ids] of layersByFrame(remote))
          await editor.run({
            kind: "edit",
            frameId,
            operations: ids.map((nodeId): DesignLayerEdit => ({ type: "delete", nodeId })),
          });
      }
      editor.select(moved);
    });
  };

  /** Reorders a page's frames (back to front), one undo step. */
  const orderFrames = (order: readonly string[]) =>
    getEditor().run({ kind: "layout", frames: [], order });

  /** Inserts HTML into a frame (at its top level unless a parent is given). */
  const insertIntoFrame = async (
    frameId: string,
    html: string,
    {
      parentId = null,
      beforeId,
      select = false,
    }: { parentId?: string | null; beforeId?: string; select?: boolean } = {},
  ) => {
    const editor = getEditor();
    const result = await editor.run({
      kind: "edit",
      frameId,
      operations: [{ type: "insert_html", parentId, ...(beforeId ? { beforeId } : {}), html }],
    });
    const created = result?.createdNodeIds[0];
    if (created && select) getEditor().select([{ kind: "layer", frameId, layerId: created }]);
    return result && created ? { layerId: created, work: result.work } : null;
  };

  /** A new frame (with optional content), selected; one undo step with its content. */
  const createFrame = (rect: WorldRect, html = "") => {
    const editor = getEditor();
    return editor.batch(async () => {
      const id = canvasId("frame");
      const frame: DesignFrame = {
        id,
        title: options.frameTitle(editor.page.frames.length + 1),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: clampSize(rect.width, DESIGN_FRAME_MAX_WIDTH),
        height: clampSize(rect.height, DESIGN_FRAME_MAX_HEIGHT),
        revision: 1,
        style: "background:#ffffff",
        layers: { roots: [], nodes: [] },
      };
      const created = await editor.run({ kind: "restore", frames: [frame], removeFrameIds: [] });
      if (!created) return null;
      const content = html ? await insertIntoFrame(id, html) : null;
      getEditor().select([{ kind: "frame", frameId: id }]);
      return { frameId: id, content };
    });
  };

  /**
   * An image file as a work asset, placed inside the frame under `at` (a world point) as an
   * absolute layer, or as a new frame there; without a point, at `center`.
   */
  /** An image file stored as a work asset (the inspector's image fill); null if refused. */
  const importImageAsset = async (file: File): Promise<string | null> => {
    const editor = getEditor();
    if (editor.readOnly) return null;
    try {
      const image = await prepareCanvasImage(file, editor.work.id);
      await options.importImage(image.input);
      return image.input.assetId;
    } catch (cause) {
      options.fail(cause);
      return null;
    }
  };

  const placeImage = async (file: File, at: Point | null, center: Point) => {
    const editor = getEditor();
    if (editor.readOnly) return;
    try {
      const image = await prepareCanvasImage(file, editor.work.id);
      await options.importImage(image.input);
      const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(image.width, image.height));
      const width = Math.round(image.width * scale);
      const height = Math.round(image.height * scale);
      const alt = image.input.name.replaceAll('"', "");
      const style = `width:${width}px;height:${height}px;object-fit:cover;display:block`;
      const target = at ? frameAtPoint(getEditor().page.frames, at) : null;
      if (target)
        await insertIntoFrame(
          target.frame.id,
          `<img src="synara-asset:${image.input.assetId}" alt="${alt}" style="position:absolute;left:${Math.round(target.x)}px;top:${Math.round(target.y)}px;${style}">`,
          { select: true },
        );
      else
        await createFrame(
          { ...(at ?? center), width, height },
          `<img src="synara-asset:${image.input.assetId}" alt="${alt}" style="${style}">`,
        );
    } catch (cause) {
      options.fail(cause);
    }
  };

  return {
    moveLayers,
    orderFrames,
    /** The editor as it is now (menus and the text editor read it when they act). */
    editor: getEditor,
    remove,
    duplicate,
    copy,
    /** Copies, then deletes what was copied. */
    cut: () => copy().then(remove),
    arrange,
    nudge,
    wrap,
    /** ⇧F: the selection wrapped in a plain frame. */
    frameSelection: () => wrap(""),
    ungroup,
    addFlex,
    removeFlex,
    toggleClip,
    clips,
    setOpacity,
    alignText,
    formatText,
    stepText,
    stepFrame,
    unlockAll,
    selectOthers,
    copyStyles,
    pasteStyles,
    canPasteStyles: () => copiedStyle !== null,
    /** Whether the text formats and alignments have text layers to act on. */
    hasTextTargets: () => textTargets().length > 0,
    setFlag,
    toggleHidden: () => toggleFlag(LAYER_HIDDEN_ATTRIBUTE),
    toggleLocked: () => toggleFlag(LAYER_LOCKED_ATTRIBUTE),
    isFlagged: (name: string) => {
      const layers = getEditor().selection.filter(isLayerItem);
      return layers.length > 0 && layers.every((item) => elementFlag(item, name));
    },
    rename: (item: LayerItem, name: string) =>
      getEditor().run({
        kind: "edit",
        frameId: item.frameId,
        operations: [
          {
            type: "set_attributes",
            nodeId: item.layerId,
            attributes: { [LAYER_NAME_ATTRIBUTE]: name.trim() ? name.trim().slice(0, 120) : null },
          },
        ],
      }),
    selectParent,
    selectChildren,
    selectSiblings,
    cycleSibling,
    insertIntoFrame,
    createFrame,
    placeImage,
    importImageAsset,
    /** Whether this frame of the open page is the work's cover (its library thumbnail). */
    isCover: (frameId: string) => {
      const { work, page } = getEditor();
      return work.cover?.pageId === page.id && work.cover.frameId === frameId;
    },
    /** Makes a frame of the open page the work's cover, or clears the cover with null. */
    setCover: async (frameId: string | null) => {
      const editor = getEditor();
      if (editor.readOnly || !options.saveCover) return;
      try {
        await options.saveCover(frameId === null ? null : { pageId: editor.page.id, frameId });
      } catch (cause) {
        options.fail(cause);
      }
    },
    writable,
  };
}

export type CanvasCommands = ReturnType<typeof makeCanvasCommands>;
