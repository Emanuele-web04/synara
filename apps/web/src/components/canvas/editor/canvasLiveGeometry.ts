// FILE: canvasLiveGeometry.ts
// Purpose: Where a canvas gesture has put the items it moves or resizes, before the save lands,
//          for readers outside the canvas (the inspector's X, Y, W and H). A small external
//          store: gestures write it per pointer move without rendering the canvas, and only the
//          components that subscribe re-render.
// Layer: Canvas editor state
// Exports: canvasLiveGeometry, useCanvasLiveGeometry, LiveGeometry

import { useSyncExternalStore } from "react";

/**
 * An item's live geometry, keyed by selection key. Frames: world x, y, width and height.
 * Layers: `x`/`y` are the `left`/`top` a free layer is being moved to, `width`/`height` its
 * size while it is resized.
 */
export type LiveGeometry = Readonly<Partial<Record<"x" | "y" | "width" | "height", number>>>;

type Snapshot = ReadonlyMap<string, LiveGeometry>;

const EMPTY: Snapshot = new Map();
let snapshot: Snapshot = EMPTY;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

export const canvasLiveGeometry = {
  /** Replaces what is live with these entries (one gesture at a time). */
  set(entries: Iterable<readonly [string, LiveGeometry]>) {
    snapshot = new Map(entries);
    notify();
  },
  clear() {
    if (snapshot === EMPTY) return;
    snapshot = EMPTY;
    notify();
  },
  get: (): Snapshot => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** The live geometry of every item a gesture is changing (empty while none runs). */
export function useCanvasLiveGeometry(): Snapshot {
  return useSyncExternalStore(canvasLiveGeometry.subscribe, canvasLiveGeometry.get, () => EMPTY);
}
