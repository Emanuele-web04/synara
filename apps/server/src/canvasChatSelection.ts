import type { CanvasChatSelectionInput, CanvasWork, ThreadId } from "@synara/contracts";

const SELECTION_TTL_MS = 30 * 60 * 1000;
const selections = new Map<string, CanvasChatSelectionInput & { updatedAt: number }>();

/** Ephemeral: the canvas selection a chat's composer shows as a chip. Never persisted. */
export function setCanvasChatSelection(input: CanvasChatSelectionInput): void {
  if (input.items.length === 0) selections.delete(input.threadId);
  else selections.set(input.threadId, { ...input, updatedAt: Date.now() });
}

export function readCanvasChatSelection(threadId: ThreadId) {
  const selection = selections.get(threadId);
  if (!selection) return null;
  if (Date.now() - selection.updatedAt > SELECTION_TTL_MS) {
    selections.delete(threadId);
    return null;
  }
  return selection;
}

/** A selected frame (`layerId` null) or element layer, as identifiers and a tag only. */
export type CanvasSelectedItem = { frameId: string; layerId: string | null; tag: string | null };

/**
 * The selection's items that still exist in `work`, reduced to IDs and element tags: names
 * and text inside designs are untrusted and never leave through here.
 */
export function canvasSelectedItems(
  work: CanvasWork | null,
  selection: Pick<CanvasChatSelectionInput, "pageId" | "items">,
): CanvasSelectedItem[] {
  const page = work?.pages.find((item) => item.id === selection.pageId);
  return selection.items.flatMap((item): CanvasSelectedItem[] => {
    const frame = page?.frames.find((candidate) => candidate.id === item.frameId);
    if (!frame) return [];
    if (item.layerId === null) return [{ frameId: frame.id, layerId: null, tag: null }];
    const layer = frame.layers.nodes.find((node) => node.id === item.layerId);
    return layer?.type === "element"
      ? [{ frameId: frame.id, layerId: layer.id, tag: layer.tag }]
      : [];
  });
}
