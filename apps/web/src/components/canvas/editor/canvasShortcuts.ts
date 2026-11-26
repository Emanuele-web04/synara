// FILE: canvasShortcuts.ts
// Purpose: The canvas keyboard map: which key press means which editor command (in
//          precedence order), which key events the canvas may handle at all, how a
//          shortcut is spelled for this platform, and the guide of documented presses that
//          tooltips and the app's shortcuts sheet read.
// Layer: Canvas editor input
// Exports: matchCanvasShortcut, canvasKeyOf, isCanvasKeyTarget, canvasShortcutLabel,
//          canvasShortcutLabelFor, canvasShortcutSheetRows, canvasKeyOfPress,
//          CANVAS_SHORTCUT_GUIDE, types

import type { KeybindingShortcut } from "@synara/contracts";
import { formatShortcutLabel } from "~/keybindings";
import { isMacPlatform } from "~/lib/utils";
import type { CanvasTool } from "../canvasStores";

/** A key press with the platform's command modifier resolved (⌘ on macOS, Ctrl elsewhere). */
export type CanvasKey = {
  /** `KeyboardEvent.key`, lower-cased. */
  key: string;
  code: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** The physical Ctrl key (Ctrl+Esc deselects on every platform). */
  ctrl: boolean;
};

export type CanvasShortcutContext = {
  /** How many items are selected. */
  selection: number;
  /** Exactly one layer (not a frame) is selected. */
  singleLayer: boolean;
  readOnly: boolean;
  /** Space is already held for a temporary pan. */
  spaceHeld: boolean;
};

export type CanvasArrangeMode = "front" | "back" | "forward" | "backward";
export type CanvasTextAlign = "left" | "center" | "right" | "justify";
/** ⌘B, ⌘I, ⌘U and ⌘⇧X. */
export type CanvasTextFormat = "bold" | "italic" | "underline" | "strikethrough";
/** The Layout section's align buttons. */
export type CanvasAlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";
/** Typography steps of the text keys: size, weight, line height and letter spacing. */
export type CanvasTextStep = "size" | "weight" | "line-height" | "letter-spacing";

export type CanvasShortcut =
  | { id: "export-files" }
  | { id: "copy-png" }
  | { id: "copy-code"; format: "tailwind" | "css" }
  | { id: "undo" }
  | { id: "redo" }
  | { id: "duplicate" }
  | { id: "copy-styles" }
  | { id: "paste-styles" }
  | { id: "wrap" }
  | { id: "frame-selection" }
  | { id: "ungroup" }
  | { id: "toggle-hidden" }
  | { id: "toggle-locked" }
  | { id: "unlock-all" }
  | { id: "copy" }
  | { id: "cut" }
  | { id: "paste-special"; mode: "on-top" | "replace" }
  | { id: "rename" }
  | { id: "select-all" }
  | { id: "select-others" }
  | { id: "zoom"; factor: number }
  | { id: "zoom-100" }
  | { id: "fit-all" }
  | { id: "fit-selection" }
  | { id: "opacity-digit"; digit: number }
  | { id: "page"; step: 1 | -1 }
  | { id: "frame-step"; step: 1 | -1 }
  | { id: "dashboard" }
  | { id: "toggle-ui" }
  | { id: "show-layers" }
  | { id: "collapse-layers" }
  | { id: "toggle-comments" }
  | { id: "delete" }
  | { id: "escape"; deselect: boolean }
  | { id: "select-parent" }
  | { id: "enter" }
  | { id: "cycle-sibling"; step: 1 | -1 }
  | { id: "add-flex" }
  | { id: "remove-flex" }
  | { id: "clip-content" }
  | { id: "text-align"; align: CanvasTextAlign }
  | { id: "text-format"; format: CanvasTextFormat }
  | { id: "text-step"; step: CanvasTextStep; direction: 1 | -1 }
  | { id: "arrange"; mode: CanvasArrangeMode }
  | { id: "nudge"; dx: number; dy: number }
  | { id: "tool"; tool: CanvasTool }
  | { id: "hold-space" }
  | { id: "align"; mode: CanvasAlignMode }
  | { id: "distribute"; axis: "x" | "y" }
  | { id: "resize-to"; mode: "fit" | "fill" }
  | { id: "resize-by"; dw: number; dh: number };

/** Arrow keys nudge by one design pixel, eight with Shift. */
export const CANVAS_NUDGE_STEP = 1;
export const CANVAS_NUDGE_SHIFT_STEP = 8;
/** A second digit within this long makes an exact opacity (4, 5 → 45%). */
export const CANVAS_OPACITY_DIGIT_MS = 600;

const TOOL_KEYS: Readonly<Record<string, CanvasTool>> = {
  v: "move",
  h: "hand",
  f: "frame",
  a: "frame",
  r: "rectangle",
  t: "text",
  c: "comment",
  y: "comment",
};

type Rule = (key: CanvasKey, context: CanvasShortcutContext) => CanvasShortcut | null;

const ZOOM_DIGITS: Readonly<Record<string, CanvasShortcut>> = {
  Digit0: { id: "zoom-100" },
  Digit1: { id: "fit-all" },
  Digit2: { id: "fit-selection" },
};
const TEXT_ALIGN_CODES: Readonly<Record<string, CanvasTextAlign>> = {
  KeyL: "left",
  KeyT: "center",
  KeyR: "right",
  KeyJ: "justify",
};
const TEXT_FORMAT_CODES: Readonly<Record<string, CanvasTextFormat>> = {
  KeyB: "bold",
  KeyI: "italic",
  KeyU: "underline",
};
/** ⌥A left, ⌥D right, ⌥W top, ⌥S bottom, ⌥H horizontal centres, ⌥V vertical centres. */
const ALIGN_CODES: Readonly<Record<string, CanvasAlignMode>> = {
  KeyA: "left",
  KeyD: "right",
  KeyW: "top",
  KeyS: "bottom",
  KeyH: "center",
  KeyV: "middle",
};
const ARROW_STEPS: Readonly<Record<string, readonly [number, number]>> = {
  arrowleft: [-1, 0],
  arrowright: [1, 0],
  arrowup: [0, -1],
  arrowdown: [0, 1],
};
const digitOf = (code: string) => (/^(Digit|Numpad)[0-9]$/.test(code) ? Number(code.at(-1)) : null);
/** `>` and `<` in the text keys are the Period and Comma keys. */
const angleStep = (code: string): 1 | -1 | null =>
  code === "Period" ? 1 : code === "Comma" ? -1 : null;
const only = (k: CanvasKey, mods: Partial<Record<"mod" | "shift" | "alt", boolean>>) =>
  k.mod === (mods.mod ?? false) &&
  k.shift === (mods.shift ?? false) &&
  k.alt === (mods.alt ?? false);

/**
 * The canvas shortcuts, first match wins. Rules that need a selection fall through without
 * one, so ⌘⇧C with nothing selected is still ⌘C. Where one key has two meanings, the rule
 * that picks between them is noted on that line.
 */
const RULES: readonly Rule[] = [
  // ⌘⇧E exports the selection, else every node on the page with export rows.
  (k) => (k.mod && k.shift && k.key === "e" ? { id: "export-files" } : null),
  // ⌘⌥⇧R resizes the selected layers to fit their content, ⌘⌥⇧F to fill their parent.
  (k, c) =>
    only(k, { mod: true, alt: true, shift: true }) &&
    (k.code === "KeyR" || k.code === "KeyF") &&
    c.selection &&
    !c.readOnly
      ? { id: "resize-to", mode: k.code === "KeyR" ? "fit" : "fill" }
      : null,
  // ⌃⌥H / ⌃⌥V distribute three or more items horizontally or vertically. The physical Ctrl key
  // only where it is not the command key, so Ctrl+Alt+V stays Paste styles elsewhere.
  (k, c) =>
    k.ctrl &&
    !k.mod &&
    k.alt &&
    !k.shift &&
    (k.code === "KeyH" || k.code === "KeyV") &&
    c.selection > 2 &&
    !c.readOnly
      ? { id: "distribute", axis: k.code === "KeyH" ? "x" : "y" }
      : null,
  // ⌥A / ⌥D / ⌥W / ⌥S / ⌥H / ⌥V align several items on an edge or a centre.
  (k, c) =>
    only(k, { alt: true }) && !k.ctrl && ALIGN_CODES[k.code] && c.selection > 1 && !c.readOnly
      ? { id: "align", mode: ALIGN_CODES[k.code]! }
      : null,
  // ⇧⌘C copies the selection as a PNG.
  (k, c) => (k.mod && k.shift && k.key === "c" && c.selection ? { id: "copy-png" } : null),
  // ⌥T copies one node as React with Tailwind, ⌥R as React with inline styles.
  (k, c) =>
    only(k, { alt: true }) && (k.code === "KeyT" || k.code === "KeyR") && c.selection === 1
      ? { id: "copy-code", format: k.code === "KeyT" ? "tailwind" : "css" }
      : null,
  (k) => (k.mod && k.key === "z" ? { id: k.shift ? "redo" : "undo" } : null),
  (k) => (k.mod && k.key === "y" ? { id: "redo" } : null),
  // ⌘⇧D opens the dashboard (the canvas library).
  (k) => (only(k, { mod: true, shift: true }) && k.code === "KeyD" ? { id: "dashboard" } : null),
  (k) => (k.mod && !k.shift && k.key === "d" ? { id: "duplicate" } : null),
  // ⌘⌥⇧L unlocks everything on the page; ⌘⇧L locks; ⌘⌥L/T/R/J align text.
  (k) =>
    only(k, { mod: true, alt: true, shift: true }) && k.code === "KeyL"
      ? { id: "unlock-all" }
      : null,
  (k, c) =>
    only(k, { mod: true, alt: true }) && TEXT_ALIGN_CODES[k.code] && c.selection && !c.readOnly
      ? { id: "text-align", align: TEXT_ALIGN_CODES[k.code]! }
      : null,
  // ⌘B / ⌘I / ⌘U bold, italicize or underline the selected text layers (the text being edited
  // handles its own, on its selection).
  (k, c) =>
    only(k, { mod: true }) && TEXT_FORMAT_CODES[k.code] && c.selection && !c.readOnly
      ? { id: "text-format", format: TEXT_FORMAT_CODES[k.code]! }
      : null,
  // ⌘⇧X strikes the selected text layers through (before ⌘X cuts).
  (k, c) =>
    only(k, { mod: true, shift: true }) && k.code === "KeyX" && c.selection && !c.readOnly
      ? { id: "text-format", format: "strikethrough" }
      : null,
  // ⌘⇧. / ⌘⇧, font size, ⌘⌥. / ⌘⌥, weight, ⌥⇧. / ⌥⇧, line height, ⌥. / ⌥, letter spacing.
  (k, c) => {
    const direction = angleStep(k.code);
    if (direction === null || !c.selection || c.readOnly) return null;
    if (only(k, { mod: true, shift: true })) return { id: "text-step", step: "size", direction };
    if (only(k, { mod: true, alt: true })) return { id: "text-step", step: "weight", direction };
    if (only(k, { alt: true, shift: true }))
      return { id: "text-step", step: "line-height", direction };
    if (only(k, { alt: true })) return { id: "text-step", step: "letter-spacing", direction };
    return null;
  },
  // ⌘⌥C / ⌘⌥V copy and paste styles; ⌘⌥G wraps in a frame, ⌘⇧G or ⌘⌫ ungroups.
  (k, c) => (k.mod && k.alt && k.code === "KeyC" && c.selection ? { id: "copy-styles" } : null),
  (k, c) => (k.mod && k.alt && k.code === "KeyV" && c.selection ? { id: "paste-styles" } : null),
  (k, c) => (k.mod && k.alt && k.code === "KeyG" && c.selection ? { id: "wrap" } : null),
  (k, c) => (k.mod && k.shift && k.key === "g" && c.selection ? { id: "ungroup" } : null),
  (k, c) => (k.mod && k.key === "backspace" && c.selection ? { id: "ungroup" } : null),
  // ⌘⇧H hides, ⌘⇧L locks.
  (k, c) => (k.mod && k.shift && k.key === "h" && c.selection ? { id: "toggle-hidden" } : null),
  (k, c) => (k.mod && k.shift && k.key === "l" && c.selection ? { id: "toggle-locked" } : null),
  // ⌘⇧V pastes on top of the selection, ⌘⇧R pastes in its place.
  (k) =>
    only(k, { mod: true, shift: true }) && (k.code === "KeyV" || k.code === "KeyR")
      ? { id: "paste-special", mode: k.code === "KeyV" ? "on-top" : "replace" }
      : null,
  (k, c) =>
    only(k, { mod: true }) && k.code === "KeyR" && c.selection === 1 ? { id: "rename" } : null,
  (k) => (k.mod && k.key === "c" ? { id: "copy" } : null),
  (k) => (k.mod && k.key === "x" ? { id: "cut" } : null),
  // ⌘⇧A selects the others; ⌘A the selected layer's siblings, otherwise every frame.
  (k, c) => (k.mod && k.shift && k.key === "a" && c.selection ? { id: "select-others" } : null),
  (k) => (k.mod && k.key === "a" ? { id: "select-all" } : null),
  // ⌘\ shows or hides the UI.
  (k) => (only(k, { mod: true }) && k.key === "\\" ? { id: "toggle-ui" } : null),
  (k) => (k.mod && (k.key === "=" || k.key === "+") ? { id: "zoom", factor: 1.25 } : null),
  (k) => (k.mod && k.key === "-" ? { id: "zoom", factor: 0.8 } : null),
  (k) => (only(k, { mod: true }) && k.code === "Digit0" ? { id: "zoom-100" } : null),
  // ⇧0 100%, ⇧1 fit all, ⇧2 fit selection. Matched by key code: ⇧0 types ")".
  (k) => (only(k, { shift: true }) ? (ZOOM_DIGITS[k.code] ?? null) : null),
  // Plain digits mean opacity or zoom: with a selection they set opacity, without one 0, 1 and
  // 2 zoom.
  (k, c) => {
    const digit = digitOf(k.code);
    if (digit === null || !only(k, {})) return null;
    if (c.selection && !c.readOnly) return { id: "opacity-digit", digit };
    return ZOOM_DIGITS[`Digit${digit}`] ?? null;
  },
  // Plain + (or =) and - zoom too.
  (k) =>
    !k.mod && !k.alt && (k.key === "=" || k.key === "+")
      ? { id: "zoom", factor: 1.25 }
      : !k.mod && !k.alt && !k.shift && k.key === "-"
        ? { id: "zoom", factor: 0.8 }
        : null,
  // PageUp / PageDown move between pages; N / ⇧N between frames.
  (k) =>
    only(k, {}) && (k.key === "pageup" || k.key === "pagedown")
      ? { id: "page", step: k.key === "pagedown" ? 1 : -1 }
      : null,
  (k) =>
    !k.mod && !k.alt && k.code === "KeyN" ? { id: "frame-step", step: k.shift ? -1 : 1 } : null,
  // . shows or hides the UI; ⌥1 shows Layers; ⌥L collapses every layer.
  (k) => (only(k, {}) && k.code === "Period" ? { id: "toggle-ui" } : null),
  (k) => (only(k, { alt: true }) && k.code === "Digit1" ? { id: "show-layers" } : null),
  (k) => (only(k, { alt: true }) && k.code === "KeyL" ? { id: "collapse-layers" } : null),
  // ⇧C shows or hides comments.
  (k) => (only(k, { shift: true }) && k.code === "KeyC" ? { id: "toggle-comments" } : null),
  (k) => (k.key === "backspace" || k.key === "delete" ? { id: "delete" } : null),
  // Esc backs out one step; ⇧Esc (or ⌃Esc) deselects at once.
  (k) => (k.key === "escape" ? { id: "escape", deselect: k.ctrl || k.shift } : null),
  // ⇧Enter or \ selects the parent.
  (k) => ((k.key === "enter" && k.shift) || k.key === "\\" ? { id: "select-parent" } : null),
  (k) => (k.key === "enter" ? { id: "enter" } : null),
  (k, c) =>
    k.key === "tab" && c.singleLayer ? { id: "cycle-sibling", step: k.shift ? -1 : 1 } : null,
  // ⇧A adds flex to a container, or wraps several layers in a flex frame; ⌥⇧A removes flex.
  (k, c) =>
    only(k, { alt: true, shift: true }) && k.code === "KeyA" && c.selection && !c.readOnly
      ? { id: "remove-flex" }
      : null,
  (k, c) =>
    only(k, { shift: true }) && k.key === "a" && c.selection && !c.readOnly
      ? { id: "add-flex" }
      : null,
  // ⇧F frames the selection; ⌥C clips content.
  (k, c) =>
    only(k, { shift: true }) && k.code === "KeyF" && c.selection && !c.readOnly
      ? { id: "frame-selection" }
      : null,
  (k, c) =>
    only(k, { alt: true }) && k.code === "KeyC" && c.selection && !c.readOnly
      ? { id: "clip-content" }
      : null,
  // ] / [ bring to front / send to back (also ⌘⌥] / ⌘⌥[); ⌘] / ⌘[ move one step.
  (k, c) => {
    if ((k.code !== "BracketLeft" && k.code !== "BracketRight") || !c.selection) return null;
    const right = k.code === "BracketRight";
    const step = k.mod && !k.alt;
    return {
      id: "arrange",
      mode: step ? (right ? "forward" : "backward") : right ? "front" : "back",
    };
  },
  // ⌘⌥↑ / ⌘⌥↓ also move one step through the layer order.
  (k, c) =>
    k.mod && k.alt && (k.key === "arrowup" || k.key === "arrowdown") && c.selection
      ? { id: "arrange", mode: k.key === "arrowup" ? "forward" : "backward" }
      : null,
  // ⌘ arrows resize the selection's width and height by a pixel, ⇧ by the large step.
  (k, c) => {
    const arrow = ARROW_STEPS[k.key];
    if (!arrow || !k.mod || k.alt || !c.selection || c.readOnly) return null;
    const step = k.shift ? CANVAS_NUDGE_SHIFT_STEP : CANVAS_NUDGE_STEP;
    return { id: "resize-by", dw: arrow[0] * step, dh: arrow[1] * step };
  },
  (k, c) => {
    if (!k.key.startsWith("arrow") || !c.selection) return null;
    const step = k.shift ? CANVAS_NUDGE_SHIFT_STEP : CANVAS_NUDGE_STEP;
    return {
      id: "nudge",
      dx: k.key === "arrowleft" ? -step : k.key === "arrowright" ? step : 0,
      dy: k.key === "arrowup" ? -step : k.key === "arrowdown" ? step : 0,
    };
  },
  (k, c) => {
    if (k.mod || k.alt || k.shift) return null;
    const tool = TOOL_KEYS[k.key];
    if (tool && !(c.readOnly && tool !== "move" && tool !== "hand")) return { id: "tool", tool };
    if (!tool && k.key === " " && !c.spaceHeld) return { id: "hold-space" };
    return null;
  },
];

export function matchCanvasShortcut(
  key: CanvasKey,
  context: CanvasShortcutContext,
): CanvasShortcut | null {
  for (const rule of RULES) {
    const shortcut = rule(key, context);
    if (shortcut) return shortcut;
  }
  return null;
}

export function canvasKeyOf(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  mac: boolean,
): CanvasKey {
  return {
    key: event.key.toLowerCase(),
    code: event.code,
    mod: mac ? event.metaKey : event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    ctrl: event.ctrlKey,
  };
}

/**
 * Whether the canvas may treat a key event as a shortcut. Keys typed into fields, and keys
 * on the canvas's own controls (toolbar, zoom menu), dialogs and menus stay with them, even
 * when React bubbles them out of a portal to the viewport.
 */
export function isCanvasKeyTarget(target: EventTarget | null, root: HTMLElement): boolean {
  if (target === root) return true;
  if (!(target instanceof Element) || !root.contains(target)) return false;
  return !target.closest(
    "input,textarea,select,[contenteditable]:not([contenteditable='false']),[data-canvas-ui],[role='dialog'],[role='menu']",
  );
}

/**
 * A canvas shortcut spelled for this platform: "⇧⌘Z" on macOS, "Ctrl+Shift+Z" elsewhere.
 * `modKey` is ⌘ on macOS and Ctrl elsewhere, matching the viewport's key handling.
 */
export function canvasShortcutLabel(
  key: string,
  modifiers: Partial<Omit<KeybindingShortcut, "key">> = {},
): string {
  return formatShortcutLabel({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: false,
    ...modifiers,
  });
}

/* ------------------------------------------------------------------ the guide */

/** One press of a documented shortcut: the key (lower case) and its modifiers. */
export type CanvasShortcutPress = {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** The physical Ctrl key where it is not the command key (macOS). */
  ctrl?: boolean;
};

export type CanvasShortcutGuideEntry = {
  shortcut: CanvasShortcut;
  /** A `workspace:` (or `common:`) translation key naming what it does. */
  label: string;
  press: CanvasShortcutPress;
  /** What the editor needs for the press to mean this (more than one item, nothing selected). */
  context?: Partial<CanvasShortcutContext>;
};

const press = (key: string, modifiers: Omit<CanvasShortcutPress, "key"> = {}) => ({
  key,
  ...modifiers,
});
const entry = (
  shortcut: CanvasShortcut,
  label: string,
  pressed: CanvasShortcutPress,
  context?: Partial<CanvasShortcutContext>,
): CanvasShortcutGuideEntry => ({
  shortcut,
  label,
  press: pressed,
  ...(context ? { context } : {}),
});

/**
 * Every canvas shortcut with the press that means it, for the shortcuts sheet and for tooltips.
 * A test replays each press through {@link matchCanvasShortcut} and checks that every shortcut
 * id is listed, so the guide cannot drift from the rules above.
 */
export const CANVAS_SHORTCUT_GUIDE: readonly CanvasShortcutGuideEntry[] = [
  entry({ id: "tool", tool: "move" }, "workspace:canvasToolMove", press("v"), { selection: 0 }),
  entry({ id: "tool", tool: "hand" }, "workspace:canvasToolHand", press("h"), { selection: 0 }),
  entry({ id: "hold-space" }, "workspace:canvasShortcutPan", press(" "), { selection: 0 }),
  entry({ id: "tool", tool: "frame" }, "workspace:canvasToolFrame", press("f"), { selection: 0 }),
  entry({ id: "tool", tool: "rectangle" }, "workspace:canvasToolRectangle", press("r"), {
    selection: 0,
  }),
  entry({ id: "tool", tool: "text" }, "workspace:canvasToolText", press("t"), { selection: 0 }),
  entry({ id: "tool", tool: "comment" }, "workspace:canvasToolComment", press("c"), {
    selection: 0,
  }),
  entry({ id: "undo" }, "workspace:canvasUndo", press("z", { mod: true })),
  entry({ id: "redo" }, "workspace:canvasRedo", press("z", { mod: true, shift: true })),
  entry({ id: "copy" }, "workspace:canvasMenuCopy", press("c", { mod: true })),
  entry({ id: "cut" }, "workspace:canvasShortcutCut", press("x", { mod: true })),
  entry(
    { id: "paste-special", mode: "on-top" },
    "workspace:canvasMenuPasteOnTop",
    press("v", { mod: true, shift: true }),
  ),
  entry(
    { id: "paste-special", mode: "replace" },
    "workspace:canvasMenuPasteReplace",
    press("r", { mod: true, shift: true }),
  ),
  entry({ id: "duplicate" }, "workspace:canvasMenuDuplicate", press("d", { mod: true })),
  entry({ id: "delete" }, "workspace:canvasMenuDelete", press("backspace")),
  entry({ id: "rename" }, "workspace:canvasMenuRename", press("r", { mod: true })),
  entry({ id: "select-all" }, "workspace:canvasShortcutSelectAll", press("a", { mod: true })),
  entry(
    { id: "select-others" },
    "workspace:canvasShortcutSelectOthers",
    press("a", { mod: true, shift: true }),
  ),
  entry(
    { id: "select-parent" },
    "workspace:canvasMenuSelectParent",
    press("enter", { shift: true }),
  ),
  entry({ id: "enter" }, "workspace:canvasShortcutEnter", press("enter")),
  entry({ id: "escape", deselect: false }, "workspace:canvasShortcutEscape", press("escape")),
  entry(
    { id: "escape", deselect: true },
    "workspace:canvasMenuDeselect",
    press("escape", { shift: true }),
  ),
  entry({ id: "cycle-sibling", step: 1 }, "workspace:canvasShortcutNextSibling", press("tab")),
  entry(
    { id: "cycle-sibling", step: -1 },
    "workspace:canvasShortcutPreviousSibling",
    press("tab", { shift: true }),
  ),
  entry({ id: "frame-step", step: 1 }, "workspace:canvasShortcutNextFrame", press("n")),
  entry(
    { id: "frame-step", step: -1 },
    "workspace:canvasShortcutPreviousFrame",
    press("n", { shift: true }),
  ),
  entry({ id: "page", step: 1 }, "workspace:canvasShortcutNextPage", press("pagedown")),
  entry({ id: "page", step: -1 }, "workspace:canvasShortcutPreviousPage", press("pageup")),
  entry({ id: "nudge", dx: 1, dy: 0 }, "workspace:canvasShortcutNudge", press("arrowright")),
  entry(
    { id: "resize-by", dw: 1, dh: 0 },
    "workspace:canvasShortcutResize",
    press("arrowright", { mod: true }),
  ),
  entry({ id: "arrange", mode: "front" }, "workspace:canvasMenuBringToFront", press("]")),
  entry({ id: "arrange", mode: "back" }, "workspace:canvasMenuSendToBack", press("[")),
  entry(
    { id: "arrange", mode: "forward" },
    "workspace:canvasMenuBringForward",
    press("]", { mod: true }),
  ),
  entry(
    { id: "arrange", mode: "backward" },
    "workspace:canvasMenuSendBackward",
    press("[", { mod: true }),
  ),
  entry(
    { id: "align", mode: "left" },
    "workspace:canvasInspectorAlignLeft",
    press("a", { alt: true }),
    { selection: 2 },
  ),
  entry(
    { id: "align", mode: "center" },
    "workspace:canvasInspectorAlignHorizontalCenters",
    press("h", { alt: true }),
    { selection: 2 },
  ),
  entry(
    { id: "align", mode: "right" },
    "workspace:canvasInspectorAlignRight",
    press("d", { alt: true }),
    { selection: 2 },
  ),
  entry(
    { id: "align", mode: "top" },
    "workspace:canvasInspectorAlignTop",
    press("w", { alt: true }),
    { selection: 2 },
  ),
  entry(
    { id: "align", mode: "middle" },
    "workspace:canvasInspectorAlignVerticalCenters",
    press("v", { alt: true }),
    { selection: 2 },
  ),
  entry(
    { id: "align", mode: "bottom" },
    "workspace:canvasInspectorAlignBottom",
    press("s", { alt: true }),
    { selection: 2 },
  ),
  entry(
    { id: "distribute", axis: "x" },
    "workspace:canvasInspectorDistributeHorizontally",
    press("h", { ctrl: true, alt: true }),
    { selection: 3 },
  ),
  entry(
    { id: "distribute", axis: "y" },
    "workspace:canvasInspectorDistributeVertically",
    press("v", { ctrl: true, alt: true }),
    { selection: 3 },
  ),
  entry(
    { id: "resize-to", mode: "fit" },
    "workspace:canvasInspectorResizeToFit",
    press("r", { mod: true, alt: true, shift: true }),
  ),
  entry(
    { id: "resize-to", mode: "fill" },
    "workspace:canvasInspectorResizeToFill",
    press("f", { mod: true, alt: true, shift: true }),
  ),
  entry({ id: "wrap" }, "workspace:canvasMenuWrap", press("g", { mod: true, alt: true })),
  entry(
    { id: "frame-selection" },
    "workspace:canvasShortcutFrameSelection",
    press("f", { shift: true }),
  ),
  entry({ id: "ungroup" }, "workspace:canvasMenuUngroup", press("g", { mod: true, shift: true })),
  entry({ id: "add-flex" }, "workspace:canvasMenuAddFlex", press("a", { shift: true })),
  entry(
    { id: "remove-flex" },
    "workspace:canvasMenuRemoveFlex",
    press("a", { alt: true, shift: true }),
  ),
  entry({ id: "clip-content" }, "workspace:canvasInspectorClipContent", press("c", { alt: true })),
  entry(
    { id: "toggle-hidden" },
    "workspace:canvasShortcutToggleHidden",
    press("h", { mod: true, shift: true }),
  ),
  entry(
    { id: "toggle-locked" },
    "workspace:canvasShortcutToggleLocked",
    press("l", { mod: true, shift: true }),
  ),
  entry(
    { id: "unlock-all" },
    "workspace:canvasShortcutUnlockAll",
    press("l", { mod: true, alt: true, shift: true }),
  ),
  entry(
    { id: "copy-styles" },
    "workspace:canvasMenuCopyStyles",
    press("c", { mod: true, alt: true }),
  ),
  entry(
    { id: "paste-styles" },
    "workspace:canvasMenuPasteStyles",
    press("v", { mod: true, alt: true }),
  ),
  entry({ id: "opacity-digit", digit: 5 }, "workspace:canvasShortcutOpacity", press("5")),
  entry(
    { id: "text-format", format: "bold" },
    "workspace:canvasShortcutBold",
    press("b", { mod: true }),
  ),
  entry(
    { id: "text-format", format: "italic" },
    "workspace:canvasShortcutItalic",
    press("i", { mod: true }),
  ),
  entry(
    { id: "text-format", format: "underline" },
    "workspace:canvasShortcutUnderline",
    press("u", { mod: true }),
  ),
  entry(
    { id: "text-format", format: "strikethrough" },
    "workspace:canvasShortcutStrikethrough",
    press("x", { mod: true, shift: true }),
  ),
  entry(
    { id: "text-align", align: "left" },
    "workspace:canvasShortcutTextLeft",
    press("l", { mod: true, alt: true }),
  ),
  entry(
    { id: "text-align", align: "center" },
    "workspace:canvasShortcutTextCenter",
    press("t", { mod: true, alt: true }),
  ),
  entry(
    { id: "text-align", align: "right" },
    "workspace:canvasShortcutTextRight",
    press("r", { mod: true, alt: true }),
  ),
  entry(
    { id: "text-align", align: "justify" },
    "workspace:canvasShortcutTextJustify",
    press("j", { mod: true, alt: true }),
  ),
  entry(
    { id: "text-step", step: "size", direction: 1 },
    "workspace:canvasShortcutFontSizeUp",
    press(".", { mod: true, shift: true }),
  ),
  entry(
    { id: "text-step", step: "size", direction: -1 },
    "workspace:canvasShortcutFontSizeDown",
    press(",", { mod: true, shift: true }),
  ),
  entry(
    { id: "text-step", step: "weight", direction: 1 },
    "workspace:canvasShortcutWeightUp",
    press(".", { mod: true, alt: true }),
  ),
  entry(
    { id: "text-step", step: "weight", direction: -1 },
    "workspace:canvasShortcutWeightDown",
    press(",", { mod: true, alt: true }),
  ),
  entry(
    { id: "text-step", step: "line-height", direction: 1 },
    "workspace:canvasShortcutLineHeightUp",
    press(".", { alt: true, shift: true }),
  ),
  entry(
    { id: "text-step", step: "line-height", direction: -1 },
    "workspace:canvasShortcutLineHeightDown",
    press(",", { alt: true, shift: true }),
  ),
  entry(
    { id: "text-step", step: "letter-spacing", direction: 1 },
    "workspace:canvasShortcutLetterSpacingUp",
    press(".", { alt: true }),
  ),
  entry(
    { id: "text-step", step: "letter-spacing", direction: -1 },
    "workspace:canvasShortcutLetterSpacingDown",
    press(",", { alt: true }),
  ),
  entry({ id: "copy-png" }, "workspace:canvasCopyPng", press("c", { mod: true, shift: true })),
  entry(
    { id: "copy-code", format: "tailwind" },
    "workspace:canvasCopyTailwind",
    press("t", { alt: true }),
  ),
  entry({ id: "copy-code", format: "css" }, "workspace:canvasCopyReact", press("r", { alt: true })),
  entry(
    { id: "export-files" },
    "workspace:canvasShortcutExport",
    press("e", { mod: true, shift: true }),
  ),
  entry({ id: "zoom", factor: 1.25 }, "common:viewerToolbar_zoomIn", press("=", { mod: true })),
  entry({ id: "zoom", factor: 0.8 }, "common:viewerToolbar_zoomOut", press("-", { mod: true })),
  entry({ id: "zoom-100" }, "workspace:canvasZoom100", press("0", { shift: true })),
  entry({ id: "fit-all" }, "workspace:canvasZoomFitAll", press("1", { shift: true })),
  entry({ id: "fit-selection" }, "workspace:canvasZoomFitSelection", press("2", { shift: true })),
  entry({ id: "toggle-ui" }, "workspace:canvasShortcutToggleUi", press(".")),
  entry({ id: "show-layers" }, "workspace:canvasShortcutShowLayers", press("1", { alt: true })),
  entry({ id: "collapse-layers" }, "workspace:canvasLayersCollapseAll", press("l", { alt: true })),
  entry(
    { id: "toggle-comments" },
    "workspace:canvasShortcutToggleComments",
    press("c", { shift: true }),
  ),
  entry(
    { id: "dashboard" },
    "workspace:canvasShortcutLibrary",
    press("d", { mod: true, shift: true }),
  ),
];

const CODE_OF_KEY: Readonly<Record<string, string>> = {
  ".": "Period",
  ",": "Comma",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  "=": "Equal",
  "-": "Minus",
  " ": "Space",
};

/** The key event a guide press stands for (what the viewport would see on any platform). */
export function canvasKeyOfPress(pressed: CanvasShortcutPress): CanvasKey {
  const { key } = pressed;
  const code =
    CODE_OF_KEY[key] ??
    (/^[a-z]$/.test(key)
      ? `Key${key.toUpperCase()}`
      : /^[0-9]$/.test(key)
        ? `Digit${key}`
        : key.slice(0, 1).toUpperCase() + key.slice(1));
  return {
    key,
    code,
    mod: pressed.mod ?? false,
    shift: pressed.shift ?? false,
    alt: pressed.alt ?? false,
    ctrl: pressed.ctrl ?? false,
  };
}

const sameShortcut = (a: CanvasShortcut, b: CanvasShortcut) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * A guide press spelled for `platform`, or null when the platform has no such press: the
 * physical Ctrl key is a separate modifier only where ⌘ is the command key (macOS).
 */
function pressLabel(pressed: CanvasShortcutPress, platform: string): string | null {
  if (pressed.ctrl && !isMacPlatform(platform)) return null;
  return formatShortcutLabel(
    {
      key: pressed.key,
      metaKey: false,
      ctrlKey: pressed.ctrl ?? false,
      shiftKey: pressed.shift ?? false,
      altKey: pressed.alt ?? false,
      modKey: pressed.mod ?? false,
    },
    platform,
  );
}

/** The documented press of `shortcut`, spelled for this platform; null when it has none. */
export function canvasShortcutLabelFor(
  shortcut: CanvasShortcut,
  platform: string = navigator.platform,
): string | null {
  const found = CANVAS_SHORTCUT_GUIDE.find((item) => sameShortcut(item.shortcut, shortcut));
  return found ? pressLabel(found.press, platform) : null;
}

/**
 * The guide as rows of the app's shortcuts sheet: a translation key and the press spelled for
 * `platform`. Presses the platform does not have are left out.
 */
export function canvasShortcutSheetRows(
  platform: string,
): { id: string; label: string; shortcutLabel: string }[] {
  return CANVAS_SHORTCUT_GUIDE.flatMap((item) => {
    const shortcutLabel = pressLabel(item.press, platform);
    return shortcutLabel
      ? [{ id: `canvas:${JSON.stringify(item.shortcut)}`, label: item.label, shortcutLabel }]
      : [];
  });
}
