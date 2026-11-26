// FILE: canvasTextSession.ts
// Purpose: The text block being edited in place, for readers outside the canvas. The inspector's
//          Text, Underline and Text stroke sections read the selected range through it and style
//          that range (or the whole block) through the open edit, which saves it all as one step
//          when editing ends. A small external store like canvasLiveGeometry: a caret move
//          re-renders only the inspector sections that subscribe, never the canvas. It also tells
//          the edit when a press or a focus move went to the inspector, so editing stays open.
// Layer: Canvas editor state
// Exports: canvasTextSession, useCanvasTextSession, CanvasTextSession, CanvasTextSegment

import { useSyncExternalStore } from "react";
import type { LayerItem } from "./canvasSelection";

/** One element the selected characters sit in: a styled range, or the block's own text. */
export type CanvasTextSegment = {
  element: HTMLElement;
  /** The range's stored declarations; empty for the block's own text. */
  style: string;
};

export type CanvasTextSession = {
  item: LayerItem;
  /** The block's element. */
  element: HTMLElement;
  /** The elements the selected characters sit in, or null when nothing is selected (a caret). */
  segments: () => CanvasTextSegment[] | null;
  /** Shows a style change on the selected range, or on the whole block, without keeping it. */
  preview: (patch: Readonly<Record<string, string | null>>) => void;
  /** Keeps a style change for the save when editing ends (one undo step with the typing). */
  apply: (patch: Readonly<Record<string, string | null>>) => void;
};

type Snapshot = { session: CanvasTextSession | null; version: number };

const EMPTY: Snapshot = { session: null, version: 0 };
let snapshot: Snapshot = EMPTY;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
/** The last press inside the inspector (its popups included), and when it happened. */
let inspectorPress: { event: Event | null; at: number } = { event: null, at: -Infinity };
/** A press counts for a focus change this soon after it. */
const PRESS_FOCUS_MS = 500;

export const INSPECTOR_ROOT_ATTRIBUTE = "data-canvas-inspector";

export const canvasTextSession = {
  set(session: CanvasTextSession | null) {
    if (snapshot.session === session) return;
    snapshot = { session, version: snapshot.version + 1 };
    notify();
  },
  /** The edit ended: forget it unless another one has taken its place. */
  clear(session: CanvasTextSession) {
    if (snapshot.session === session) canvasTextSession.set(null);
  },
  /** The range or the block's styles changed. */
  changed(session: CanvasTextSession) {
    if (snapshot.session !== session) return;
    snapshot = { session, version: snapshot.version + 1 };
    notify();
  },
  get: (): Snapshot => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /**
   * The inspector saw a press (React delivers its portaled popups' presses there too). Called in
   * the capture phase, so it runs before the edit hears of the press or of the focus it moves.
   */
  notePress(event: Event) {
    inspectorPress = { event, at: performance.now() };
  },
  /** Whether this press went to the inspector. */
  isInspectorPress: (event: Event) => inspectorPress.event === event,
  /** Whether a focus change goes to the inspector: into its panel, or right after a press on it. */
  isInspectorFocus(next: EventTarget | null) {
    if (next instanceof Element && next.closest(`[${INSPECTOR_ROOT_ATTRIBUTE}]`)) return true;
    return performance.now() - inspectorPress.at < PRESS_FOCUS_MS;
  },
};

/** The open text edit, re-read whenever its range or styles change (null while none is open). */
export function useCanvasTextSession(): Snapshot {
  return useSyncExternalStore(canvasTextSession.subscribe, canvasTextSession.get, () => EMPTY);
}
