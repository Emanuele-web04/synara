// FILE: appSnapIpc.ts
// Purpose: Centralizes the desktop AppSnap IPC contract and renderer push events.
// Layer: Desktop IPC adapter
// Depends on: Electron IPC and DesktopAppSnapManager.

import type { IpcMain, WebContents } from "electron";
import type {
  DesktopAppSnapCapture,
  DesktopAppSnapErrorEvent,
  DesktopAppSnapState,
} from "@synara/contracts";

import type { DesktopAppSnapManager } from "./appSnapManager";
import { APPSNAP_IPC_CHANNELS } from "./ipcChannels";

const MAX_MACOS_WINDOW_ID = 0xffff_ffff;

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

export function registerAppSnapIpcHandlers(ipcMain: IpcMain, manager: DesktopAppSnapManager): void {
  ipcMain.removeHandler(APPSNAP_IPC_CHANNELS.getState);
  ipcMain.handle(APPSNAP_IPC_CHANNELS.getState, async () => manager.refreshState());

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
  ipcMain.handle(APPSNAP_IPC_CHANNELS.requestPermissions, async () => manager.requestPermissions());

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
}
