import type {
  CanvasCommentThread,
  CanvasExportEntry,
  CanvasFrameLayoutPatch,
  CanvasPage,
  DesignFrame,
  DesignLayerEdit,
  DesignLayerTree,
} from "@synara/contracts";
import {
  declaredStyles,
  designLayerSubtree,
  designStyleKey,
} from "@synara/shared/designCanvasLayers";
import type { CanvasSelectionItem } from "../canvasStores";

/** A change the editor can send and later invert. Only the user's own changes are recorded. */
export type CanvasChange =
  | { kind: "edit"; frameId: string; operations: readonly DesignLayerEdit[] }
  /** Selection changes are undo steps; nothing is sent. */
  | { kind: "selection"; items: readonly CanvasSelectionItem[] }
  | {
      kind: "layout";
      frames: readonly CanvasFrameLayoutPatch[];
      /** The page's frames in a new paint order (a layers panel reorder). */
      order?: readonly string[];
    }
  | {
      kind: "restore";
      frames: readonly DesignFrame[];
      removeFrameIds: readonly string[];
      /** Comment threads of restored frames, which removing a frame deletes with it. */
      comments?: readonly CanvasCommentThread[];
    }
  | { kind: "exports"; settings: readonly CanvasExportSettingsPatch[] };

/** Replaces one node's export rows; null removes them. */
export type CanvasExportSettingsPatch = {
  key: string;
  entries: readonly CanvasExportEntry[] | null;
};

/**
 * One sent change and what reverts it. `undo` can need more than one change (a removed frame
 * comes back, then its export rows); `redo` puts the step's result back from any part of it.
 */
export type CanvasHistoryStep = {
  undo: readonly CanvasChange[];
  redo: readonly CanvasChange[];
};

/** One user action. The steps of one gesture or command undo (last first) and redo together. */
export type CanvasHistoryEntry = {
  pageId: string;
  steps: readonly CanvasHistoryStep[];
};

const parentOf = (tree: DesignLayerTree, id: string) => {
  for (const node of tree.nodes)
    if (node.type === "element" && node.children.includes(id)) return node;
  return null;
};

/** The parent and following sibling that put `id` back exactly where it is now. */
export function placementOf(tree: DesignLayerTree, id: string) {
  const parent = parentOf(tree, id);
  const siblings = parent?.children ?? tree.roots;
  const next = siblings[siblings.indexOf(id) + 1];
  return { parentId: parent?.id ?? null, ...(next ? { beforeId: next } : {}) };
}

/** The subtree rooted at `id`, as a standalone forest with the same IDs. */
export const subtreeOf = designLayerSubtree;

const layerOf = (tree: DesignLayerTree, id: string) => tree.nodes.find((node) => node.id === id);

const styleKey = designStyleKey;

/**
 * Inverse operations computed from the frame as it was before `operations` ran. Style edits
 * restore the whole previous style attribute, which is exact even for shorthand properties.
 */
export function invertEdit(
  frame: DesignFrame,
  operations: readonly DesignLayerEdit[],
  createdNodeIds: readonly string[],
  after: DesignFrame,
): DesignLayerEdit[] {
  const inverse: DesignLayerEdit[] = [];
  // `createdNodeIds` covers every insert of the edit: they are removed once, not per insert.
  let insertsInverted = false;
  for (const operation of operations) {
    switch (operation.type) {
      case "set_text": {
        const node = layerOf(frame.layers, operation.nodeId);
        if (node?.type === "text")
          inverse.unshift({ type: "set_text", nodeId: node.id, text: node.text });
        break;
      }
      case "set_styles": {
        const node = layerOf(frame.layers, operation.nodeId);
        if (node?.type !== "element") break;
        // Per property, so undo never discards what an agent changed on the same layer since.
        const declared = declaredStyles(node.attributes.style ?? "");
        inverse.unshift({
          type: "set_styles",
          nodeId: node.id,
          styles: Object.fromEntries(
            Object.keys(operation.styles).map((key) => [key, declared.get(styleKey(key)) ?? null]),
          ),
        });
        break;
      }
      case "set_attributes": {
        const node = layerOf(frame.layers, operation.nodeId);
        if (node?.type !== "element") break;
        inverse.unshift({
          type: "set_attributes",
          nodeId: node.id,
          attributes: Object.fromEntries(
            Object.keys(operation.attributes).map((key) => [key, node.attributes[key] ?? null]),
          ),
        });
        break;
      }
      case "set_frame_styles": {
        const declared = declaredStyles(frame.style ?? "");
        inverse.unshift({
          type: "set_frame_styles",
          styles: Object.fromEntries(
            Object.keys(operation.styles).map((key) => [key, declared.get(styleKey(key)) ?? null]),
          ),
        });
        break;
      }
      case "move": {
        if (layerOf(frame.layers, operation.nodeId))
          inverse.unshift({
            type: "move",
            nodeId: operation.nodeId,
            ...placementOf(frame.layers, operation.nodeId),
          });
        break;
      }
      case "delete": {
        if (layerOf(frame.layers, operation.nodeId))
          inverse.unshift({
            type: "insert_layers",
            ...placementOf(frame.layers, operation.nodeId),
            layers: subtreeOf(frame.layers, operation.nodeId),
          });
        break;
      }
      case "insert_html":
      case "insert_layers": {
        if (insertsInverted) break;
        insertsInverted = true;
        const created = new Set(createdNodeIds);
        // Remove only the inserted roots; their descendants go with them.
        for (const id of createdNodeIds) {
          const parent = parentOf(after.layers, id);
          if (!parent || !created.has(parent.id)) inverse.unshift({ type: "delete", nodeId: id });
        }
        break;
      }
    }
  }
  return inverse;
}

/**
 * Redo replays inserts with their original IDs, so later undo entries that reference those
 * layers keep working.
 */
export function replayableEdit(
  operations: readonly DesignLayerEdit[],
  createdNodeIds: readonly string[],
  after: DesignFrame,
): DesignLayerEdit[] {
  if (!operations.some((operation) => operation.type === "insert_html")) return [...operations];
  // Layers inserted with their IDs replay as they are; the HTML imports' layers replay once.
  const withIds = new Set(
    operations.flatMap((operation) =>
      operation.type === "insert_layers" ? operation.layers.nodes.map((node) => node.id) : [],
    ),
  );
  const created = new Set(createdNodeIds.filter((id) => !withIds.has(id)));
  let replayed = false;
  return operations.flatMap((operation): DesignLayerEdit[] => {
    if (operation.type !== "insert_html") return [operation];
    if (replayed) return [];
    replayed = true;
    return [...created]
      .filter((id) => {
        const parent = parentOf(after.layers, id);
        return !parent || !created.has(parent.id);
      })
      .map((id) => ({
        type: "insert_layers",
        ...placementOf(after.layers, id),
        layers: subtreeOf(after.layers, id),
      }));
  });
}

type PageState = Pick<CanvasPage, "frames" | "comments" | "exportSettings">;

/** The export rows of a page that `owned` claims, as a patch that puts them back. */
function exportRowsBack(
  page: Pick<CanvasPage, "exportSettings">,
  owned: (frameId: string, layerId: string | undefined) => boolean,
): CanvasChange[] {
  const settings = Object.entries(page.exportSettings ?? {}).flatMap(([key, entries]) => {
    const [, frameId, layerId] = key.split(":");
    return frameId && owned(frameId, layerId) ? [{ key, entries }] : [];
  });
  return settings.length ? [{ kind: "exports", settings }] : [];
}

/**
 * Frames that `remove` drops come back with the comment threads and export rows the server
 * deleted with them. The rows follow the frames, which they need to exist.
 */
function restoreRemovedFrames(page: PageState, removeIds: ReadonlySet<string>): CanvasChange[] {
  const frames = page.frames.filter((frame) => removeIds.has(frame.id));
  if (frames.length === 0) return [];
  const comments = page.comments.filter((thread) => removeIds.has(thread.frameId));
  return [
    {
      kind: "restore",
      frames,
      removeFrameIds: [],
      ...(comments.length ? { comments } : {}),
    },
    ...exportRowsBack(page, (frameId) => removeIds.has(frameId)),
  ];
}

/** Undo of a layout write: geometry, titles and flags back, removed frames restored whole. */
export function invertLayout(
  page: PageState,
  patches: readonly CanvasFrameLayoutPatch[],
  order?: readonly string[],
): CanvasChange[] {
  const removed = new Set(patches.filter((patch) => patch.remove).map((patch) => patch.id));
  if (removed.size > 0) return restoreRemovedFrames(page, removed);
  return [
    {
      kind: "layout",
      ...(order ? { order: page.frames.map((frame) => frame.id) } : {}),
      frames: patches.flatMap((patch) => {
        const frame = page.frames.find((item) => item.id === patch.id);
        if (!frame) return [];
        return [
          {
            id: frame.id,
            ...(patch.x !== undefined ? { x: frame.x } : {}),
            ...(patch.y !== undefined ? { y: frame.y } : {}),
            ...(patch.width !== undefined ? { width: frame.width } : {}),
            ...(patch.height !== undefined ? { height: frame.height } : {}),
            ...(patch.title !== undefined ? { title: frame.title } : {}),
            ...(patch.hidden !== undefined ? { hidden: frame.hidden === true } : {}),
            ...(patch.locked !== undefined ? { locked: frame.locked === true } : {}),
          },
        ];
      }),
    },
  ];
}

/** Undo of a frame restore: replaced frames back as they were, created frames removed. */
export function invertRestore(
  page: PageState,
  change: Extract<CanvasChange, { kind: "restore" }>,
): CanvasChange[] {
  const existing = new Set(page.frames.map((frame) => frame.id));
  const removed = new Set(change.removeFrameIds);
  const replaced = page.frames.filter(
    (frame) => !removed.has(frame.id) && change.frames.some((item) => item.id === frame.id),
  );
  const created = change.frames.filter((frame) => !existing.has(frame.id)).map((frame) => frame.id);
  return [
    ...(replaced.length || created.length
      ? [{ kind: "restore" as const, frames: replaced, removeFrameIds: created }]
      : []),
    ...restoreRemovedFrames(page, removed),
  ];
}

/**
 * Export rows of the layers an edit deletes (and their descendants). Editing keeps them, but
 * the next layout write drops rows of missing layers, so the undo of a delete puts them back.
 */
export function deletedLayerRows(
  page: Pick<CanvasPage, "exportSettings">,
  frame: DesignFrame,
  operations: readonly DesignLayerEdit[],
): CanvasChange[] {
  const deleted = new Set<string>();
  for (const operation of operations)
    if (operation.type === "delete")
      for (const node of subtreeOf(frame.layers, operation.nodeId).nodes) deleted.add(node.id);
  if (deleted.size === 0) return [];
  return exportRowsBack(
    page,
    (frameId, layerId) => frameId === frame.id && layerId !== undefined && deleted.has(layerId),
  );
}

export function invertExportSettings(
  page: Pick<CanvasPage, "exportSettings">,
  settings: readonly CanvasExportSettingsPatch[],
): CanvasChange {
  return {
    kind: "exports",
    settings: settings.map((patch) => ({
      key: patch.key,
      entries: page.exportSettings?.[patch.key] ?? null,
    })),
  };
}

const MAX_HISTORY = 200;

/** A bounded linear history of one work: a new change clears redo. */
export class CanvasHistory {
  private past: CanvasHistoryEntry[] = [];
  private future: CanvasHistoryEntry[] = [];
  push(entry: CanvasHistoryEntry) {
    this.past.push(entry);
    if (this.past.length > MAX_HISTORY) this.past.shift();
    this.future = [];
  }
  takeUndo() {
    const entry = this.past.pop();
    if (entry) this.future.push(entry);
    return entry;
  }
  takeRedo() {
    const entry = this.future.pop();
    if (entry) this.past.push(entry);
    return entry;
  }
  /** Moves the newest redo entry back to undo (its undo did not happen), and vice versa. */
  returnUndo() {
    const entry = this.future.pop();
    if (entry) this.past.push(entry);
  }
  returnRedo() {
    const entry = this.past.pop();
    if (entry) this.future.push(entry);
  }
  /** A replay that could not be reverted either is dropped rather than retried forever. */
  discardLastRedo() {
    this.future.pop();
  }
  discardLastUndo() {
    this.past.pop();
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
}

/**
 * One editor's way into a work's history. Its groups (one gesture or command) collect only
 * that editor's steps, so another editor on the same work never lands inside them.
 */
export class CanvasHistoryRecorder {
  private depth = 0;
  private group: { pageId: string; steps: CanvasHistoryStep[] } | null = null;
  constructor(readonly history: CanvasHistory) {}
  record(pageId: string, step: CanvasHistoryStep) {
    if (this.depth === 0) return this.history.push({ pageId, steps: [step] });
    (this.group ??= { pageId, steps: [] }).steps.push(step);
  }
  open() {
    this.depth++;
  }
  /** Drops what the open group collected: the action it was recording came to nothing. */
  discard() {
    if (this.group) this.group.steps = [];
  }
  close() {
    if (this.depth === 0 || --this.depth > 0) return;
    const group = this.group;
    this.group = null;
    if (group?.steps.length) this.history.push(group);
  }
}

export type CanvasReplayResult =
  | { status: "empty" | "done" }
  | { status: "failed"; cause: unknown; reverted: boolean };

/**
 * Undoes or redoes one entry. When a change fails part-way, every step it touched is put
 * back the other way, so the document never keeps half an undo; the entry then stays where
 * it was, to be retried. Only when that revert fails too is the entry dropped.
 */
export async function replayCanvasHistory(
  history: CanvasHistory,
  direction: "undo" | "redo",
  apply: (change: CanvasChange, pageId: string) => Promise<unknown>,
): Promise<CanvasReplayResult> {
  const entry = direction === "undo" ? history.takeUndo() : history.takeRedo();
  if (!entry) return { status: "empty" };
  const steps = direction === "undo" ? entry.steps.toReversed() : entry.steps;
  const touched: CanvasHistoryStep[] = [];
  try {
    for (const step of steps) {
      let started = false;
      for (const change of step[direction]) {
        await apply(change, entry.pageId);
        if (!started) touched.push(step);
        started = true;
      }
    }
    return { status: "done" };
  } catch (cause) {
    const back = direction === "undo" ? "redo" : "undo";
    try {
      for (const step of touched.toReversed())
        for (const change of step[back]) await apply(change, entry.pageId);
    } catch {
      if (direction === "undo") history.discardLastRedo();
      else history.discardLastUndo();
      return { status: "failed", cause, reverted: false };
    }
    if (direction === "undo") history.returnUndo();
    else history.returnRedo();
    return { status: "failed", cause, reverted: true };
  }
}

/** Unused histories are kept this long, so switching the pane to the full layout keeps one. */
export const CANVAS_HISTORY_GRACE_MS = 60_000;

const histories = new Map<
  string,
  { history: CanvasHistory; holders: number; drop: ReturnType<typeof setTimeout> | undefined }
>();

/** The undo history of a work, shared by every editor open on it in this window. */
export function canvasHistoryFor(workId: string): CanvasHistory {
  let held = histories.get(workId);
  if (!held)
    histories.set(workId, (held = { history: new CanvasHistory(), holders: 0, drop: undefined }));
  return held.history;
}

/** Keeps a work's history while an editor shows it; it is forgotten after the last one goes. */
export function holdCanvasHistory(workId: string): () => void {
  canvasHistoryFor(workId);
  const held = histories.get(workId)!;
  clearTimeout(held.drop);
  held.drop = undefined;
  held.holders++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--held.holders > 0) return;
    held.drop = setTimeout(() => {
      if (histories.get(workId) === held && held.holders === 0) histories.delete(workId);
    }, CANVAS_HISTORY_GRACE_MS);
  };
}
