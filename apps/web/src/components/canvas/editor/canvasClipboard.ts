// FILE: canvasClipboard.ts
// Purpose: Copy and paste on the canvas: copied frames and layers go on the clipboard as HTML source, with the
//          copied tree embedded in an HTML comment of the `text/html` flavour in Synara's own
//          format, so a paste after a reload or in another window recreates them. What a paste
//          turns into (image files, the embedded tree, HTML source, else text) and where it
//          lands (inside or on top of the selection, or in its place), and image files prepared
//          as canvas assets. Pasted content is untrusted: it reaches the server only through
//          the sanitizing `insert_html` and `set_frame_styles` operations (an SVG document too:
//          the server keeps it to the SVG subset and refuses the paste if it holds more).
// Layer: Canvas editor clipboard
// Exports: canvasId, layersHtml, copyLayers, copyFrames, canvasClipboardHtml, readEmbeddedTree,
//          writeClipboard, readPaste, readClipboard, textToHtml, pastedFrames, pasteIntoCanvas,
//          prepareCanvasImage

import {
  DesignFrame as DesignFrameSchema,
  DesignLayerTree as DesignLayerTreeSchema,
  type CanvasImportImageInput,
  type DesignFrame,
  type DesignLayerEdit,
  type DesignLayerTree,
} from "@synara/contracts";
import { declaredStyles, serializeDesignLayers } from "@synara/shared/designCanvasLayers";
import { Option, Schema } from "effect";
import { blobToBase64 } from "~/lib/designCanvas";
import { randomUUID } from "~/lib/utils";
import type { CanvasCommands } from "./canvasCommands";
import type { CanvasEditorApi } from "./CanvasEditorContext";
import { placementOf, subtreeOf } from "./canvasHistory";
import type { Point } from "./canvasMeasure";
import { holdsLayers, isLayerItem, type LayerItem } from "./canvasSelection";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** Each paste of copied frames lands this much further down and right (world pixels). */
export const PASTE_OFFSET = 40;
/** A paste with nothing selected makes a frame this size around the camera's centre. */
const PASTE_FRAME = { width: 720, height: 480 };

export const canvasId = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;

/** Layers as plain HTML with inline styles: useful in a code editor and other design tools. */
export function layersHtml(frame: DesignFrame, layerIds: readonly string[]): string {
  return layerIds.map((id) => serializeDesignLayers(subtreeOf(frame.layers, id), false)).join("\n");
}

/** A layer tree whose root style has `patch` merged in (null removes a property). */
export function restyledRoot(
  tree: DesignLayerTree,
  patch: Readonly<Record<string, string | null>>,
): DesignLayerTree {
  const rootId = tree.roots[0];
  if (!rootId || Object.keys(patch).length === 0) return tree;
  return {
    ...tree,
    nodes: tree.nodes.map((node) => {
      if (node.id !== rootId || node.type !== "element") return node;
      const declared = declaredStyles(node.attributes.style ?? "");
      for (const [property, value] of Object.entries(patch))
        if (value === null) declared.delete(property);
        else declared.set(property, value);
      const style = [...declared].map(([property, value]) => `${property}:${value}`).join(";");
      return { ...node, attributes: { ...node.attributes, style } };
    }),
  };
}

/** One layer as HTML with its root restyled (an ⌥-drag copy at the dropped position). */
export const restyledLayerHtml = (
  frame: DesignFrame,
  layerId: string,
  patch: Readonly<Record<string, string | null>>,
) => serializeDesignLayers(restyledRoot(subtreeOf(frame.layers, layerId), patch), false);

/** What the canvas copied: frames or layer trees, embedded in the clipboard's HTML. */
export type CanvasClipboardTree = { frames: DesignFrame[]; layers: DesignLayerTree[] };
/** A copy is the HTML source (plain text) and the same HTML with the tree embedded. */
export type CanvasCopy = { text: string; html: string };

/** The HTML comment that carries a copy: `<!--synara-canvas:v1:<base64 JSON>-->`. */
const EMBED_PREFIX = "synara-canvas:v1:";
const EMBED_PATTERN = /<!--synara-canvas:v1:([A-Za-z0-9+/=]+)-->/;
/** Embedded copies larger than this are not read back (the plain HTML still pastes). */
const MAX_EMBED_BYTES = 12 * 1024 * 1024;

/** What the editor copied last, for a paste whose HTML flavour the browser dropped. */
let lastCopy: (CanvasClipboardTree & { text: string }) | null = null;

const toBase64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
};
const fromBase64 = (data: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(data), (char) => char.charCodeAt(0)));

/**
 * The `text/html` flavour of a copy: a charset meta tag, the
 * tree as base64 JSON in an HTML comment, then the visible HTML.
 */
export function canvasClipboardHtml(tree: CanvasClipboardTree, visible: string): string {
  const embedded = toBase64(JSON.stringify({ frames: tree.frames, layers: tree.layers }));
  return `<meta charset="utf-8"><!--${EMBED_PREFIX}${embedded}-->${visible}`;
}

const decodeFrame = Schema.decodeUnknownOption(DesignFrameSchema);
const decodeTree = Schema.decodeUnknownOption(DesignLayerTreeSchema);

/**
 * The tree embedded in pasted HTML, or null. Clipboard data is untrusted: anything that does
 * not decode as frames or layer trees is ignored, and what does decode is still only sent
 * through the sanitizing insert operations.
 */
export function readEmbeddedTree(html: string): CanvasClipboardTree | null {
  const match = EMBED_PATTERN.exec(html);
  if (!match || match[1]!.length > MAX_EMBED_BYTES) return null;
  try {
    const parsed = JSON.parse(fromBase64(match[1]!)) as { frames?: unknown; layers?: unknown };
    const frames = Array.isArray(parsed.frames)
      ? parsed.frames.map((item) => decodeFrame(item))
      : [];
    const layers = Array.isArray(parsed.layers)
      ? parsed.layers.map((item) => decodeTree(item))
      : [];
    if (frames.some(Option.isNone) || layers.some(Option.isNone)) return null;
    const tree = {
      frames: frames.map((frame) => Option.getOrThrow(frame)),
      layers: layers.map((layer) => Option.getOrThrow(layer)),
    };
    return tree.frames.length || tree.layers.length ? tree : null;
  } catch {
    return null;
  }
}

/** Copies layers: their HTML source, with the trees embedded for a paste anywhere. */
export function copyLayers(frame: DesignFrame, layerIds: readonly string[]): CanvasCopy {
  const layers = layerIds.map((id) => subtreeOf(frame.layers, id));
  const text = layers.map((tree) => serializeDesignLayers(tree, false)).join("\n");
  lastCopy = { text, frames: [], layers };
  return { text, html: canvasClipboardHtml({ frames: [], layers }, text) };
}

export function copyFrames(frames: readonly DesignFrame[]): CanvasCopy {
  const text = frames.map((frame) => serializeDesignLayers(frame.layers, false)).join("\n");
  const copied = frames.map((frame) => structuredClone(frame));
  lastCopy = { text, frames: copied, layers: [] };
  return { text, html: canvasClipboardHtml({ frames: copied, layers: [] }, text) };
}

export async function writeClipboard(copy: CanvasCopy) {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([copy.text], { type: "text/plain" }),
        "text/html": new Blob([copy.html], { type: "text/html" }),
      }),
    ]);
  } catch {
    await navigator.clipboard.writeText(copy.text).catch(() => {});
  }
}

export type ClipboardContent =
  | { kind: "image"; file: File }
  | { kind: "tree"; tree: CanvasClipboardTree }
  | { kind: "html"; html: string }
  /** An SVG document's source, inserted as an inline SVG layer through the sanitizer. */
  | { kind: "svg"; svg: string }
  | { kind: "text"; text: string };

/**
 * "Plain text that looks like HTML markup": it starts with a
 * tag, a comment or a doctype, ends with `>`, and holds a closing or self-closing tag.
 */
export const looksLikeHtml = (text: string) => {
  const value = text.trim();
  return /^<[!a-zA-Z]/.test(value) && value.endsWith(">") && /<\/[a-zA-Z]|\/>/.test(value);
};
/** A whole SVG document: an optional XML prolog, comments and DOCTYPE, then one `<svg>`. */
export const isSvgDocument = (text: string) => {
  const value = text.trim();
  // A comment never swallows a "-->", so the pattern has one way to match (no backtracking).
  const comments = String.raw`(?:<!--(?:(?!-->)[\s\S])*-->\s*)*`;
  return (
    new RegExp(
      String.raw`^(?:<\?xml[^>]*>\s*)?${comments}(?:<!DOCTYPE[^>[]*(?:\[[^\]]*\])?\s*>\s*${comments})?<svg[\s>/]`,
      "i",
    ).test(value) &&
    (/<\/svg\s*>$/i.test(value) || /<svg\b[^<]*\/>$/i.test(value))
  );
};

/**
 * What a paste turns into, in this order: image files, the
 * embedded canvas tree, an SVG document (after the tree so the canvas's own
 * copy of a frame holding one SVG still pastes as a frame), HTML source in the plain text, else
 * text. Rich HTML from a browser arrives as its plain text.
 */
export function readPaste(
  data: Pick<DataTransfer, "files" | "getData"> | null,
): ClipboardContent | null {
  if (!data) return null;
  const file = [...data.files].find((item) => IMAGE_TYPES.has(item.type));
  if (file) return { kind: "image", file };
  const text = data.getData("text/plain");
  const tree = readEmbeddedTree(data.getData("text/html"));
  if (tree) return { kind: "tree", tree };
  // The browser dropped the HTML flavour: this window's own last copy still pastes exactly.
  if (lastCopy && text && lastCopy.text === text)
    return { kind: "tree", tree: { frames: lastCopy.frames, layers: lastCopy.layers } };
  if (isSvgDocument(text)) return { kind: "svg", svg: text.trim() };
  if (looksLikeHtml(text)) return { kind: "html", html: text };
  if (text.trim()) return { kind: "text", text };
  return null;
}

/**
 * The system clipboard for the paste keys that have no paste event (⌘⇧V, ⌘⇧R, the menus): the
 * HTML flavour unsanitized where the browser allows it, so the embedded tree survives.
 */
export async function readClipboard(): Promise<ClipboardContent | null> {
  const files: File[] = [];
  const strings = new Map<string, string>();
  try {
    const items = await (
      navigator.clipboard.read as (options?: { unsanitized?: string[] }) => Promise<ClipboardItems>
    )({ unsanitized: ["text/html"] });
    for (const item of items)
      for (const type of item.types) {
        const blob = await item.getType(type);
        if (IMAGE_TYPES.has(type)) files.push(new File([blob], "Pasted image", { type }));
        else if (type === "text/html" || type === "text/plain")
          strings.set(type, await blob.text());
      }
  } catch {
    const text = await navigator.clipboard.readText().catch(() => "");
    if (text) strings.set("text/plain", text);
  }
  return readPaste({
    files: files as unknown as FileList,
    getData: (type: string) => strings.get(type) ?? "",
  });
}

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const textToHtml = (text: string) =>
  `<p style="margin:0;white-space:pre-wrap">${escapeHtml(text)}</p>`;

/**
 * Copied frames as new frames. They keep their layout relative to each other and move one
 * offset further each time the same frames are pasted, so pastes never stack on one spot.
 * `at` puts the first one there instead (paste on top of, or in place of, a frame).
 */
export function pastedFrames(
  copied: readonly DesignFrame[],
  existing: readonly Pick<DesignFrame, "x" | "y">[],
  at?: Point,
): DesignFrame[] {
  const first = copied[0];
  if (!first) return [];
  let dx = at ? at.x - first.x : PASTE_OFFSET;
  let dy = at ? at.y - first.y : PASTE_OFFSET;
  if (!at)
    while (existing.some((frame) => frame.x === first.x + dx && frame.y === first.y + dy)) {
      dx += PASTE_OFFSET;
      dy += PASTE_OFFSET;
    }
  return copied.map((frame) => ({
    ...structuredClone(frame),
    id: canvasId("frame"),
    title: `${frame.title} copy`,
    x: frame.x + dx,
    y: frame.y + dy,
    revision: 1,
  }));
}

/** Where a paste goes: inside or beside the selection, on top of it, or in its place. */
export type CanvasPasteMode = "normal" | "on-top" | "replace";

/**
 * A copied frame comes back as a new frame: its shell is restored empty, then its style and
 * layers arrive through the sanitizing operations like any other insert.
 */
async function pasteFrames(
  editor: CanvasEditorApi,
  frames: readonly DesignFrame[],
  at?: Point,
): Promise<string[]> {
  const placed = pastedFrames(frames, editor.page.frames, at);
  const shells = placed.map((frame) => ({ ...frame, style: "", layers: { roots: [], nodes: [] } }));
  if (!(await editor.run({ kind: "restore", frames: shells, removeFrameIds: [] }))) return [];
  for (const frame of placed) {
    const operations: DesignLayerEdit[] = [];
    const style = Object.fromEntries(declaredStyles(frame.style ?? ""));
    if (Object.keys(style).length) operations.push({ type: "set_frame_styles", styles: style });
    if (frame.layers.roots.length)
      operations.push({
        type: "insert_html",
        parentId: null,
        html: serializeDesignLayers(frame.layers, false),
      });
    if (operations.length) await editor.run({ kind: "edit", frameId: frame.id, operations });
  }
  return placed.map((frame) => frame.id);
}

/** The HTML a paste inserts, with the first root placed at `position` when both are free. */
function pasteHtml(content: Exclude<ClipboardContent, { kind: "image" }>, position?: Point) {
  if (content.kind === "text") return textToHtml(content.text);
  if (content.kind === "html") return content.html;
  if (content.kind === "svg") return content.svg;
  const trees = content.tree.layers.length
    ? content.tree.layers
    : content.tree.frames.map((frame) => frame.layers);
  return trees
    .map((tree, at) => {
      const root = tree.nodes.find((node) => node.id === tree.roots[0]);
      const free =
        at === 0 &&
        position &&
        root?.type === "element" &&
        /^(absolute|fixed)$/.test(
          declaredStyles(root.attributes.style ?? "").get("position") ?? "",
        );
      return serializeDesignLayers(
        free ? restyledRoot(tree, { left: `${position.x}px`, top: `${position.y}px` }) : tree,
        false,
      );
    })
    .join("");
}

/** A free layer's `left`/`top`, so a paste on top of it or in its place lands where it is. */
function freePosition(editor: CanvasEditorApi, item: LayerItem): Point | undefined {
  const node = editor.layers(item.frameId)?.nodes.get(item.layerId);
  if (node?.type !== "element") return undefined;
  const declared = declaredStyles(node.attributes.style ?? "");
  if (!/^(absolute|fixed)$/.test(declared.get("position") ?? "")) return undefined;
  const left = Number.parseFloat(declared.get("left") ?? "");
  const top = Number.parseFloat(declared.get("top") ?? "");
  return Number.isFinite(left) && Number.isFinite(top) ? { x: left, y: top } : undefined;
}

/**
 * Pastes clipboard content. Copied frames come back as new frames, further each time;
 * layers, HTML and text go inside the selected container (beside a selected text layer), on
 * top of the selection (⌘⇧V) or in its place (⌘⇧R); with nothing selected they become a new
 * frame around `center`, a world point. Each paste is one undo step.
 */
export async function pasteIntoCanvas(
  editor: CanvasEditorApi,
  commands: CanvasCommands,
  content: ClipboardContent,
  center: Point,
  mode: CanvasPasteMode = "normal",
): Promise<void> {
  if (editor.readOnly) return;
  if (content.kind === "image") return void (await commands.placeImage(content.file, null, center));
  const target = editor.selection[0];
  await editor.batch(async () => {
    if (content.kind === "tree" && content.tree.frames.length && content.tree.layers.length === 0) {
      const frame =
        target?.kind === "frame" && mode !== "normal" ? editor.frame(target.frameId) : undefined;
      const ids = await pasteFrames(
        editor,
        content.tree.frames,
        frame ? { x: frame.x, y: frame.y } : undefined,
      );
      if (frame && mode === "replace" && ids.length)
        await editor.run({ kind: "layout", frames: [{ id: frame.id, remove: true }] });
      if (ids.length) editor.select(ids.map((frameId) => ({ kind: "frame", frameId })));
      return;
    }
    if (!target) {
      await commands.createFrame(
        {
          x: center.x - PASTE_FRAME.width / 2,
          y: center.y - PASTE_FRAME.height / 2,
          ...PASTE_FRAME,
        },
        pasteHtml(content),
      );
      return;
    }
    const index = editor.layers(target.frameId);
    const frame = editor.frame(target.frameId);
    if (!index || !frame) return;
    if (mode !== "normal" && isLayerItem(target)) {
      // On top: the next sibling up in paint order. Replace: the same slot, the old layer gone.
      const place = placementOf(frame.layers, target.layerId);
      const position = freePosition(editor, target);
      const result = await editor.run({
        kind: "edit",
        frameId: target.frameId,
        operations: [
          { type: "insert_html", ...place, html: pasteHtml(content, position) },
          ...(mode === "replace" ? [{ type: "delete" as const, nodeId: target.layerId }] : []),
        ],
      });
      const created = result?.createdNodeIds[0];
      if (created) editor.select([{ kind: "layer", frameId: target.frameId, layerId: created }]);
      return;
    }
    // Beside a layer that cannot hold others (text, an image, an inline SVG), else inside.
    const parentId =
      target.kind === "frame"
        ? null
        : holdsLayers(index, target.layerId)
          ? target.layerId
          : (index.parent.get(target.layerId) ?? null);
    await commands.insertIntoFrame(target.frameId, pasteHtml(content), { parentId, select: true });
  });
}

/** Large images are re-encoded smaller so they fit a canvas asset (2 MiB). */
export async function prepareCanvasImage(
  file: File,
  workId: string,
): Promise<{ input: CanvasImportImageInput; width: number; height: number }> {
  if (!IMAGE_TYPES.has(file.type)) throw new Error("Use a PNG, JPEG, WebP or GIF image.");
  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;
  let blob: Blob = file;
  try {
    if (file.size > MAX_IMAGE_BYTES) {
      const canvas = document.createElement("canvas");
      for (let scale = Math.min(1, 4096 / Math.max(width, height)); scale > 0.05; scale *= 0.75) {
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (result) => (result ? resolve(result) : reject(new Error("Image encoding failed."))),
            "image/webp",
            0.86,
          ),
        );
        if (blob.size <= MAX_IMAGE_BYTES) break;
      }
      width = canvas.width;
      height = canvas.height;
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    bitmap.close();
  }
  if (blob.size > MAX_IMAGE_BYTES) throw new Error("This image is too large for the canvas.");
  return {
    input: {
      workId,
      assetId: canvasId("img"),
      name: (file.name || "Image").slice(0, 120),
      mimeType: blob.type as CanvasImportImageInput["mimeType"],
      data: await blobToBase64(blob),
    },
    width,
    height,
  };
}
