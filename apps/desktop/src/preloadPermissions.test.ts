import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "@synara/contracts";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  webUtils: {},
}));
vi.mock("electron", () => electron);
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.clearAllMocks();
  vi.resetModules();
});

describe("permission setup preload", () => {
  it.each(["linux", "win32"])("keeps the existing setup flow on %s", async (platform) => {
    Object.defineProperty(process, "platform", { value: platform });
    await import("./preload");
    const bridge = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as DesktopBridge;
    expect(bridge.permissions).toBeUndefined();
  });

  it("exposes macOS setup without starting checks and removes its state subscription", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    await import("./preload");
    const bridge = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as DesktopBridge;
    expect(bridge.permissions).toBeDefined();
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled();
    expect(electron.ipcRenderer.send).not.toHaveBeenCalled();
    bridge.permissions!.startDrag();
    expect(electron.ipcRenderer.send).toHaveBeenCalledExactlyOnceWith(
      DESKTOP_IPC_CHANNELS.permissions.startDrag,
    );
    const stop = bridge.permissions!.onState(vi.fn());
    const [, handler] = electron.ipcRenderer.on.mock.calls[0]!;
    stop();
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledExactlyOnceWith(
      DESKTOP_IPC_CHANNELS.permissions.state,
      handler,
    );
  });
});
