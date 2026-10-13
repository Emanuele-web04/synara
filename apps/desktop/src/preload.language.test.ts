import type { DesktopBridge } from "@synara/contracts";
import { expect, it, vi } from "vitest";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(async () => {}), expose: vi.fn() }));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: ipc.expose },
  ipcRenderer: {
    invoke: ipc.invoke,
    sendSync: vi.fn(() => false),
    on: vi.fn(),
    send: vi.fn(),
    removeListener: vi.fn(),
  },
  webUtils: { getPathForFile: vi.fn() },
}));

it("forwards the optional typed language preference through its dedicated IPC channel", async () => {
  await import("./preload");
  const bridge = ipc.expose.mock.calls[0]?.[1] as DesktopBridge;
  await bridge.setLanguagePreference?.("es");
  expect(ipc.invoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.setLanguagePreference, "es");
});
