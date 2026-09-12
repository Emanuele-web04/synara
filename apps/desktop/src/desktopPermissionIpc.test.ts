import type { IpcMain, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { registerDesktopPermissionIpc } from "./desktopPermissionIpc";
import type { DesktopPermissionSetup } from "./desktopPermissionSetup";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

describe("desktop permission IPC", () => {
  it("accepts only the main frame and never accepts an arbitrary drag path or scope", () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = {
      removeHandler: vi.fn(),
      removeAllListeners: vi.fn(),
      handle: (name: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(name, handler),
      on: (name: string, handler: (...args: unknown[]) => unknown) => listeners.set(name, handler),
    };
    const contents = { mainFrame: {} };
    const event = { sender: contents, senderFrame: contents.mainFrame };
    const start = vi.fn();
    const startDrag = vi.fn();
    const revealApp = vi.fn();
    registerDesktopPermissionIpc(ipc as unknown as IpcMain, {
      setup: () => ({ start }) as unknown as DesktopPermissionSetup,
      mainWebContents: () => contents as unknown as WebContents,
      startDrag,
      revealApp,
    });
    const channels = DESKTOP_IPC_CHANNELS.permissions;
    handlers.get(channels.start)!(event, "computer");
    expect(start).toHaveBeenCalledExactlyOnceWith("computer");
    expect(() => handlers.get(channels.start)!({ ...event, senderFrame: {} }, "appsnap")).toThrow(
      "main Synara",
    );
    expect(() => handlers.get(channels.start)!(event, "camera")).toThrow("Unknown");
    listeners.get(channels.startDrag)!({ ...event, senderFrame: {} }, "/private/personal.txt");
    expect(startDrag).not.toHaveBeenCalled();
    listeners.get(channels.startDrag)!(event, "/private/personal.txt");
    expect(startDrag).toHaveBeenCalledExactlyOnceWith(contents);
    handlers.get(channels.revealApp)!(event, "/private/personal.txt");
    expect(revealApp).toHaveBeenCalledExactlyOnceWith();
  });
});
