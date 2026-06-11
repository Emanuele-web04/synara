// FILE: main.menu.ts
// Purpose: Build the desktop application menu template (platform-aware roles, accelerators, zoom items).
// Layer: Desktop main process
// Exports: buildApplicationMenuTemplate.

import type { MenuItemConstructorOptions } from "electron";

import { DESKTOP_MENU_ZOOM_FACTOR_STEP } from "./main.constants";
import {
  resolveDesktopMenuAccelerator,
  resolveKeyboardShortcutsMenuAccelerator,
  shouldUseNativeZoomMenuRoles,
} from "./menuShortcuts";

export interface ApplicationMenuDeps {
  readonly platform: NodeJS.Platform;
  readonly appName: string;
  readonly dispatchMenuAction: (action: string) => void;
  readonly handleCheckForUpdatesMenuClick: () => void;
  readonly resetWindowZoomFromMenu: () => void;
  readonly adjustWindowZoomFromMenu: (multiplier: number) => void;
}

export function buildApplicationMenuTemplate(
  deps: ApplicationMenuDeps,
): MenuItemConstructorOptions[] {
  const {
    platform,
    appName,
    dispatchMenuAction,
    handleCheckForUpdatesMenuClick,
    resetWindowZoomFromMenu,
    adjustWindowZoomFromMenu,
  } = deps;

  const template: MenuItemConstructorOptions[] = [];
  const keyboardShortcutsAccelerator = resolveKeyboardShortcutsMenuAccelerator(platform);
  const acceleratorProps = (
    accelerator: MenuItemConstructorOptions["accelerator"],
  ): Pick<MenuItemConstructorOptions, "accelerator"> => {
    const resolved = resolveDesktopMenuAccelerator(platform, accelerator);
    return resolved ? { accelerator: resolved } : {};
  };
  const zoomMenuItems: MenuItemConstructorOptions[] = shouldUseNativeZoomMenuRoles(platform)
    ? [
        { role: "resetZoom" },
        { role: "zoomIn", ...acceleratorProps("CmdOrCtrl+=") },
        { role: "zoomIn", ...acceleratorProps("CmdOrCtrl+Plus"), visible: false },
        { role: "zoomOut" },
      ]
    : [
        { label: "Reset Zoom", click: () => resetWindowZoomFromMenu() },
        {
          label: "Zoom In",
          click: () => adjustWindowZoomFromMenu(DESKTOP_MENU_ZOOM_FACTOR_STEP),
        },
        {
          label: "Zoom Out",
          click: () => adjustWindowZoomFromMenu(1 / DESKTOP_MENU_ZOOM_FACTOR_STEP),
        },
      ];

  if (platform === "darwin") {
    template.push({
      label: appName,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "CmdOrCtrl+,",
          click: () => dispatchMenuAction("open-settings"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    {
      label: "File",
      submenu: [
        ...(platform === "darwin"
          ? []
          : [
              {
                label: "Settings...",
                ...acceleratorProps("CmdOrCtrl+,"),
                click: () => dispatchMenuAction("open-settings"),
              },
              { type: "separator" as const },
            ]),
        { role: platform === "darwin" ? "close" : "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "New Terminal Tab",
          ...acceleratorProps("CmdOrCtrl+T"),
          click: () => dispatchMenuAction("new-terminal-tab"),
        },
        { type: "separator" },
        {
          label: "Toggle Sidebar",
          ...acceleratorProps("CmdOrCtrl+B"),
          click: () => dispatchMenuAction("toggle-sidebar"),
        },
        {
          label: "Toggle Browser",
          ...acceleratorProps("CmdOrCtrl+Shift+B"),
          click: () => dispatchMenuAction("toggle-browser"),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        ...zoomMenuItems,
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Keyboard Shortcuts",
          ...(keyboardShortcutsAccelerator ? { accelerator: keyboardShortcutsAccelerator } : {}),
          click: () => dispatchMenuAction("show-shortcuts"),
        },
        { type: "separator" },
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
      ],
    },
  );

  return template;
}
