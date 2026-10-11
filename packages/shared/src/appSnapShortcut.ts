// FILE: appSnapShortcut.ts
// Purpose: Normalize AppSnap's portable two-key shortcut model for desktop and web clients.

import type {
  DesktopAppSnapKeyChord,
  DesktopAppSnapShortcut,
  DesktopAppSnapShortcutModifier,
} from "@synara/contracts";

export const DEFAULT_APP_SNAP_SHORTCUT = {
  kind: "both-option-keys",
} as const satisfies DesktopAppSnapShortcut;

export const APP_SNAP_SHORTCUT_MODIFIERS = [
  "command",
  "control",
  "option",
  "shift",
] as const satisfies ReadonlyArray<DesktopAppSnapShortcutModifier>;

export const APP_SNAP_SHORTCUT_KEYS = [
  ...Array.from({ length: 26 }, (_, index) => `Key${String.fromCharCode(65 + index)}`),
  ...Array.from({ length: 10 }, (_, index) => `Digit${index}`),
  "Space",
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
] as const;

const APP_SNAP_SHORTCUT_KEY_SET = new Set<string>(APP_SNAP_SHORTCUT_KEYS);

const MODIFIER_BY_EVENT_CODE: Readonly<Record<string, DesktopAppSnapShortcutModifier>> = {
  MetaLeft: "command",
  MetaRight: "command",
  ControlLeft: "control",
  ControlRight: "control",
  AltLeft: "option",
  AltRight: "option",
  ShiftLeft: "shift",
  ShiftRight: "shift",
};

const MODIFIER_LABELS: Readonly<Record<DesktopAppSnapShortcutModifier, string>> = {
  command: "⌘ Command",
  control: "⌃ Control",
  option: "⌥ Option",
  shift: "⇧ Shift",
};

const KEY_LABELS: Readonly<Record<string, string>> = {
  Space: "Space",
  Enter: "Return",
  Tab: "Tab",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

const ELECTRON_KEY_NAMES: Readonly<Record<string, string>> = {
  Space: "Space",
  Enter: "Return",
  Tab: "Tab",
  Escape: "Esc",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

// Chords Electron's globalShortcut probe reports as free even though reserving
// them would hijack typing or a universal action in every foreground app.
const SYSTEM_CONTROL_CHORD_ACTIONS: Readonly<Record<string, string>> = {
  KeyC: "interrupts the running program",
  KeyD: "ends input",
  KeyZ: "suspends the running program",
};

const SYSTEM_COMMAND_CHORD_ACTIONS: Readonly<Record<string, string>> = {
  KeyA: "Select All",
  KeyC: "Copy",
  KeyF: "Find",
  KeyH: "Hide",
  KeyM: "Minimize",
  KeyN: "New",
  KeyO: "Open",
  KeyP: "Print",
  KeyQ: "Quit",
  KeyS: "Save",
  KeyT: "New Tab",
  KeyV: "Paste",
  KeyW: "Close Window",
  KeyX: "Cut",
  KeyZ: "Undo",
  Space: "Spotlight",
  Tab: "app switching",
};

const ELECTRON_MODIFIER_NAMES: Readonly<Record<DesktopAppSnapShortcutModifier, string>> = {
  command: "Command",
  control: "Control",
  option: "Alt",
  shift: "Shift",
};

export function isAppSnapShortcutModifier(value: unknown): value is DesktopAppSnapShortcutModifier {
  return APP_SNAP_SHORTCUT_MODIFIERS.includes(value as DesktopAppSnapShortcutModifier);
}

export function isAppSnapShortcutKey(value: unknown): value is string {
  return typeof value === "string" && APP_SNAP_SHORTCUT_KEY_SET.has(value);
}

export function isAppSnapShortcut(value: unknown): value is DesktopAppSnapShortcut {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "both-option-keys") return true;
  return (
    candidate.kind === "key-chord" &&
    isAppSnapShortcutModifier(candidate.modifier) &&
    isAppSnapShortcutKey(candidate.key)
  );
}

export function appSnapModifierFromEventCode(code: string): DesktopAppSnapShortcutModifier | null {
  return MODIFIER_BY_EVENT_CODE[code] ?? null;
}

/**
 * Reason a chord must not be reserved globally even though macOS reports it as
 * free, e.g. ⌘C or ⇧S: reserving it would break typing or a universal action
 * in every foreground app.
 */
export function appSnapShortcutSystemConflict(chord: DesktopAppSnapKeyChord): string | null {
  if (chord.modifier === "shift") {
    return "⇧ combinations are used for typing and text selection — combine with ⌘, ⌃ or ⌥ instead.";
  }
  if (chord.modifier === "control") {
    const action = SYSTEM_CONTROL_CHORD_ACTIONS[chord.key];
    return action ? `⌃ ${appSnapShortcutKeyLabel(chord.key)} ${action} in every terminal.` : null;
  }
  if (chord.modifier !== "command") return null;
  const action = SYSTEM_COMMAND_CHORD_ACTIONS[chord.key];
  if (!action) return null;
  if (chord.key === "Space") return "macOS uses ⌘ Space for Spotlight.";
  if (chord.key === "Tab") return "macOS uses ⌘ Tab to switch apps.";
  return `⌘ ${appSnapShortcutKeyLabel(chord.key)} is ${action} in almost every app.`;
}

export function appSnapShortcutLabels(shortcut: DesktopAppSnapShortcut): readonly [string, string] {
  if (shortcut.kind === "both-option-keys") return ["⌥ left", "⌥ right"];
  return [appSnapShortcutModifierLabel(shortcut.modifier), appSnapShortcutKeyLabel(shortcut.key)];
}

export function appSnapShortcutModifierLabel(modifier: DesktopAppSnapShortcutModifier): string {
  return MODIFIER_LABELS[modifier];
}

export function appSnapShortcutKeyLabel(code: string): string {
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  return KEY_LABELS[code] ?? code;
}

export function appSnapShortcutAccelerator(shortcut: DesktopAppSnapKeyChord): string {
  const key = shortcut.key.startsWith("Key")
    ? shortcut.key.slice(3)
    : shortcut.key.startsWith("Digit")
      ? shortcut.key.slice(5)
      : (ELECTRON_KEY_NAMES[shortcut.key] ?? shortcut.key);
  return `${ELECTRON_MODIFIER_NAMES[shortcut.modifier]}+${key}`;
}

export function sameAppSnapShortcut(
  left: DesktopAppSnapShortcut,
  right: DesktopAppSnapShortcut,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "both-option-keys" || right.kind === "both-option-keys") return true;
  return left.modifier === right.modifier && left.key === right.key;
}
