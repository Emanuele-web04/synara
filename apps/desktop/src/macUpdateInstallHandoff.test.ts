// Verifies explicit native install ownership without invoking Electron or an OS installer.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { MacUpdateInstallHandoff } from "./macUpdateInstallHandoff";

function createNativeUpdater() {
  return Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  });
}

describe("macOS update install handoff", () => {
  it("fetches the current proxy and leaves the old app running until explicitly asked to quit", async () => {
    const native = createNativeUpdater();
    const handoff = new MacUpdateInstallHandoff(native);

    const prepared = handoff.prepare(15_000);
    expect(native.checkForUpdates).toHaveBeenCalledOnce();
    await expect(handoff.prepare(15_000)).rejects.toThrow("already pending");
    expect(() => handoff.quitAndInstall()).toThrow("not ready");
    native.emit("update-downloaded");
    native.emit("update-downloaded");
    await prepared;
    expect(native.quitAndInstall).not.toHaveBeenCalled();

    handoff.quitAndInstall();
    expect(native.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("settles a failed preparation and ignores late native completions", async () => {
    const native = createNativeUpdater();
    const otherDownloadedListener = vi.fn();
    native.on("update-downloaded", otherDownloadedListener);
    const handoff = new MacUpdateInstallHandoff(native);

    handoff.cancel(); // Preparation failures before a native request remain retryable.
    expect(handoff.blockedReason).toBeNull();
    const prepared = handoff.prepare(15_000);
    const error = new Error("native updater failed");
    handoff.cancel(error);
    await expect(prepared).rejects.toThrow(error);
    native.emit("update-downloaded");

    expect(native.quitAndInstall).not.toHaveBeenCalled();
    expect(otherDownloadedListener).toHaveBeenCalledOnce();
    await expect(handoff.prepare(15_000)).rejects.toThrow("Restart Synara");
    expect(native.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("times out while preparing when the native updater never responds", async () => {
    vi.useFakeTimers();
    try {
      const native = createNativeUpdater();
      const handoff = new MacUpdateInstallHandoff(native);
      const result = expect(handoff.prepare(15_000)).rejects.toThrow("Timed out preparing");
      await vi.advanceTimersByTimeAsync(15_000);
      await result;
      native.emit("update-downloaded");
      expect(native.quitAndInstall).not.toHaveBeenCalled();
      expect(handoff.blockedReason).toContain("Restart Synara");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["check", "install"] as const)(
    "latches a synchronous native %s failure",
    async (stage) => {
      const native = createNativeUpdater();
      const error = new Error("native updater failed");
      const handoff = new MacUpdateInstallHandoff(native);
      if (stage === "check") {
        native.checkForUpdates.mockImplementation(() => {
          throw error;
        });
        await expect(handoff.prepare(15_000)).rejects.toThrow(error);
      } else {
        native.quitAndInstall.mockImplementation(() => {
          throw error;
        });
        const prepared = handoff.prepare(15_000);
        native.emit("update-downloaded");
        await prepared;
        expect(() => handoff.quitAndInstall()).toThrow(error);
      }
      expect(handoff.blockedReason).toContain("Restart Synara");
      native.emit("update-downloaded");
      expect(native.quitAndInstall).toHaveBeenCalledTimes(stage === "check" ? 0 : 1);
    },
  );
});
