// FILE: fixedShortcuts.ts
// Purpose: The chords no keybinding can take: text editing in every field, the system's
//   own, and the few Synara handles itself before any binding is looked up. The handlers
//   for Synara's chords match through this table, and the shortcut editor refuses every
//   entry, so what the editor allows and what actually fires cannot drift apart.
// Layer: Keyboard shortcuts

import type { KeybindingShortcut, KeybindingWhenNode } from "@synara/contracts";

import { matchesShortcut, type ShortcutEventLike } from "./keybindings";
import { isMacPlatform } from "./lib/utils";

export type FixedShortcutId =
  | "navigation.back"
  | "navigation.forward"
  | "search.files"
  | "search.content"
  | "terminal.search";

export interface FixedShortcut {
  readonly id?: FixedShortcutId;
  readonly shortcut: KeybindingShortcut;
  /** Completes "⌘P …" in the editor's message. */
  readonly reason: string;
  /** Holds the chord only while this is true, as a binding's `when` would. */
  readonly whenAst?: KeybindingWhenNode;
  readonly platform?: "mac" | "other";
}

function chord(key: string, modifiers: Partial<Omit<KeybindingShortcut, "key">> = {}) {
  return {
    key,
    modKey: true,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  } satisfies KeybindingShortcut;
}

const alt = { modKey: false, altKey: true };

export const FIXED_SHORTCUTS: readonly FixedShortcut[] = [
  // Text editing, in every field.
  { shortcut: chord("c"), reason: "is reserved for Copy" },
  { shortcut: chord("v"), reason: "is reserved for Paste" },
  { shortcut: chord("x"), reason: "is reserved for Cut" },
  { shortcut: chord("a"), reason: "is reserved for Select All" },
  { shortcut: chord("z"), reason: "is reserved for Undo" },
  { shortcut: chord("z", { shiftKey: true }), reason: "is reserved for Redo" },
  { shortcut: chord("y"), reason: "is reserved for Redo", platform: "other" },
  { shortcut: chord("arrowleft"), reason: "moves to the start of a line", platform: "mac" },
  { shortcut: chord("arrowright"), reason: "moves to the end of a line", platform: "mac" },
  { shortcut: chord("arrowup"), reason: "moves to the start of a field", platform: "mac" },
  { shortcut: chord("arrowdown"), reason: "moves to the end of a field", platform: "mac" },
  { shortcut: chord("backspace"), reason: "deletes to the start of a line", platform: "mac" },
  { shortcut: chord("arrowleft", alt), reason: "moves back one word", platform: "mac" },
  { shortcut: chord("arrowright", alt), reason: "moves forward one word", platform: "mac" },
  { shortcut: chord("backspace", alt), reason: "deletes the previous word", platform: "mac" },
  { shortcut: chord("arrowleft"), reason: "moves back one word", platform: "other" },
  { shortcut: chord("arrowright"), reason: "moves forward one word", platform: "other" },
  { shortcut: chord("backspace"), reason: "deletes the previous word", platform: "other" },
  // The system's own.
  { shortcut: chord("q"), reason: "is reserved by macOS for Quit", platform: "mac" },
  { shortcut: chord("h"), reason: "is reserved by macOS for Hide", platform: "mac" },
  { shortcut: chord("m"), reason: "is reserved by macOS for Minimize", platform: "mac" },
  // Synara's own, handled before any binding.
  { shortcut: chord(","), reason: "always opens Settings" },
  { shortcut: chord("/"), reason: "always opens the keybindings sheet" },
  {
    id: "navigation.back",
    shortcut: chord("["),
    reason: "always goes back in the desktop app",
    platform: "mac",
  },
  {
    id: "navigation.forward",
    shortcut: chord("]"),
    reason: "always goes forward in the desktop app",
    platform: "mac",
  },
  {
    id: "navigation.back",
    shortcut: chord("arrowleft", alt),
    reason: "always goes back in the desktop app",
    platform: "other",
  },
  {
    id: "navigation.forward",
    shortcut: chord("arrowright", alt),
    reason: "always goes forward in the desktop app",
    platform: "other",
  },
  { id: "search.files", shortcut: chord("p"), reason: "always opens file search" },
  {
    id: "search.content",
    shortcut: chord("f", { shiftKey: true }),
    reason: "always opens search in files",
  },
  {
    id: "terminal.search",
    shortcut: chord("f"),
    reason: "searches the terminal while it has focus",
    whenAst: { type: "identifier", name: "terminalFocus" },
  },
];

/** The fixed chords that exist on `platform`. */
export function fixedShortcutsForPlatform(platform: string): FixedShortcut[] {
  const isMac = isMacPlatform(platform);
  return FIXED_SHORTCUTS.filter(
    (entry) => entry.platform === undefined || entry.platform === (isMac ? "mac" : "other"),
  );
}

/** Whether a key press is the fixed chord `id` on `platform`. */
export function matchesFixedShortcut(
  event: ShortcutEventLike,
  id: FixedShortcutId,
  platform = navigator.platform,
): boolean {
  return fixedShortcutsForPlatform(platform).some(
    (entry) => entry.id === id && matchesShortcut(event, entry.shortcut, platform),
  );
}
