import { EventEmitter } from "node:events";
import { ipcMain, type WebContents } from "electron";
import { expect, it, vi } from "vitest";

import type { BetaDiagnostics } from "./betaDiagnostics";
import { attachBetaRendererDiagnostics } from "./betaRendererDiagnostics";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { ipcMain: new EventEmitter() };
});

it("accepts activity only from the owning main frame and removes listeners on destruction", () => {
  const contents = Object.assign(new EventEmitter(), { mainFrame: {} });
  const recordActivity = vi.fn();
  const diagnostics = { recordActivity, trackError: vi.fn() };
  attachBetaRendererDiagnostics(
    contents as unknown as WebContents,
    diagnostics as unknown as BetaDiagnostics,
  );
  const channel = DESKTOP_IPC_CHANNELS.betaDiagnostics.recordActivity;
  const before = ipcMain.listenerCount(channel);
  const breadcrumb = { activity: "chat.send", phase: "started" };
  try {
    ipcMain.emit(channel, { sender: {}, senderFrame: contents.mainFrame }, breadcrumb);
    ipcMain.emit(channel, { sender: contents, senderFrame: {} }, breadcrumb);
    expect(recordActivity).not.toHaveBeenCalled();
    ipcMain.emit(channel, { sender: contents, senderFrame: contents.mainFrame }, breadcrumb);
    expect(recordActivity).toHaveBeenCalledExactlyOnceWith(breadcrumb);
    contents.emit("destroyed");
    expect(ipcMain.listenerCount(channel)).toBe(before - 1);
    ipcMain.emit(channel, { sender: contents, senderFrame: contents.mainFrame }, breadcrumb);
    expect(recordActivity).toHaveBeenCalledTimes(1);
  } finally {
    contents.emit("destroyed");
  }
});
