// FILE: useDesktopMenuShortcuts.ts
// Purpose: Mirror the user's keybindings onto the native desktop menu accelerators.
// Layer: Web-to-desktop lifecycle bridge

import { useEffect, useRef } from "react";

import {
  DESKTOP_MENU_SHORTCUT_COMMANDS,
  type DesktopMenuShortcutCommand,
  type DesktopMenuShortcuts,
  type ResolvedKeybindingsConfig,
} from "@synara/contracts";
import {
  resolveKeybindingForCommand,
  shortcutConflictKey,
  type ShortcutMatchContext,
} from "~/keybindings";

// Resolve each command where it normally runs. The menu's "New Terminal Tab" is
// `terminal.new`, which is bound for a focused terminal; the others run outside it.
const MENU_COMMAND_CONTEXT: Readonly<Record<DesktopMenuShortcutCommand, ShortcutMatchContext>> = {
  "terminal.new": { terminalFocus: true, terminalOpen: true },
  "sidebar.toggle": { terminalFocus: false, terminalOpen: false },
  "browser.toggle": { terminalFocus: false, terminalOpen: false },
};

/** The effective shortcut of each menu command; null when the user left it unbound. */
export function resolveDesktopMenuShortcuts(
  keybindings: ResolvedKeybindingsConfig,
  platform?: string,
): DesktopMenuShortcuts {
  const entries = DESKTOP_MENU_SHORTCUT_COMMANDS.map((command) => {
    const binding = resolveKeybindingForCommand(keybindings, command, {
      context: MENU_COMMAND_CONTEXT[command],
      ...(platform ? { platform } : {}),
    });
    const sharedConditionalChord =
      binding &&
      keybindings.some(
        (rule) =>
          rule.command !== command &&
          rule.whenAst &&
          shortcutConflictKey(rule.shortcut, platform) ===
            shortcutConflictKey(binding.shortcut, platform),
      );
    // Electron accelerators run globally, without the renderer's focus or `when`
    // context. Keep conditional bindings in the renderer, where they also yield
    // to the recorder; native menu clicks still dispatch their command.
    const shortcut =
      binding && !binding.whenAst && !sharedConditionalChord
        ? {
            key: binding.shortcut.key,
            metaKey: binding.shortcut.metaKey,
            ctrlKey: binding.shortcut.ctrlKey,
            shiftKey: binding.shortcut.shiftKey,
            altKey: binding.shortcut.altKey,
            modKey: binding.shortcut.modKey,
          }
        : null;
    return [command, shortcut] as const;
  });
  return Object.fromEntries(entries) as DesktopMenuShortcuts;
}

/**
 * Reports the menu shortcuts to the desktop shell whenever they change. A no-op on
 * the web build, on desktop builds without the bridge method, and until the server
 * keybindings have loaded (the menu keeps its defaults meanwhile).
 */
export function useDesktopMenuShortcuts(keybindings: ResolvedKeybindingsConfig | undefined): void {
  const lastReportedRef = useRef<string | null>(null);

  useEffect(() => {
    const setMenuShortcuts = window.desktopBridge?.setMenuShortcuts;
    if (!keybindings || typeof setMenuShortcuts !== "function") return;
    const shortcuts = resolveDesktopMenuShortcuts(keybindings);
    const serialized = JSON.stringify(shortcuts);
    if (serialized === lastReportedRef.current) return;
    lastReportedRef.current = serialized;
    setMenuShortcuts(shortcuts).catch(() => {
      // Let the next keybinding change retry instead of assuming the menu has it.
      if (lastReportedRef.current === serialized) lastReportedRef.current = null;
    });
  }, [keybindings]);
}
