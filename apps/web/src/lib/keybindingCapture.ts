import type { KeybindingShortcut } from "@synara/contracts";

import { shortcutKeyFromEventCode } from "~/keybindings";
import { getNavigatorPlatform, isMacPlatform } from "~/lib/utils";

/**
 * Converts the browser's key representation into the stable tokens accepted by
 * the keybindings config. Modifiers are deliberately excluded here because the
 * final keydown event already exposes the complete modifier state.
 */
export function normalizeShortcutKeyToken(key: string): string | null {
  const normalized = key.toLowerCase();
  if (
    normalized === "meta" ||
    normalized === "control" ||
    normalized === "ctrl" ||
    normalized === "shift" ||
    normalized === "alt" ||
    normalized === "option"
  ) {
    return null;
  }
  if (normalized === " ") return "space";
  if (normalized === "escape") return "esc";
  if (normalized === "arrowup") return "arrowup";
  if (normalized === "arrowdown") return "arrowdown";
  if (normalized === "arrowleft") return "arrowleft";
  if (normalized === "arrowright") return "arrowright";
  if (normalized.length === 1) return normalized;
  if (/^f(?:[1-9]|1\d|2[0-4])$/.test(normalized)) return normalized;
  if (
    normalized === "enter" ||
    normalized === "tab" ||
    normalized === "backspace" ||
    normalized === "delete" ||
    normalized === "home" ||
    normalized === "end" ||
    normalized === "pageup" ||
    normalized === "pagedown"
  ) {
    return normalized;
  }
  return null;
}

/**
 * The keybinding config value for a keydown, such as "mod+shift+k", or null while only
 * modifiers are down. Three tokens is the most the UI supports (two modifiers plus the
 * key). Reads the key the same way as the shortcut recorder, so Option+S on macOS is
 * "alt+s" rather than the "ß" it types.
 */
export function keybindingFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"> &
    Partial<Pick<KeyboardEvent, "code">>,
  platform = getNavigatorPlatform(),
): string | null {
  const shortcut = shortcutFromKeyboardEvent(event, platform);
  if (!shortcut) return null;
  const modifiers = [
    shortcut.modKey,
    shortcut.metaKey,
    shortcut.ctrlKey,
    shortcut.altKey,
    shortcut.shiftKey,
  ].filter(Boolean).length;
  return modifiers <= 2 ? keybindingValueFromShortcut(shortcut) : null;
}

/**
 * The shortcut a keydown stands for, or null while only modifiers are down or the key
 * has no name in the keybindings config.
 *
 * The typed character wins when it is a plain letter or digit, so the binding shows the
 * key the user's layout prints. Anything else falls back to the physical key: holding
 * Option on macOS turns S into "ß" and Space into a non-breaking space, and Shift turns
 * 1 into "!", none of which is what the user means to bind.
 */
export function shortcutFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"> &
    Partial<Pick<KeyboardEvent, "code">>,
  platform = getNavigatorPlatform(),
): KeybindingShortcut | null {
  const typedKey = event.key.toLowerCase();
  const key = /^[a-z0-9]$/.test(typedKey)
    ? typedKey
    : (shortcutKeyFromEventCode(event.code) ?? shortcutKeyFromToken(event.key));
  if (!key) return null;

  return { key, ...shortcutModifiersFromKeyboardEvent(event, platform) };
}

/** The modifiers held during a key event, with the platform's primary one as `mod`. */
export function shortcutModifiersFromKeyboardEvent(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
  platform = getNavigatorPlatform(),
): Omit<KeybindingShortcut, "key"> {
  const isMac = isMacPlatform(platform);
  return {
    modKey: isMac ? event.metaKey : event.ctrlKey,
    metaKey: isMac ? false : event.metaKey,
    ctrlKey: isMac ? event.ctrlKey : false,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  };
}

// Resolved shortcuts spell these two keys out; the config syntax abbreviates them.
function shortcutKeyFromToken(key: string): string | null {
  const token = normalizeShortcutKeyToken(key);
  if (token === "space") return " ";
  if (token === "esc") return "escape";
  return token;
}

export function keybindingValueFromShortcut(shortcut: KeybindingShortcut): string {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("mod");
  if (shortcut.ctrlKey) parts.push("ctrl");
  if (shortcut.metaKey) parts.push("meta");
  if (shortcut.altKey) parts.push("alt");
  if (shortcut.shiftKey) parts.push("shift");
  parts.push(shortcut.key === " " ? "space" : shortcut.key === "escape" ? "esc" : shortcut.key);
  return parts.join("+");
}
