import type { CanvasExportEntry } from "@synara/contracts";
import type { CanvasCodeFlavor } from "@synara/shared/designCanvasCode";
import type { t as translate } from "~/i18n";
import { downloadBlob } from "~/lib/browserDownload";
import type { CanvasExportTarget } from "~/lib/canvasExport";
import {
  combinedPdfOrder,
  combinedPdfQuality,
  defaultExportEntry,
  exportFileName,
  preferredExportFormat,
  textExportLabel,
} from "~/lib/canvasExportSettings";
import { toastManager } from "../../ui/toast";
import { loadCanvasAssets } from "../canvasAssets";
import { selectionKey, type CanvasSelectionItem } from "../canvasStores";
import type { CanvasEditorApi } from "./CanvasEditorContext";
import { isTextOnly, layerLabel } from "./canvasSelection";

/** A frame or layer ready to render, with its box on the canvas for ordering and copying. */
export type CanvasExportNode = {
  item: CanvasSelectionItem;
  label: string;
  target: CanvasExportTarget;
  origin: { x: number; y: number };
};

/** The rows saved on a node, kept in each node's own data. */
export const exportEntriesOf = (editor: CanvasEditorApi, item: CanvasSelectionItem) =>
  editor.page.exportSettings?.[selectionKey(item)];

/** The file label: the layer name, else the first 20 characters of its text. */
export function exportNodeLabel(editor: CanvasEditorApi, item: CanvasSelectionItem): string {
  const frame = editor.frame(item.frameId);
  if (item.kind === "frame") return frame?.title ?? "Frame";
  const index = editor.layers(item.frameId);
  const node = index?.nodes.get(item.layerId);
  if (!index || !node) return frame?.title ?? "Layer";
  if (node.type === "element" && node.attributes["data-name"]?.trim())
    return node.attributes["data-name"].trim();
  const text =
    node.type === "text"
      ? node.text
      : isTextOnly(index, node.id)
        ? node.children
            .map((child) => index.nodes.get(child))
            .map((child) => (child?.type === "text" ? child.text : ""))
            .join(" ")
        : "";
  return text.trim() ? textExportLabel(text) : layerLabel(index, item.layerId);
}

/**
 * What to render for each item. A layer's rectangle comes from the live layout, converted
 * to frame pixels, so the export matches what the canvas shows.
 */
export function exportNodes(
  editor: CanvasEditorApi,
  items: readonly CanvasSelectionItem[],
): CanvasExportNode[] {
  return items.flatMap((item): CanvasExportNode[] => {
    const frame = editor.frame(item.frameId);
    if (!frame) return [];
    const label = exportNodeLabel(editor, item);
    if (item.kind === "frame")
      return [
        {
          item,
          label,
          target: {
            frame,
            layerId: null,
            rect: { x: 0, y: 0, width: frame.width, height: frame.height },
          },
          origin: { x: frame.x, y: frame.y },
        },
      ];
    const root = editor.elementFor({ kind: "frame", frameId: item.frameId });
    const element = editor.elementFor(item);
    if (!root || !element) return [];
    const frameBox = root.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const scale = frameBox.width / frame.width || 1;
    const rect = {
      x: (box.left - frameBox.left) / scale,
      y: (box.top - frameBox.top) / scale,
      width: box.width / scale,
      height: box.height / scale,
    };
    if (rect.width < 1 || rect.height < 1) return [];
    return [
      {
        item,
        label,
        target: { frame, layerId: item.layerId, rect },
        origin: { x: frame.x + rect.x, y: frame.y + rect.y },
      },
    ];
  });
}

/** ⌘⇧E: the selection, else every node on the page that has export rows. */
export function exportShortcutItems(editor: CanvasEditorApi): CanvasSelectionItem[] {
  if (editor.selection.length > 0) return [...editor.selection];
  return Object.keys(editor.page.exportSettings ?? {}).flatMap((key): CanvasSelectionItem[] => {
    const [kind, frameId, layerId] = key.split(":");
    if (!frameId || !editor.frame(frameId)) return [];
    if (kind === "frame") return [{ kind: "frame", frameId }];
    return layerId && editor.layers(frameId)?.nodes.has(layerId)
      ? [{ kind: "layer", frameId, layerId }]
      : [];
  });
}

/**
 * Every node × every row becomes its own file, one after another. Nodes without rows use
 * the default row. Returns the number of files saved.
 */
export async function exportNodeFiles(
  editor: CanvasEditorApi,
  items: readonly CanvasSelectionItem[],
): Promise<number> {
  const nodes = exportNodes(editor, items);
  if (nodes.length === 0) return 0;
  const { exportCanvasTarget, exportCanvasTargetsPdf } = await import("~/lib/canvasExport");
  const assets = await loadCanvasAssets(editor.work.id, editor.work.assets);
  const fallback: readonly CanvasExportEntry[] = [defaultExportEntry(preferredExportFormat())];
  let files = 0;
  for (const node of nodes) {
    const entries = exportEntriesOf(editor, node.item) ?? fallback;
    for (const entry of entries) {
      const blob =
        entry.format === "pdf"
          ? await exportCanvasTargetsPdf([node.target], assets, entry.quality ?? "high", node.label)
          : await exportCanvasTarget(node.target, assets, entry.scale, entry.format);
      downloadBlob(blob, exportFileName(node.label, entry.suffix, entry.format));
      files++;
    }
  }
  return files;
}

/** "Export combined PDF": one page per node, in reading order. */
export async function exportCombinedPdf(
  editor: CanvasEditorApi,
  items: readonly CanvasSelectionItem[],
): Promise<number> {
  const nodes = combinedPdfOrder(
    exportNodes(editor, items).map((node) => ({
      node,
      box: { ...node.origin, width: node.target.rect.width, height: node.target.rect.height },
    })),
  ).map(({ node }) => node);
  if (nodes.length === 0) return 0;
  const { exportCanvasTargetsPdf } = await import("~/lib/canvasExport");
  const quality = combinedPdfQuality(nodes.map((node) => exportEntriesOf(editor, node.item)));
  const label = nodes.length === 1 ? nodes[0]!.label : "Combined";
  downloadBlob(
    await exportCanvasTargetsPdf(
      nodes.map((node) => node.target),
      await loadCanvasAssets(editor.work.id, editor.work.assets),
      quality,
      label,
    ),
    exportFileName(label, "", "pdf"),
  );
  return 1;
}

/** ⇧⌘C: the selection at the screen's pixel ratio, composited when several. */
export async function copySelectionAsPng(
  editor: CanvasEditorApi,
  items: readonly CanvasSelectionItem[],
) {
  const nodes = exportNodes(editor, items);
  if (nodes.length === 0) return false;
  const { exportCanvasComposite } = await import("~/lib/canvasExport");
  // The promise form keeps the user gesture while the assets load and the image renders.
  await navigator.clipboard.write([
    new ClipboardItem({
      "image/png": loadCanvasAssets(editor.work.id, editor.work.assets).then((assets) =>
        exportCanvasComposite(
          nodes.map(({ target, origin }) => ({ target, origin })),
          assets,
          Math.max(1, window.devicePixelRatio || 1),
        ),
      ),
    }),
  ]);
  return true;
}

/** ⌥R and ⌥T: one node as a React component, with inline styles or Tailwind. */
export async function copySelectionAsCode(
  editor: CanvasEditorApi,
  item: CanvasSelectionItem,
  flavor: CanvasCodeFlavor,
) {
  const frame = editor.frame(item.frameId);
  if (!frame) return false;
  const { canvasNodeToReact } = await import("@synara/shared/designCanvasCode");
  await navigator.clipboard.writeText(
    canvasNodeToReact({
      frame,
      layerId: item.kind === "layer" ? item.layerId : null,
      flavor,
      title: `${editor.work.title} / ${exportNodeLabel(editor, item)}`,
      date: new Date(),
    }),
  );
  return true;
}

const clipboardDenied = (cause: unknown) =>
  cause instanceof DOMException && cause.name === "NotAllowedError";

/** The shared feedback for export and copy commands, wherever they are started. */
export function makeCanvasExportActions(editor: CanvasEditorApi, t: typeof translate) {
  const failed = (title: string) => (cause: unknown) =>
    toastManager.add({
      type: "error",
      title: clipboardDenied(cause) ? t("workspace:canvasClipboardDenied") : title,
      description: clipboardDenied(cause) || !(cause instanceof Error) ? undefined : cause.message,
    });
  const exported = (files: number) => {
    if (files > 0)
      toastManager.add({
        type: "success",
        title: t("workspace:canvasExportedFiles", { count: files }),
      });
  };
  return {
    exportFiles: (items: readonly CanvasSelectionItem[]) =>
      exportNodeFiles(editor, items).then(exported, failed(t("workspace:canvasExportFailed"))),
    exportCombinedPdf: (items: readonly CanvasSelectionItem[]) =>
      exportCombinedPdf(editor, items).then(exported, failed(t("workspace:canvasExportFailed"))),
    copyPng: (items: readonly CanvasSelectionItem[]) =>
      copySelectionAsPng(editor, items).then(
        (copied) => {
          if (copied) toastManager.add({ type: "success", title: t("workspace:canvasCopiedPng") });
        },
        failed(t("workspace:canvasCopyPngFailed")),
      ),
    copyCode: (item: CanvasSelectionItem, flavor: CanvasCodeFlavor) =>
      copySelectionAsCode(editor, item, flavor).then(
        (copied) => {
          if (copied)
            toastManager.add({
              type: "success",
              title:
                flavor === "css"
                  ? t("workspace:canvasCopiedReact")
                  : t("workspace:canvasCopiedTailwind"),
            });
        },
        failed(t("workspace:canvasCopyCodeFailed")),
      ),
  };
}
