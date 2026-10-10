import { EventEmitter } from "node:events";
import { ipcMain, type WebContents } from "electron";
import { expect, it, vi } from "vitest";

import type { BetaDiagnostics } from "./betaDiagnostics";
import { attachBetaRendererDiagnostics } from "./betaRendererDiagnostics";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipcMain: Object.assign(new EventEmitter(), {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
      invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)?.(...args),
    }),
  };
});

it("accepts activity only from the owning main frame and removes listeners on destruction", () => {
  const contents = Object.assign(new EventEmitter(), { mainFrame: {} });
  const recordActivity = vi.fn();
  const trackIssue = vi.fn(() => "report-id");
  const diagnostics = {
    recordActivity,
    trackError: vi.fn(),
    trackIssue,
    getReportStatus: vi.fn(() => "queued"),
  };
  attachBetaRendererDiagnostics(
    contents as unknown as WebContents,
    diagnostics as unknown as BetaDiagnostics,
  );
  const invoke = (
    ipcMain as unknown as { invoke: (channel: string, ...args: unknown[]) => unknown }
  ).invoke;
  const issueChannel = DESKTOP_IPC_CHANNELS.betaDiagnostics.reportIssue;
  const channel = DESKTOP_IPC_CHANNELS.betaDiagnostics.recordActivity;
  const before = ipcMain.listenerCount(channel);
  const breadcrumb = { activity: "chat.send", phase: "started" };
  try {
    ipcMain.emit(channel, { sender: {}, senderFrame: contents.mainFrame }, breadcrumb);
    ipcMain.emit(channel, { sender: contents, senderFrame: {} }, breadcrumb);
    expect(recordActivity).not.toHaveBeenCalled();
    const issue = { code: "voice.transcribe.failed" };
    expect(invoke(issueChannel, { sender: {}, senderFrame: contents.mainFrame }, issue)).toBeNull();
    expect(invoke(issueChannel, { sender: contents, senderFrame: {} }, issue)).toBeNull();
    expect(trackIssue).not.toHaveBeenCalled();
    expect(invoke(issueChannel, { sender: contents, senderFrame: contents.mainFrame }, issue)).toBe(
      "report-id",
    );
    expect(trackIssue).toHaveBeenCalledExactlyOnceWith("renderer", issue);
    ipcMain.emit(channel, { sender: contents, senderFrame: contents.mainFrame }, breadcrumb);
    expect(recordActivity).toHaveBeenCalledExactlyOnceWith(breadcrumb);
    contents.emit("destroyed");
    expect(ipcMain.listenerCount(channel)).toBe(before - 1);
    expect(
      invoke(issueChannel, { sender: contents, senderFrame: contents.mainFrame }, issue),
    ).toBeUndefined();
    ipcMain.emit(channel, { sender: contents, senderFrame: contents.mainFrame }, breadcrumb);
    expect(recordActivity).toHaveBeenCalledTimes(1);
  } finally {
    contents.emit("destroyed");
  }
});
