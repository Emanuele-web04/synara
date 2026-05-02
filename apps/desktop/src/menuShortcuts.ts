// FILE: menuShortcuts.ts
// Purpose: Keeps native desktop menu accelerators consistent across operating systems.
// Layer: Desktop main-process helper
// Exports: keyboard-shortcuts menu accelerator resolver

import type { MenuItemConstructorOptions } from "electron";

export function resolveKeyboardShortcutsMenuAccelerator(
  platform: NodeJS.Platform,
): MenuItemConstructorOptions["accelerator"] | undefined {
  // Windows Electron can treat Ctrl+- as Ctrl+/ on some keyboard layouts,
  // which steals the native zoom-out accelerator before the page receives it.
  return platform === "darwin" ? "Cmd+/" : undefined;
}
