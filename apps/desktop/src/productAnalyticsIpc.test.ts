import { expect, it, vi } from "vitest";

const ipcState = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) =>
      ipcState.handlers.set(channel, listener),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel),
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      ipcState.listeners.set(channel, listener),
    removeListener: (channel: string) => ipcState.listeners.delete(channel),
    removeAllListeners: (channel: string) => ipcState.listeners.delete(channel),
  },
}));

import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { attachProductAnalyticsIpc } from "./productAnalyticsIpc";

it("restricts consent and event IPC to the owning desktop main frame", async () => {
  const mainFrame = {};
  const webContents = { mainFrame, isDestroyed: () => false };
  const analytics = {
    getState: vi.fn(() => ({ enabled: false })),
    setEnabled: vi.fn((enabled: unknown) => ({ enabled: enabled === true })),
    track: vi.fn(),
  };
  const dispose = attachProductAnalyticsIpc(analytics as never, () => webContents as never);
  const getState = ipcState.handlers.get(DESKTOP_IPC_CHANNELS.productAnalytics.getState)!;
  const setEnabled = ipcState.handlers.get(DESKTOP_IPC_CHANNELS.productAnalytics.setEnabled)!;
  const accepted = { sender: webContents, senderFrame: mainFrame };
  const subframe = { sender: webContents, senderFrame: {} };
  const otherWindow = { sender: {}, senderFrame: mainFrame };

  expect(await getState(accepted)).toEqual({ enabled: false });
  expect(await getState(subframe)).toEqual({ enabled: false });
  expect(await setEnabled(accepted, true)).toEqual({ enabled: true });
  expect(await setEnabled(otherWindow, true)).toEqual({ enabled: false });
  const onTrack = ipcState.listeners.get(DESKTOP_IPC_CHANNELS.productAnalytics.track)!;
  onTrack(subframe, { event: "app.open", outcome: "succeeded" });
  onTrack(accepted, { event: "app.open", outcome: "succeeded" });

  expect(analytics.getState).toHaveBeenCalledOnce();
  expect(analytics.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
  expect(analytics.track).toHaveBeenCalledExactlyOnceWith({
    event: "app.open",
    outcome: "succeeded",
  });
  dispose();
  expect(ipcState.handlers.has(DESKTOP_IPC_CHANNELS.productAnalytics.getState)).toBe(false);
});
