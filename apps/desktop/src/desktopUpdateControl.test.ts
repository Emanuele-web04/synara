// Purpose: Protects updater handoff ordering, client confirmation, and owned-child fencing.
// Layer: Desktop lifecycle boundary tests; no Electron app or installer is launched.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import type { DesktopUpdateState, ServerDesktopUpdateResult } from "@synara/contracts";
import type { SynaraPackagedDesktopFlavor } from "@synara/shared/desktopIdentity";
import { describe, expect, it, vi } from "vitest";

import { attachDesktopUpdateControl } from "./desktopUpdateControl";
import { createInitialDesktopUpdateState } from "./updateMachine";

function fixture(
  options: {
    flavor?: SynaraPackagedDesktopFlavor;
    isPackaged?: boolean;
    platform?: NodeJS.Platform;
    updaterConfigured?: boolean;
  } = {},
) {
  const flavor = options.flavor ?? "remote";
  const suffix = flavor === "production" ? "" : `-${flavor}.1`;
  const version = `1.0.1${suffix}`;
  const child = new EventEmitter() as EventEmitter & {
    connected: boolean;
    send: (message: unknown, callback: (error: Error | null) => void) => void;
  };
  child.connected = true;
  const responses: Array<{ id: string; result: ServerDesktopUpdateResult }> = [];
  const callbacks: Array<() => void> = [];
  child.send = (message, callback) => {
    responses.push(message as (typeof responses)[number]);
    callbacks.push(() => callback(null));
  };
  let current = true;
  let installBlockedReason: string | null = null;
  let state: DesktopUpdateState = {
    ...createInitialDesktopUpdateState(
      `1.0.0${suffix}`,
      {
        hostArch: "arm64",
        appArch: "arm64",
        runningUnderArm64Translation: false,
      },
      flavor,
    ),
    enabled: true,
    status: "downloaded",
    downloadedVersion: version,
  };
  const install = vi.fn(async () => undefined);
  attachDesktopUpdateControl(child as unknown as ChildProcess, {
    isPackaged: options.isPackaged ?? true,
    platform: options.platform ?? "darwin",
    isCurrentChild: () => current,
    supported: () => options.updaterConfigured ?? true,
    getState: () => state,
    getInstallBlockedReason: () => installBlockedReason,
    check: async () => {},
    download: async () => {},
    install,
  });
  let nextId = 0;
  const request = (input: Record<string, unknown>) => {
    child.emit("message", {
      type: "synara:desktop-update:request",
      id: String(++nextId),
      authority: "device-a",
      action: "install",
      expectedVersion: version,
      ...input,
    });
    return responses.at(-1)?.result;
  };
  return {
    child,
    responses,
    callbacks,
    install,
    request,
    retire: () => {
      current = false;
    },
    replaceVersion: () => {
      state = { ...state, downloadedVersion: "1.0.2-remote.1" };
    },
    requireRelaunch: () => {
      installBlockedReason = "Restart Synara on the Mac before trying again.";
    },
    resumeDownload: () => {
      state = { ...state, status: "downloading" };
    },
  };
}

describe("desktop updater control", () => {
  it.each(["production", "beta", "remote"] as const)(
    "confirms the %s update and flushes the commit reply before install",
    (flavor) => {
      const f = fixture({ flavor });
      const prepared = f.request({});
      expect(prepared?.accepted).toBe(true);
      expect(prepared?.restartToken).toBeTypeOf("string");
      expect(f.install).not.toHaveBeenCalled();
      f.callbacks.shift()?.();
      f.request({ restartToken: prepared?.restartToken });
      expect(f.install).not.toHaveBeenCalled();
      f.callbacks.shift()?.();
      expect(f.install).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { isPackaged: false },
    { platform: "win32" as const },
    { platform: "linux" as const },
    { updaterConfigured: false },
  ])(
    "refuses checks, downloads and installation when the updater is unavailable: %j",
    (options) => {
      const f = fixture(options);
      for (const action of ["status", "check", "download", "install"]) {
        expect(f.request({ action })).toMatchObject({
          accepted: false,
          status: { supported: false, state: null },
        });
      }
      expect(f.install).not.toHaveBeenCalled();
    },
  );

  it("binds confirmation to the same device and exact downloaded version", () => {
    const f = fixture();
    const token = f.request({})?.restartToken;
    expect(f.request({ authority: "device-b", restartToken: token })?.accepted).toBe(false);
    expect(f.request({ expectedVersion: "1.0.9-remote.1", restartToken: token })?.accepted).toBe(
      false,
    );
    const freshToken = f.request({})?.restartToken;
    f.replaceVersion();
    expect(f.request({ restartToken: freshToken })?.accepted).toBe(false);
    f.callbacks.forEach((callback) => callback());
    expect(f.install).not.toHaveBeenCalled();
  });

  it("refuses old child messages and fences a child retired while its reply is flushing", () => {
    const f = fixture();
    const token = f.request({})?.restartToken;
    f.callbacks.shift()?.();
    f.request({ restartToken: token });
    f.retire();
    f.callbacks.shift()?.();
    const count = f.responses.length;
    f.request({});
    expect(f.responses).toHaveLength(count);
    expect(f.install).not.toHaveBeenCalled();
  });

  it("consumes the restart token once and ignores malformed IPC", () => {
    const f = fixture();
    const token = f.request({})?.restartToken;
    f.callbacks.shift()?.();
    f.request({ restartToken: token });
    f.request({ restartToken: token });
    expect(f.responses.at(-1)?.result.accepted).toBe(false);
    f.child.emit("message", {
      type: "synara:desktop-update:request",
      id: "bad",
      action: "install",
    });
    f.callbacks.forEach((callback) => callback());
    expect(f.install).toHaveBeenCalledTimes(1);
  });

  it("refuses an updater recovery blocker and a payload that resumes downloading before handoff", () => {
    const blocked = fixture();
    blocked.requireRelaunch();
    expect(blocked.request({})?.status.message).toContain("Restart Synara on the Mac");
    expect(blocked.request({})?.accepted).toBe(false);
    const downloading = fixture();
    const token = downloading.request({})?.restartToken;
    downloading.callbacks.shift()?.();
    downloading.request({ restartToken: token });
    downloading.resumeDownload();
    downloading.callbacks.shift()?.();
    expect(blocked.install).not.toHaveBeenCalled();
    expect(downloading.install).not.toHaveBeenCalled();
  });
});
