import { describe, expect, it, vi } from "vitest";

import {
  REMOTE_ACCESS_IPC_CHANNELS,
  registerRemoteAccessIpcHandlers,
  type DesktopRemoteAccessIpcController,
} from "./remoteAccessIpc";

describe("remote access IPC", () => {
  it("registers only the explicit companion control-plane handlers", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
      handle: vi.fn(
        (channel: string, handler: (_event: unknown, ...args: unknown[]) => unknown) => {
          handlers.set(channel, (...args) => handler({}, ...args));
        },
      ),
    };
    const controller: DesktopRemoteAccessIpcController = {
      getStatus: vi.fn(() => ({ source: "status" }) as never),
      updateSettings: vi.fn((patch) => patch as never),
      refreshDiagnostics: vi.fn(() => ({ source: "diagnostics" }) as never),
      copyMobileUrl: vi.fn(() => true),
      copyServeCommand: vi.fn(() => true),
      copyServeResetCommand: vi.fn(() => true),
      testConnection: vi.fn(() => ({ reachable: true, status: 200, message: "ok" })),
      createPairingLink: vi.fn((input) => input as never),
      listDevices: vi.fn(() => []),
      revokeDevice: vi.fn(() => true),
      revokeAllDevices: vi.fn(() => 2),
    };

    registerRemoteAccessIpcHandlers(ipcMain as never, controller, () => true);

    expect(Array.from(handlers.keys()).sort()).toEqual(
      [
        REMOTE_ACCESS_IPC_CHANNELS.getStatus,
        REMOTE_ACCESS_IPC_CHANNELS.updateSettings,
        REMOTE_ACCESS_IPC_CHANNELS.refreshDiagnostics,
        REMOTE_ACCESS_IPC_CHANNELS.copyMobileUrl,
        REMOTE_ACCESS_IPC_CHANNELS.copyServeCommand,
        REMOTE_ACCESS_IPC_CHANNELS.copyServeResetCommand,
        REMOTE_ACCESS_IPC_CHANNELS.testConnection,
        REMOTE_ACCESS_IPC_CHANNELS.createPairingLink,
        REMOTE_ACCESS_IPC_CHANNELS.listDevices,
        REMOTE_ACCESS_IPC_CHANNELS.revokeDevice,
        REMOTE_ACCESS_IPC_CHANNELS.revokeAllDevices,
      ].sort(),
    );
    await handlers.get(REMOTE_ACCESS_IPC_CHANNELS.updateSettings)?.({ enabled: true });
    expect(controller.updateSettings).toHaveBeenCalledWith({ enabled: true });
    expect(Object.values(REMOTE_ACCESS_IPC_CHANNELS)).toContain(
      REMOTE_ACCESS_IPC_CHANNELS.state,
    );
    expect(handlers.has(REMOTE_ACCESS_IPC_CHANNELS.state)).toBe(false);
  });

  it("rejects every control-plane invocation from an unauthorized sender", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      removeHandler: vi.fn(),
      handle: vi.fn(
        (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
          handlers.set(channel, (...args) => handler({ sender: "untrusted" }, ...args));
        },
      ),
    };
    const controller = {
      getStatus: vi.fn(),
      updateSettings: vi.fn(),
      refreshDiagnostics: vi.fn(),
      copyMobileUrl: vi.fn(),
      copyServeCommand: vi.fn(),
      copyServeResetCommand: vi.fn(),
      testConnection: vi.fn(),
      createPairingLink: vi.fn(),
      listDevices: vi.fn(),
      revokeDevice: vi.fn(),
      revokeAllDevices: vi.fn(),
    } satisfies DesktopRemoteAccessIpcController;

    registerRemoteAccessIpcHandlers(ipcMain as never, controller, () => false);

    expect(() => handlers.get(REMOTE_ACCESS_IPC_CHANNELS.createPairingLink)?.({})).toThrow(
      /trusted Synara window/,
    );
    expect(controller.createPairingLink).not.toHaveBeenCalled();
  });
});
