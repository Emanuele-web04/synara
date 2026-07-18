// FILE: remoteAccessIpc.ts
// Purpose: Defines the desktop-local Mobile Companion IPC contract and handler wiring.
// Layer: Desktop IPC adapter

import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";

import type {
  DesktopPairedDevice,
  DesktopPairingLink,
  RemoteConnectionTestResult,
} from "./remoteAccessControlPlane";
import type {
  DesktopRemoteAccessSettings,
  DesktopRemoteAccessSettingsPatch,
} from "./remoteAccessSettings";
import type { TailscaleDiagnostics } from "./tailscaleDiagnostics";
import { REMOTE_ACCESS_IPC_CHANNELS } from "./ipcChannels";

export { REMOTE_ACCESS_IPC_CHANNELS } from "./ipcChannels";

export interface DesktopRemoteAccessStatus {
  readonly settings: DesktopRemoteAccessSettings;
  readonly backend: {
    readonly running: boolean;
    readonly port: number | null;
    readonly loopbackUrl: string | null;
  };
  readonly tailscale: TailscaleDiagnostics | null;
  readonly mobileUrl: string | null;
  readonly configurationIssue: string | null;
}

export interface DesktopRemoteAccessBridge {
  getStatus: () => Promise<DesktopRemoteAccessStatus>;
  updateSettings: (
    patch: DesktopRemoteAccessSettingsPatch,
  ) => Promise<DesktopRemoteAccessStatus>;
  refreshDiagnostics: () => Promise<DesktopRemoteAccessStatus>;
  copyMobileUrl: () => Promise<boolean>;
  copyServeCommand: () => Promise<boolean>;
  copyServeResetCommand: () => Promise<boolean>;
  testConnection: () => Promise<RemoteConnectionTestResult>;
  createPairingLink: (input?: { readonly label?: string }) => Promise<DesktopPairingLink>;
  listDevices: () => Promise<ReadonlyArray<DesktopPairedDevice>>;
  revokeDevice: (sessionId: string) => Promise<boolean>;
  revokeAllDevices: () => Promise<number>;
  onState: (listener: (status: DesktopRemoteAccessStatus) => void) => () => void;
}

export interface DesktopRemoteAccessIpcController {
  readonly getStatus: () => DesktopRemoteAccessStatus | Promise<DesktopRemoteAccessStatus>;
  readonly updateSettings: (
    patch: unknown,
  ) => DesktopRemoteAccessStatus | Promise<DesktopRemoteAccessStatus>;
  readonly refreshDiagnostics: () => DesktopRemoteAccessStatus | Promise<DesktopRemoteAccessStatus>;
  readonly copyMobileUrl: () => boolean | Promise<boolean>;
  readonly copyServeCommand: () => boolean | Promise<boolean>;
  readonly copyServeResetCommand: () => boolean | Promise<boolean>;
  readonly testConnection: () => RemoteConnectionTestResult | Promise<RemoteConnectionTestResult>;
  readonly createPairingLink: (input: unknown) => DesktopPairingLink | Promise<DesktopPairingLink>;
  readonly listDevices: () =>
    | ReadonlyArray<DesktopPairedDevice>
    | Promise<ReadonlyArray<DesktopPairedDevice>>;
  readonly revokeDevice: (sessionId: unknown) => boolean | Promise<boolean>;
  readonly revokeAllDevices: () => number | Promise<number>;
}

export type AuthorizeRemoteAccessIpc = (event: IpcMainInvokeEvent) => boolean;

export function sendRemoteAccessState(
  webContents: WebContents | null | undefined,
  status: DesktopRemoteAccessStatus,
): void {
  if (!webContents || webContents.isDestroyed()) return;
  webContents.send(REMOTE_ACCESS_IPC_CHANNELS.state, status);
}

export function registerRemoteAccessIpcHandlers(
  ipcMain: IpcMain,
  controller: DesktopRemoteAccessIpcController,
  authorize: AuthorizeRemoteAccessIpc,
): void {
  const register = (channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, ...args) => {
      if (!authorize(event)) {
        throw new Error("Remote access controls are available only to the trusted Synara window.");
      }
      return handler(...args);
    });
  };

  register(REMOTE_ACCESS_IPC_CHANNELS.getStatus, () => controller.getStatus());
  register(REMOTE_ACCESS_IPC_CHANNELS.updateSettings, (patch) =>
    controller.updateSettings(patch),
  );
  register(REMOTE_ACCESS_IPC_CHANNELS.refreshDiagnostics, () =>
    controller.refreshDiagnostics(),
  );
  register(REMOTE_ACCESS_IPC_CHANNELS.copyMobileUrl, () => controller.copyMobileUrl());
  register(REMOTE_ACCESS_IPC_CHANNELS.copyServeCommand, () => controller.copyServeCommand());
  register(REMOTE_ACCESS_IPC_CHANNELS.copyServeResetCommand, () =>
    controller.copyServeResetCommand(),
  );
  register(REMOTE_ACCESS_IPC_CHANNELS.testConnection, () => controller.testConnection());
  register(REMOTE_ACCESS_IPC_CHANNELS.createPairingLink, (input) =>
    controller.createPairingLink(input),
  );
  register(REMOTE_ACCESS_IPC_CHANNELS.listDevices, () => controller.listDevices());
  register(REMOTE_ACCESS_IPC_CHANNELS.revokeDevice, (sessionId) =>
    controller.revokeDevice(sessionId),
  );
  register(REMOTE_ACCESS_IPC_CHANNELS.revokeAllDevices, () => controller.revokeAllDevices());
}
