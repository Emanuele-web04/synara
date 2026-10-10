// FILE: menuShortcuts.ts
// Purpose: Keeps native desktop menu accelerators consistent across operating systems.
// Layer: Desktop main-process helper
// Exports: menu accelerator resolvers

import {
  DESKTOP_MENU_SHORTCUT_COMMANDS,
  DesktopMenuShortcuts,
  type DesktopMenuShortcutCommand,
  type KeybindingShortcut,
} from "@synara/contracts";
import { Schema } from "effect";
import type { MenuItemConstructorOptions } from "electron";

export interface DesktopKeyboardInput {
  type: string;
  key: string;
  code?: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

export type DesktopPhysicalZoomAction = "zoomOut" | null;

export type DesktopZoomShortcutAction = "zoomIn" | "zoomOut" | "resetZoom";

export interface DesktopNativeZoomTarget {
  getZoomLevel(): number;
  setZoomLevel(level: number): void;
}

export function resolveDesktopPhysicalZoomAction(
  platform: NodeJS.Platform,
  input: DesktopKeyboardInput,
): DesktopPhysicalZoomAction {
  if (
    platform !== "win32" ||
    input.type !== "keyDown" ||
    !input.control ||
    input.meta ||
    input.shift ||
    input.alt
  ) {
    return null;
  }

  const isMinusKey = input.key === "-" || input.code === "Minus" || input.code === "NumpadSubtract";
  return isMinusKey ? "zoomOut" : null;
}

export function applyDesktopPhysicalZoomAction(
  target: DesktopNativeZoomTarget,
  action: Exclude<DesktopPhysicalZoomAction, null>,
): void {
  if (action === "zoomOut") {
    // reuse the native zoomOut role's exact half-level step so alternating native zoom-in and fallback zoom-out can't drift
    target.setZoomLevel(target.getZoomLevel() - 0.5);
  }
}

export function resolveDesktopZoomShortcutAction(
  platform: NodeJS.Platform,
  input: DesktopKeyboardInput,
): DesktopZoomShortcutAction | null {
  // Linux registers no native zoom accelerators (several desktops surface them as noisy keybinding notifications) — main applies them via before-input-event; macOS/Windows keep native roles and must not double-handle
  if (
    platform !== "linux" ||
    input.type !== "keyDown" ||
    !input.control ||
    input.meta ||
    input.alt
  ) {
    return null;
  }

  // NumLock-off numpad presses surface as navigation keys like Insert — the guard keeps them from zooming
  if (input.code === "NumpadAdd" && input.key === "Add") return "zoomIn";
  if (input.code === "NumpadSubtract" && input.key === "Subtract") {
    return input.shift ? null : "zoomOut";
  }
  // "+" needs Shift on most layouts (incl. Italian) so Shift stays allowed for zoom-in; "-" and "0" have unshifted keys so Shift chords are left alone
  if (input.key === "+" || input.key === "=") return "zoomIn";
  if ((input.key === "-" || input.key === "_") && !input.shift) return "zoomOut";
  if (input.key === "0" && !input.shift) return "resetZoom";
  return null;
}

export function resolveDesktopMenuAccelerator(
  platform: NodeJS.Platform,
  accelerator: MenuItemConstructorOptions["accelerator"],
): MenuItemConstructorOptions["accelerator"] | undefined {
  // several Linux desktops surface Electron menu accelerators as noisy native keybinding notifications — the web app handles these shortcuts itself
  return platform === "linux" ? undefined : accelerator;
}

/** Accelerator per menu command; null leaves the menu item without one. */
export type DesktopMenuAccelerators = Readonly<Record<DesktopMenuShortcutCommand, string | null>>;

/** The menu's accelerators until a renderer reports the user's keybindings. */
export const DEFAULT_DESKTOP_MENU_ACCELERATORS: DesktopMenuAccelerators = {
  "terminal.new": "CmdOrCtrl+T",
  "sidebar.toggle": "CmdOrCtrl+B",
  "browser.toggle": "CmdOrCtrl+Shift+B",
};

const NAMED_ACCELERATOR_KEYS = new Map<string, string>([
  [" ", "Space"],
  ["+", "Plus"],
  ["escape", "Escape"],
  ["enter", "Enter"],
  ["tab", "Tab"],
  ["backspace", "Backspace"],
  ["delete", "Delete"],
  ["insert", "Insert"],
  ["home", "Home"],
  ["end", "End"],
  ["pageup", "PageUp"],
  ["pagedown", "PageDown"],
  ["arrowup", "Up"],
  ["arrowdown", "Down"],
  ["arrowleft", "Left"],
  ["arrowright", "Right"],
]);
const FUNCTION_KEY_PATTERN = /^f([1-9]|1\d|2[0-4])$/;
// Digits and the ASCII punctuation Electron's accelerator parser accepts as written.
const LITERAL_ACCELERATOR_KEY_PATTERN = /^[0-9`~!@#$%^&*()\-_=[\]{}\\|;:'",.<>/?]$/;

function acceleratorKey(key: string): string | null {
  const named = NAMED_ACCELERATOR_KEYS.get(key);
  if (named) return named;
  if (/^[a-z]$/.test(key) || FUNCTION_KEY_PATTERN.test(key)) return key.toUpperCase();
  return LITERAL_ACCELERATOR_KEY_PATTERN.test(key) ? key : null;
}

/**
 * The Electron accelerator for a keybinding shortcut, or null when Electron cannot
 * express its key. Chords without Cmd/Ctrl/Alt (other than F-keys) also map to null:
 * as a menu accelerator they would swallow plain typing in the in-app browser.
 */
export function keybindingShortcutToAccelerator(
  shortcut: KeybindingShortcut,
  platform: NodeJS.Platform,
): string | null {
  const key = acceleratorKey(shortcut.key);
  if (!key) return null;
  const hasCommandModifier =
    shortcut.modKey || shortcut.metaKey || shortcut.ctrlKey || shortcut.altKey;
  if (!hasCommandModifier && !FUNCTION_KEY_PATTERN.test(shortcut.key)) return null;

  const isMac = platform === "darwin";
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("CmdOrCtrl");
  // `mod` already is Ctrl off macOS and Cmd on macOS; naming it twice is redundant.
  if (shortcut.ctrlKey && (isMac || !shortcut.modKey)) parts.push("Ctrl");
  if (shortcut.altKey) parts.push("Alt");
  if (shortcut.shiftKey) parts.push("Shift");
  if (shortcut.metaKey && !(isMac && shortcut.modKey)) parts.push(isMac ? "Cmd" : "Super");
  parts.push(key);
  return parts.join("+");
}

const isDesktopMenuShortcuts = Schema.is(DesktopMenuShortcuts);

/** Validates a renderer report and converts it to accelerators; null when the payload is invalid. */
export function resolveReportedMenuAccelerators(
  payload: unknown,
  platform: NodeJS.Platform,
): DesktopMenuAccelerators | null {
  if (!isDesktopMenuShortcuts(payload)) return null;
  const accelerators: Record<DesktopMenuShortcutCommand, string | null> = {
    ...DEFAULT_DESKTOP_MENU_ACCELERATORS,
  };
  for (const command of DESKTOP_MENU_SHORTCUT_COMMANDS) {
    const shortcut = payload[command];
    accelerators[command] = shortcut ? keybindingShortcutToAccelerator(shortcut, platform) : null;
  }
  return accelerators;
}

export function sameDesktopMenuAccelerators(
  left: DesktopMenuAccelerators,
  right: DesktopMenuAccelerators,
): boolean {
  return DESKTOP_MENU_SHORTCUT_COMMANDS.every((command) => left[command] === right[command]);
}

export function shouldUseNativeZoomMenuRoles(platform: NodeJS.Platform): boolean {
  // Linux uses custom click handlers so no hidden native keybindings register — keyboard zoom is applied by the main process instead
  return platform !== "linux";
}

export function resolveKeyboardShortcutsMenuAccelerator(
  platform: NodeJS.Platform,
): MenuItemConstructorOptions["accelerator"] | undefined {
  // Windows Electron can treat Ctrl+- as Ctrl+/ on some layouts — steals the native zoom-out accelerator before the page receives it
  return platform === "darwin" ? "Cmd+/" : undefined;
}
