// FILE: menuShortcuts.ts
// Purpose: Keeps native desktop menu accelerators consistent across operating systems.
// Layer: Desktop main-process helper
// Exports: menu accelerator resolvers

import type { MenuItemConstructorOptions } from "electron";

export function resolveDesktopMenuAccelerator(
  platform: NodeJS.Platform,
  accelerator: MenuItemConstructorOptions["accelerator"],
): MenuItemConstructorOptions["accelerator"] | undefined {
  // Several Linux desktops surface Electron menu accelerators as noisy native
  // keybinding notifications; the web app handles these shortcuts itself.
  return platform === "linux" ? undefined : accelerator;
}

export function shouldUseNativeZoomMenuRoles(platform: NodeJS.Platform): boolean {
  // Zoom roles provide their own accelerators when Electron builds the menu.
  // Linux uses custom click handlers so no hidden native keybindings are registered.
  return platform !== "linux";
}

export function resolveKeyboardShortcutsMenuAccelerator(
  platform: NodeJS.Platform,
): MenuItemConstructorOptions["accelerator"] | undefined {
  // Windows Electron can treat Ctrl+- as Ctrl+/ on some keyboard layouts,
  // which steals the native zoom-out accelerator before the page receives it.
  return platform === "darwin" ? "Cmd+/" : undefined;
}

export interface DesktopTabMenuItem {
  label: string;
  action: "close-active-tab" | "reopen-closed-tab";
  accelerator?: MenuItemConstructorOptions["accelerator"];
}

export function resolveDesktopTabMenuItems(platform: NodeJS.Platform): DesktopTabMenuItem[] {
  const definitions = [
    {
      label: "Close Tab",
      action: "close-active-tab" as const,
      accelerator: "CmdOrCtrl+W" as const,
    },
    {
      label: "Reopen Closed Tab",
      action: "reopen-closed-tab" as const,
      accelerator: "CmdOrCtrl+Shift+W" as const,
    },
  ];
  return definitions.map((definition) => {
    const accelerator = resolveDesktopMenuAccelerator(platform, definition.accelerator);
    return {
      label: definition.label,
      action: definition.action,
      ...(accelerator ? { accelerator } : {}),
    };
  });
}
