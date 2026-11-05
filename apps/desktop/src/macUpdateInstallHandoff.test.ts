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
  it("fetches the current proxy and installs only after the native downloaded event", () => {
    const native = createNativeUpdater();
    const handoff = new MacUpdateInstallHandoff(native, vi.fn());

    handoff.start();
    expect(native.checkForUpdates).toHaveBeenCalledOnce();
    expect(native.quitAndInstall).not.toHaveBeenCalled();
    expect(() => handoff.start()).toThrow("already pending");
    native.emit("update-downloaded");
    native.emit("update-downloaded");
    expect(native.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("ignores delayed native completions after recovery and requires relaunch before retry", () => {
    const native = createNativeUpdater();
    const otherDownloadedListener = vi.fn();
    native.on("update-downloaded", otherDownloadedListener);
    const handoff = new MacUpdateInstallHandoff(native, vi.fn());

    handoff.cancel(); // Preparation failures before a native request remain retryable.
    expect(handoff.blockedReason).toBeNull();
    handoff.start();
    handoff.cancel();
    native.emit("update-downloaded");

    expect(native.quitAndInstall).not.toHaveBeenCalled();
    expect(otherDownloadedListener).toHaveBeenCalledOnce();
    expect(handoff.blockedReason).toContain("Restart Synara");
    expect(() => handoff.start()).toThrow("Restart Synara");
    expect(native.checkForUpdates).toHaveBeenCalledOnce();
  });

  it.each(["check", "install"] as const)("latches a synchronous native %s failure", (stage) => {
    const native = createNativeUpdater();
    const error = new Error("native updater failed");
    const onError = vi.fn();
    const handoff = new MacUpdateInstallHandoff(native, onError);
    if (stage === "check") {
      native.checkForUpdates.mockImplementation(() => {
        throw error;
      });
      expect(() => handoff.start()).toThrow(error);
    } else {
      native.quitAndInstall.mockImplementation(() => {
        throw error;
      });
      handoff.start();
      native.emit("update-downloaded");
      expect(onError).toHaveBeenCalledWith(error);
    }
    expect(handoff.blockedReason).toContain("Restart Synara");
    native.emit("update-downloaded");
    expect(native.quitAndInstall).toHaveBeenCalledTimes(stage === "check" ? 0 : 1);
  });
});
