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

export const APPSNAP_IPC_CHANNELS = {
  getState: "desktop:appsnap-get-state",
  setEnabled: "desktop:appsnap-set-enabled",
  requestPermissions: "desktop:appsnap-request-permissions",
  listPendingCaptures: "desktop:appsnap-list-pending-captures",
  acknowledgeCapture: "desktop:appsnap-acknowledge-capture",
  captured: "desktop:appsnap-captured",
  error: "desktop:appsnap-error",
  state: "desktop:appsnap-state",
} as const;

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
}
