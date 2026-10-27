import type { DesktopBridge } from "@synara/contracts";
import { expect, it, vi } from "vitest";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(async () => {}),
  expose: vi.fn(),
  sendSync: vi.fn((): unknown => false),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: ipc.expose },
  ipcRenderer: {
    invoke: ipc.invoke,
    sendSync: ipc.sendSync,
    on: vi.fn(),
    send: vi.fn(),
    removeListener: vi.fn(),
  },
  webUtils: { getPathForFile: vi.fn() },
}));

it("forwards the optional typed language preference through its dedicated IPC channel", async () => {
  await import("./preload");
  const bridge = ipc.expose.mock.calls[0]?.[1] as DesktopBridge;
  await bridge.setLanguagePreference?.("zh-CN");
  expect(ipc.invoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.setLanguagePreference, "zh-CN");
});

it("reads current native language candidates on every getter call rather than freezing a preload snapshot", async () => {
  let languages = ["en-US"];
  ipc.sendSync.mockImplementation((...args: unknown[]) =>
    args[0] === DESKTOP_IPC_CHANNELS.getSystemLanguages ? languages : false,
  );
  await import("./preload");
  const bridge = ipc.expose.mock.calls[0]?.[1] as DesktopBridge;
  expect(bridge.getSystemLanguages?.()).toEqual(["en-US"]);
  languages = ["zh-Hans-CN", "en-US"];
  expect(bridge.getSystemLanguages?.()).toEqual(["zh-Hans-CN", "en-US"]);
  expect(ipc.sendSync).toHaveBeenLastCalledWith(DESKTOP_IPC_CHANNELS.getSystemLanguages);
});
