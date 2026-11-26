// FILE: editorRailStore.ts
// Purpose: The editor view's Files / Diff / Search items for the fixed rail.
//          The editor workspace publishes them while it is mounted; the rail
//          renders them as a group under the fixed items, so the editor view
//          has one icon column instead of its own activity bar next to the rail.
// Layer: Web UI store (per window, not persisted)
// Exports: useEditorRailStore, EditorRailItem

import type { ComponentType } from "react";
import { create } from "zustand";

import type { EditorActivityBarItem } from "./lib/editorCenterMode";

export interface EditorRailItem {
  readonly id: EditorActivityBarItem;
  readonly glyph: ComponentType<{ className?: string }>;
  readonly label: string;
  readonly active: boolean;
  readonly onSelect: () => void;
}

interface EditorRailState {
  /** Null while no editor view is mounted. */
  items: ReadonlyArray<EditorRailItem> | null;
  publish: (items: ReadonlyArray<EditorRailItem>) => void;
  clear: () => void;
}

export const useEditorRailStore = create<EditorRailState>((set) => ({
  items: null,
  publish: (items) => set({ items }),
  clear: () => set({ items: null }),
}));
