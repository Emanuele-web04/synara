// FILE: appSnapIpc.ts
// Purpose: Centralizes the desktop AppSnap IPC contract and renderer push events.
// Layer: Desktop IPC adapter
// Depends on: Electron IPC and DesktopAppSnapManager.

import type { IpcMain, WebContents } from "electron";
import type {
  DesktopAppSnapCapture,
  DesktopAppSnapErrorEvent,
  DesktopAppSnapPermissionGuideState,
  DesktopAppSnapPermissionKind,
  DesktopAppSnapSettingsPane,
  DesktopAppSnapState,
} from "@synara/contracts";

import type { DesktopAppSnapManager } from "./appSnapManager";
import { APPSNAP_IPC_CHANNELS } from "./ipcChannels";

const MAX_MACOS_WINDOW_ID = 0xffff_ffff;
const MAX_PERMISSION_KINDS = 8;

export const APP_SNAP_SETTINGS_PANE_URLS: Record<DesktopAppSnapSettingsPane, string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "input-monitoring": "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

export interface AppSnapIpcHandlerOptions {
  openPermissionSettingsPane: (pane: DesktopAppSnapSettingsPane) => Promise<boolean>;
  restartApp: () => void;
}

function parseSettingsPane(value: unknown): DesktopAppSnapSettingsPane | null {
  return value === "accessibility" || value === "input-monitoring" || value === "screen-recording"
    ? value
    : null;
}

function parsePermissionKinds(value: unknown): DesktopAppSnapPermissionKind[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PERMISSION_KINDS) {
    return null;
  }
  const kinds = new Set<DesktopAppSnapPermissionKind>();
  for (const entry of value) {
    if (entry !== "accessibility" && entry !== "inputMonitoring" && entry !== "screenRecording") {
      return null;
    }
    kinds.add(entry);
  }
  return [...kinds];
}

export function sendAppSnapState(
  webContents: WebContents | null | undefined,
  state: DesktopAppSnapState,
): void {
  webContents?.send(APPSNAP_IPC_CHANNELS.state, state);
}

export function sendAppSnapCaptured(
  webContents: WebContents | null | undefined,
  capture: DesktopAppSnapCapture,
): void {
  webContents?.send(APPSNAP_IPC_CHANNELS.captured, capture);
}

export function sendAppSnapError(
  webContents: WebContents | null | undefined,
  error: DesktopAppSnapErrorEvent,
): void {
  webContents?.send(APPSNAP_IPC_CHANNELS.error, error);
}

export function sendAppSnapPermissionGuideState(
  webContents: WebContents | null | undefined,
  state: DesktopAppSnapPermissionGuideState,
): void {
  webContents?.send(APPSNAP_IPC_CHANNELS.permissionGuideState, state);
}

export function registerAppSnapIpcHandlers(
  ipcMain: IpcMain,
  manager: DesktopAppSnapManager,
  options: AppSnapIpcHandlerOptions,
): void {
  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.captureCurrentApp);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.captureCurrentApp, async (_event, requestId: unknown) => {
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(requestId)) {
      throw new Error("Invalid AppSnap request.");
    }
    return manager.captureCurrentApp(requestId);
  });
  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.cancelCapture);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.cancelCapture, async (_event, requestId: unknown) => {
    if (typeof requestId === "string") manager.cancelCapture(requestId);
  });

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.getState);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.getState, async (_event, permissions: unknown) =>
    manager.refreshState(parsePermissionKinds(permissions) ?? undefined),
  );

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.setEnabled);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.setEnabled, async (_event, enabled: unknown) =>
    manager.setEnabled(enabled === true),
  );

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.checkShortcut);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.checkShortcut, async (_event, shortcut: unknown) =>
    manager.checkShortcut(shortcut),
  );

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.setShortcut);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.setShortcut, async (_event, shortcut: unknown) =>
    manager.setShortcut(shortcut),
  );

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.requestPermissions);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.requestPermissions, async (_event, permissions: unknown) =>
    manager.requestPermissions(parsePermissionKinds(permissions) ?? undefined),
  );

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.startPermissionSetup);
  ipcMain.handle(
    APPSNAP_IPC_CHANNELS.startPermissionSetup,
    async (_event, permissions: unknown) => {
      const kinds = parsePermissionKinds(permissions);
      if (!kinds) throw new Error("Permission setup requires at least one grant.");
      return manager.startPermissionSetup(kinds);
    },
  );

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.listPendingCaptures);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.listPendingCaptures, async () =>
    manager.listPendingCaptures(),
  );

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.acknowledgeCapture);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.acknowledgeCapture, async (_event, captureId: unknown) => {
    if (typeof captureId === "string") await manager.acknowledgeCapture(captureId);
  });

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.listWindows);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.listWindows, async () => manager.listWindows());

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.captureWindow);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.captureWindow, async (_event, input: unknown) => {
    const windowId =
      typeof input === "object" && input !== null
        ? (input as { windowId?: unknown }).windowId
        : undefined;
    if (
      typeof windowId !== "number" ||
      !Number.isInteger(windowId) ||
      windowId <= 0 ||
      windowId > MAX_MACOS_WINDOW_ID
    ) {
      throw new Error("captureWindow requires a valid macOS window id.");
    }
    return manager.captureWindow(windowId);
  });

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.openPermissionSettings);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.openPermissionSettings, async (_event, pane: unknown) => {
    const settingsPane = parseSettingsPane(pane);
    if (!settingsPane) return false;
    return options.openPermissionSettingsPane(settingsPane);
  });

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.restartApp);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.restartApp, async () => {
    options.restartApp();
  });

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.showPermissionGuide);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.showPermissionGuide, async (_event, pane: unknown) => {
    const settingsPane = parseSettingsPane(pane);
    if (!settingsPane) return;
    manager.showPermissionGuide(settingsPane);
  });

  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.hidePermissionGuide);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.hidePermissionGuide, async () => {
    manager.hidePermissionGuide();
  });
}
