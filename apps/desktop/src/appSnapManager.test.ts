import * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as FS from "node:fs";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { BrowserWindow, desktopCapturer, nativeImage } from "electron";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@synara/contracts";
import { SYNARA_DEVELOPMENT_BUNDLE_ID } from "@synara/shared/desktopIdentity";
import { describe, expect, it, vi, type Mock } from "vitest";

import {
  DesktopAppSnapManager,
  collectWindowsCaptureCandidates,
  desktopAppSnapPlatform,
  isBlankWindowsThumbnail,
  isPathInsideDirectory,
  parseAppSnapHelperMessage,
  parseWindowsWindowId,
  WINDOWS_SOURCES_TIMEOUT_MS,
  type DesktopAppSnapManagerOptions,
} from "./appSnapManager";

vi.mock("electron", () => ({
  desktopCapturer: {
    getSources: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  nativeImage: {
    createFromBuffer: vi.fn(() => ({
      isEmpty: () => false,
      getSize: () => ({ width: 8, height: 8 }),
      toBitmap: () => {
        const bitmap = Buffer.alloc(8 * 8 * 4);
        for (let index = 0; index < 64; index += 1) {
          const offset = index * 4;
          bitmap[offset] = (index * 37) % 256;
          bitmap[offset + 1] = (index * 91) % 256;
          bitmap[offset + 2] = (index * 13) % 256;
          bitmap[offset + 3] = 255;
        }
        return bitmap;
      },
    })),
  },
}));

type FakeChildProcess = ChildProcess.ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

function createFakeChildProcess(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return child;
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("AppSnap permission probe freshness", () => {
  function fixture() {
    const children: FakeChildProcess[] = [];
    const onState = vi.fn();
    const spawn = vi.fn(() => {
      const child = createFakeChildProcess();
      children.push(child);
      return child;
    });
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      spawn: spawn as unknown as typeof ChildProcess.spawn,
      onState,
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });
    function reply(index: number, permissions: Record<string, string>, code = 0) {
      const child = children[index]!;
      child.stdout.end(`${JSON.stringify({ type: "permissions", ...permissions })}\n`);
      child.stderr.end();
      child.emit("close", code, null);
    }
    return { manager, children, spawn, reply, onState };
  }

  it("shares simultaneous checks and cached grants across Computer and AppSnap scopes", async () => {
    const f = fixture();
    try {
      const first = f.manager.refreshState(["accessibility", "screenRecording", "inputMonitoring"]);
      const concurrent = f.manager.refreshState([
        "screenRecording",
        "inputMonitoring",
        "accessibility",
      ]);
      const subset = f.manager.refreshState();
      await flushPromises();
      expect(f.spawn).toHaveBeenCalledTimes(1);
      f.reply(0, {
        accessibility: "granted",
        screenRecording: "granted",
        inputMonitoring: "granted",
      });
      await Promise.all([first, concurrent, subset]);
      await f.manager.refreshState();
      expect(f.spawn).toHaveBeenCalledTimes(1);
      const forced = f.manager.refreshState(["accessibility"], { force: true });
      await flushPromises();
      expect(f.spawn).toHaveBeenCalledTimes(2);
      f.reply(1, { accessibility: "denied" });
      expect(await forced).toMatchObject({ accessibilityPermission: "denied" });
      const recovery = f.manager.refreshState(["accessibility"]);
      await flushPromises();
      f.reply(2, { accessibility: "granted" });
      expect(await recovery).toMatchObject({ accessibilityPermission: "granted" });
    } finally {
      f.manager.dispose();
    }
  });

  it("does not keep old green badges when the helper returns only part of the requested grants", async () => {
    const f = fixture();
    try {
      const first = f.manager.refreshState();
      await flushPromises();
      f.reply(0, { inputMonitoring: "granted", screenRecording: "granted" });
      await first;
      const incomplete = f.manager.refreshState(undefined, { force: true });
      await flushPromises();
      f.reply(1, { screenRecording: "granted" });
      expect(await incomplete).toMatchObject({
        status: "error",
        inputMonitoringPermission: "unknown",
        screenRecordingPermission: "unknown",
      });
      const recovery = f.manager.refreshState();
      await flushPromises();
      f.reply(2, { inputMonitoring: "granted", screenRecording: "granted" });
      expect(await recovery).toMatchObject({
        inputMonitoringPermission: "granted",
        screenRecordingPermission: "granted",
      });
    } finally {
      f.manager.dispose();
    }
  });

  it("rejects a failed helper even if it printed a complete grant report", async () => {
    const f = fixture();
    try {
      const check = f.manager.refreshState(["accessibility"]);
      await flushPromises();
      f.reply(0, { accessibility: "granted" }, 1);
      expect(await check).toMatchObject({ status: "error", accessibilityPermission: "unknown" });
      expect(
        f.onState.mock.calls.some(([state]) => state.accessibilityPermission === "granted"),
      ).toBe(false);
    } finally {
      f.manager.dispose();
    }
  });

  it("ignores late grants after a timed-out helper and allows a fresh recovery check", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    try {
      const check = f.manager.refreshState(["accessibility"]);
      await flushPromises();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await check).toMatchObject({ status: "error", accessibilityPermission: "unknown" });
      expect(f.children[0]!.kill).toHaveBeenCalled();
      f.reply(0, { accessibility: "granted" });
      expect(f.manager.getState().accessibilityPermission).toBe("unknown");
      const recovery = f.manager.refreshState(["accessibility"]);
      await flushPromises();
      f.reply(1, { accessibility: "granted" });
      expect(await recovery).toMatchObject({ accessibilityPermission: "granted" });
    } finally {
      f.manager.dispose();
      vi.useRealTimers();
    }
  });

  it("does not let an obsolete setup error cancel its replacement", async () => {
    const f = fixture();
    try {
      const obsolete = f.manager.startPermissionSetup(["accessibility"]);
      await flushPromises();
      const replacement = f.manager.startPermissionSetup(["screenRecording"]);
      f.children[0]!.stdout.end(
        `${JSON.stringify({
          type: "error",
          code: "permission_setup_registration_unresolved",
          message: "old error",
        })}\n`,
      );
      f.children[0]!.stderr.end();
      f.children[0]!.emit("close", 1, null);
      await obsolete;
      await flushPromises();
      f.reply(1, { screenRecording: "granted" });
      expect(await replacement).toMatchObject({
        screenRecordingPermission: "granted",
        message: null,
      });
      expect(f.manager.getState().permissionSetupErrorCode).toBeUndefined();
      expect(f.spawn).toHaveBeenCalledTimes(2);
    } finally {
      f.manager.dispose();
    }
  });

  it("does not reopen a dismissed setup after its registration probe completes", async () => {
    const f = fixture();
    try {
      const setup = f.manager.startPermissionSetup(["accessibility", "screenRecording"]);
      await flushPromises();
      f.manager.hidePermissionGuide();
      f.reply(0, { accessibility: "denied", screenRecording: "denied" });
      await setup;
      expect(f.spawn).toHaveBeenCalledTimes(1);
    } finally {
      f.manager.dispose();
    }
  });
});

describe("desktop AppSnap platform state", () => {
  it("checks and requests the legacy permission pair through the helper", async () => {
    const checkChild = createFakeChildProcess();
    const requestChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(requestChild) as unknown as typeof ChildProcess.spawn;
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appBundlePath: "/Applications/Synara Test.app",
      spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });

    const check = manager.refreshState();
    await flushPromises();
    // A legacy request sends no --permission selectors: the helper's built-in
    // default is already the AppSnap pair.
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      ["--check-permissions"],
      expect.any(Object),
    );
    checkChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        inputMonitoring: "denied",
        screenRecording: "granted",
      })}\n`,
    );
    checkChild.stderr.end();
    checkChild.emit("close", 0, null);
    expect(await check).toMatchObject({
      inputMonitoringPermission: "denied",
      screenRecordingPermission: "granted",
    });
    // Accessibility was not asked for, so the state must not invent a value.
    expect((await check).accessibilityPermission).toBeUndefined();

    const request = manager.requestPermissions();
    await flushPromises();
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      ["--request-permissions", "--app-path", "/Applications/Synara Test.app"],
      expect.any(Object),
    );
    requestChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        inputMonitoring: "granted",
        screenRecording: "granted",
      })}\n`,
    );
    requestChild.stderr.end();
    requestChild.emit("close", 0, null);
    expect(await request).toMatchObject({
      inputMonitoringPermission: "granted",
      screenRecordingPermission: "granted",
    });
    manager.dispose();
  });

  it("passes an explicit permission set as --permission selectors", async () => {
    const checkChild = createFakeChildProcess();
    const spawn = vi.fn().mockReturnValueOnce(checkChild) as unknown as typeof ChildProcess.spawn;
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });

    const check = manager.refreshState(["accessibility", "inputMonitoring", "screenRecording"]);
    await flushPromises();
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      [
        "--check-permissions",
        "--permission",
        "accessibility",
        "--permission",
        "inputMonitoring",
        "--permission",
        "screenRecording",
      ],
      expect.any(Object),
    );
    checkChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        accessibility: "denied",
        inputMonitoring: "granted",
        screenRecording: "granted",
      })}\n`,
    );
    checkChild.stderr.end();
    checkChild.emit("close", 0, null);
    expect(await check).toMatchObject({
      accessibilityPermission: "denied",
      inputMonitoringPermission: "granted",
      screenRecordingPermission: "granted",
    });
    manager.dispose();
  });

  it("exposes an explicit unsupported state outside macOS and Windows", async () => {
    const onState = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "linux",
      helperPath: "/missing/synara-appsnap-helper",
      captureDirectory: "/tmp/appsnap",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      onState,
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });

    expect(desktopAppSnapPlatform("darwin")).toBe("macos");
    expect(desktopAppSnapPlatform("linux")).toBe("linux");
    expect(await manager.setEnabled(true)).toMatchObject({
      platform: "linux",
      supported: false,
      enabled: false,
      status: "unsupported",
      shortcut: null,
    });
    expect(manager.checkShortcut({ kind: "key-chord", modifier: "option", key: "KeyX" })).toEqual({
      available: false,
      reason: "AppSnap shortcuts are available only on macOS and Windows.",
    });
    expect(onState).not.toHaveBeenCalled();
  });

  it("preserves a missing-helper error instead of reporting a permission problem", async () => {
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: "/tmp/synara-appsnap-helper-that-does-not-exist",
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });

    expect(await manager.setEnabled(true)).toMatchObject({
      status: "error",
      shortcut: { kind: "both-option-keys" },
      message: "The AppSnap native helper is missing from this desktop build.",
    });
  });
});

describe("AppSnap shortcut availability", () => {
  it("probes macOS registration and stores an available two-key shortcut", async () => {
    const register = vi.fn(() => true);
    const unregister = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: "/tmp/missing-appsnap-helper",
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      shortcutRegistry: { register, unregister },
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });
    const shortcut = { kind: "key-chord", modifier: "option", key: "KeyS" } as const;

    expect(manager.checkShortcut(shortcut)).toEqual({ available: true, reason: null });
    expect(register).toHaveBeenCalledWith("Alt+S", expect.any(Function));
    expect(unregister).toHaveBeenCalledWith("Alt+S");

    const result = await manager.setShortcut(shortcut);
    expect(result.availability).toEqual({ available: true, reason: null });
    expect(result.state.shortcut).toEqual(shortcut);
  });

  it("rejects a shortcut already owned by macOS or another app", () => {
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: "/tmp/missing-appsnap-helper",
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      shortcutRegistry: { register: () => false, unregister: vi.fn() },
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });

    expect(manager.checkShortcut({ kind: "key-chord", modifier: "option", key: "KeyS" })).toEqual({
      available: false,
      reason: "macOS or another app is already using this shortcut.",
    });
    // Universal in-app chords never reach the registry probe: reserving them
    // would hijack the action (Copy, Spotlight, …) in every foreground app.
    expect(manager.checkShortcut({ kind: "key-chord", modifier: "command", key: "Space" })).toEqual(
      {
        available: false,
        reason: "macOS uses ⌘ Space for Spotlight.",
      },
    );
  });

  it("reserves an enabled shortcut and passes it to the native listener", async () => {
    const permissionChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(permissionChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    const register = vi.fn((_accelerator: string, _callback: () => void) => true);
    const unregister = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      spawn,
      shortcutRegistry: { register, unregister },
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });
    const shortcut = { kind: "key-chord", modifier: "option", key: "KeyS" } as const;
    await manager.setShortcut(shortcut);

    const enabling = manager.setEnabled(true);
    await flushPromises();
    permissionChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        inputMonitoring: "granted",
        screenRecording: "granted",
      })}\n`,
    );
    permissionChild.stderr.end();
    permissionChild.emit("close", 0, null);
    await enabling;

    expect(spawn).toHaveBeenLastCalledWith(
      process.execPath,
      [
        "--watch",
        "--output-dir",
        "/tmp/synara-appsnap-test",
        "--excluded-bundle-id",
        SYNARA_DEVELOPMENT_BUNDLE_ID,
        "--external-trigger",
      ],
      expect.any(Object),
    );
    expect(register).toHaveBeenLastCalledWith("Alt+S", expect.any(Function));

    // The reserved accelerator's callback drives the capture: pressing the
    // chord writes a trigger line to the helper's stdin.
    const reservationCallback = register.mock.calls.at(-1)?.[1] as (() => void) | undefined;
    reservationCallback?.();
    expect(watchChild.stdin.read()?.toString()).toBe("trigger\n");

    await manager.setEnabled(false);
    expect(unregister).toHaveBeenLastCalledWith("Alt+S");
    manager.dispose();
  });
});

describe("AppSnap helper protocol", () => {
  it("accepts typed permission and capture messages", () => {
    expect(
      parseAppSnapHelperMessage(
        JSON.stringify({
          type: "permissions",
          inputMonitoring: "granted",
          screenRecording: "denied",
        }),
      ),
    ).toEqual({
      type: "permissions",
      inputMonitoring: "granted",
      screenRecording: "denied",
    });

    expect(
      parseAppSnapHelperMessage(
        JSON.stringify({
          type: "captured",
          id: "capture-1",
          path: "/tmp/appsnap/capture-1.png",
          name: "AppSnap-Safari-capture-1.png",
          sourceAppName: "Safari",
          sourceBundleIdentifier: "com.apple.Safari",
          sourceAppIconDataUrl: "data:image/png;base64,aWNvbg==",
        }),
      ),
    ).toMatchObject({
      type: "captured",
      id: "capture-1",
      sourceAppName: "Safari",
      sourceBundleIdentifier: "com.apple.Safari",
      sourceAppIconDataUrl: "data:image/png;base64,aWNvbg==",
    });
  });

  it("rejects malformed or unknown helper output", () => {
    expect(parseAppSnapHelperMessage("not-json")).toBeNull();
    expect(parseAppSnapHelperMessage(JSON.stringify({ type: "captured", path: "/tmp/x" }))).toBe(
      null,
    );
    expect(parseAppSnapHelperMessage(JSON.stringify({ type: "surprise" }))).toBeNull();
  });

  it("serializes permission commands and waits for stdout to drain", async () => {
    const checkChild = createFakeChildProcess();
    const requestChild = createFakeChildProcess();
    const freshCheckChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(requestChild)
      .mockReturnValueOnce(freshCheckChild) as unknown as typeof ChildProcess.spawn;
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appBundlePath: "/Applications/Synara Test.app",
      spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });

    const check = manager.refreshState();
    const request = manager.requestPermissions();
    await flushPromises();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      ["--check-permissions"],
      expect.any(Object),
    );

    checkChild.emit("exit", 0, null);
    checkChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        inputMonitoring: "denied",
        screenRecording: "denied",
      })}\n`,
    );
    checkChild.stderr.end();
    checkChild.emit("close", 0, null);
    await flushPromises();

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      ["--request-permissions", "--app-path", "/Applications/Synara Test.app"],
      expect.any(Object),
    );

    requestChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        inputMonitoring: "granted",
        screenRecording: "granted",
      })}\n`,
    );
    requestChild.stderr.end();
    requestChild.emit("close", 0, null);
    await flushPromises();
    freshCheckChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        inputMonitoring: "granted",
        screenRecording: "granted",
      })}\n`,
    );
    freshCheckChild.stderr.end();
    freshCheckChild.emit("close", 0, null);

    await Promise.all([check, request]);
    expect(manager.getState()).toMatchObject({
      inputMonitoringPermission: "granted",
      screenRecordingPermission: "granted",
    });
  });

  it("restarts the listener after a revoked permission is granted again", async () => {
    const checkChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const requestChild = createFakeChildProcess();
    const restartedWatchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(watchChild)
      .mockReturnValueOnce(requestChild)
      .mockReturnValueOnce(restartedWatchChild) as unknown as typeof ChildProcess.spawn;
    const register = vi.fn(() => true);
    const unregister = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      spawn,
      shortcutRegistry: { register, unregister },
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });
    await manager.setShortcut({ kind: "key-chord", modifier: "option", key: "KeyS" });
    register.mockClear();
    unregister.mockClear();

    const enable = manager.setEnabled(true);
    await flushPromises();
    checkChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        inputMonitoring: "granted",
        screenRecording: "granted",
      })}\n`,
    );
    checkChild.stderr.end();
    checkChild.emit("close", 0, null);
    await enable;
    watchChild.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);
    expect(manager.getState().status).toBe("ready");

    watchChild.stdout.write(
      `${JSON.stringify({
        type: "error",
        code: "screen-recording-required",
        message: "Screen Recording permission is required.",
      })}\n`,
    );
    expect(manager.getState()).toMatchObject({
      status: "permission-required",
      screenRecordingPermission: "denied",
    });
    expect(watchChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(unregister).toHaveBeenCalledWith("Alt+S");

    const request = manager.requestPermissions();
    await flushPromises();
    requestChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        inputMonitoring: "granted",
        screenRecording: "granted",
      })}\n`,
    );
    requestChild.stderr.end();
    requestChild.emit("close", 0, null);
    await request;
    restartedWatchChild.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);

    expect(spawn).toHaveBeenCalledTimes(4);
    expect(manager.getState().status).toBe("ready");
    expect(register).toHaveBeenCalledTimes(2);
    manager.dispose();
  });

  it("ignores buffered listener output after AppSnap is disabled", async () => {
    const checkChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });

    const enable = manager.setEnabled(true);
    await flushPromises();
    checkChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        inputMonitoring: "granted",
        screenRecording: "granted",
      })}\n`,
    );
    checkChild.stderr.end();
    checkChild.emit("close", 0, null);
    await enable;

    watchChild.stdout.write('{"type":"ready"');
    await manager.setEnabled(false);
    watchChild.stdout.end("}\n");
    await flushPromises();

    expect(manager.getState().status).toBe("disabled");
    expect(watchChild.kill).toHaveBeenCalledWith("SIGTERM");
    manager.dispose();
  });

  it("surfaces an unexpected listener exit through the capture error channel", async () => {
    const checkChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    const onError = vi.fn();
    const register = vi.fn(() => true);
    const unregister = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      spawn,
      shortcutRegistry: { register, unregister },
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError,
    });
    await manager.setShortcut({ kind: "key-chord", modifier: "option", key: "KeyS" });
    unregister.mockClear();

    const enable = manager.setEnabled(true);
    await flushPromises();
    checkChild.stdout.end(
      `${JSON.stringify({
        type: "permissions",
        inputMonitoring: "granted",
        screenRecording: "granted",
      })}\n`,
    );
    checkChild.stderr.end();
    checkChild.emit("close", 0, null);
    await enable;
    watchChild.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);

    watchChild.emit("exit", 1, null);

    expect(manager.getState()).toMatchObject({
      enabled: true,
      status: "error",
      message: "The AppSnap helper stopped unexpectedly (exit 1).",
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "helper-stopped",
        message: "The AppSnap helper stopped unexpectedly (exit 1).",
      }),
      false,
    );
    expect(unregister).toHaveBeenCalledWith("Alt+S");
    manager.dispose();
  });

  it("coalesces concurrent listener reconciliation while the capture directory is prepared", async () => {
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-reconcile-"));
    const firstCheckChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(firstCheckChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    let releaseMkdir!: () => void;
    const mkdirGate = new Promise<void>((resolve) => {
      releaseMkdir = resolve;
    });
    const mkdir = vi.spyOn(FS.promises, "mkdir").mockImplementationOnce(async () => {
      await mkdirGate;
      return undefined;
    });
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });

    try {
      const enable = manager.setEnabled(true);
      await flushPromises();
      firstCheckChild.stdout.end(
        `${JSON.stringify({
          type: "permissions",
          inputMonitoring: "granted",
          screenRecording: "granted",
        })}\n`,
      );
      firstCheckChild.stderr.end();
      firstCheckChild.emit("close", 0, null);
      await flushPromises();

      const refresh = manager.refreshState();
      await flushPromises();
      // The successful enable check already covers the legacy AppSnap pair.
      // A concurrent refresh reuses it while listener creation is in flight.
      expect(spawn).toHaveBeenCalledTimes(1);
      releaseMkdir();
      await Promise.all([enable, refresh]);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn).toHaveBeenLastCalledWith(
        process.execPath,
        [
          "--watch",
          "--output-dir",
          captureDirectory,
          "--excluded-bundle-id",
          SYNARA_DEVELOPMENT_BUNDLE_ID,
        ],
        expect.any(Object),
      );
    } finally {
      releaseMkdir();
      mkdir.mockRestore();
      manager.dispose();
      rmSync(captureDirectory, { recursive: true, force: true });
    }
  });

  it("retains a full composer batch and reports any overflow", async () => {
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-test-"));
    const checkChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    const onCaptured = vi.fn();
    const onError = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      spawn,
      onState: vi.fn(),
      onCaptured,
      onError,
    });

    try {
      const enable = manager.setEnabled(true);
      await flushPromises();
      checkChild.stdout.end(
        `${JSON.stringify({
          type: "permissions",
          inputMonitoring: "granted",
          screenRecording: "granted",
        })}\n`,
      );
      checkChild.stderr.end();
      checkChild.emit("close", 0, null);
      await enable;

      for (let index = 0; index <= PROVIDER_SEND_TURN_MAX_ATTACHMENTS; index += 1) {
        const id = `capture-${index}`;
        const capturePath = join(captureDirectory, `${id}.png`);
        writeFileSync(
          capturePath,
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, index]),
        );
        watchChild.stdout.write(
          `${JSON.stringify({
            type: "captured",
            id,
            path: capturePath,
            name: `${id}.png`,
          })}\n`,
        );
      }

      await vi.waitFor(() => {
        expect(onCaptured).toHaveBeenCalledTimes(PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1);
      });
      const pendingCaptures = await manager.listPendingCaptures();
      expect(pendingCaptures).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
      expect(pendingCaptures[0]?.id).toBe("capture-1");
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "pending-capture-overflow" }),
        false,
      );
    } finally {
      manager.dispose();
      rmSync(captureDirectory, { recursive: true, force: true });
    }
  });

  it("reports capture overlap without stealing app focus", async () => {
    const checkChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    const onError = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError,
    });

    try {
      const enable = manager.setEnabled(true);
      await flushPromises();
      checkChild.stdout.end(
        `${JSON.stringify({
          type: "permissions",
          inputMonitoring: "granted",
          screenRecording: "granted",
        })}\n`,
      );
      checkChild.stderr.end();
      checkChild.emit("close", 0, null);
      await enable;

      watchChild.stdout.write(
        `${JSON.stringify({
          type: "error",
          code: "capture_in_progress",
          message: "A previous AppSnap capture is still in progress.",
        })}\n`,
      );
      watchChild.stdout.write(
        `${JSON.stringify({
          type: "error",
          code: "capture_timed_out",
          message: "Timed out while preparing or capturing the window.",
        })}\n`,
      );
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));

      expect(onError).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ code: "capture_in_progress" }),
        false,
      );
      expect(onError).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ code: "capture_timed_out" }),
        true,
      );
    } finally {
      manager.dispose();
    }
  });

  it("keeps the helper capture file when persisting the pending copy fails", async () => {
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-persist-fail-"));
    const checkChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    const onCaptured = vi.fn();
    const onError = vi.fn();
    const rename = vi.spyOn(FS.promises, "rename").mockRejectedValueOnce(new Error("disk full"));
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      spawn,
      onState: vi.fn(),
      onCaptured,
      onError,
    });

    try {
      const enable = manager.setEnabled(true);
      await flushPromises();
      checkChild.stdout.end(
        `${JSON.stringify({
          type: "permissions",
          inputMonitoring: "granted",
          screenRecording: "granted",
        })}\n`,
      );
      checkChild.stderr.end();
      checkChild.emit("close", 0, null);
      await enable;

      const capturePath = join(captureDirectory, "persist-fail.png");
      writeFileSync(
        capturePath,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
      );
      const capturedMessage = JSON.stringify({
        type: "captured",
        id: "capture-persist-fail",
        path: capturePath,
        name: "persist-fail.png",
      });
      watchChild.stdout.write(`${capturedMessage}\n`);

      await vi.waitFor(() => {
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({ code: "capture-read-failed" }),
          true,
        );
      });
      expect(onCaptured).not.toHaveBeenCalled();
      expect(FS.existsSync(capturePath)).toBe(true);

      watchChild.stdout.write(`${capturedMessage}\n`);
      await vi.waitFor(() => expect(onCaptured).toHaveBeenCalledTimes(1));
      expect(FS.existsSync(capturePath)).toBe(false);
      expect(await manager.listPendingCaptures()).toHaveLength(1);
    } finally {
      rename.mockRestore();
      manager.dispose();
      rmSync(captureDirectory, { recursive: true, force: true });
    }
  });

  it("restores pending captures after a manager restart and removes them only after ack", async () => {
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-pending-"));
    const checkChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    const onCaptured = vi.fn();
    const firstManager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      spawn,
      onState: vi.fn(),
      onCaptured,
      onError: vi.fn(),
    });

    try {
      const enable = firstManager.setEnabled(true);
      await flushPromises();
      checkChild.stdout.end(
        `${JSON.stringify({
          type: "permissions",
          inputMonitoring: "granted",
          screenRecording: "granted",
        })}\n`,
      );
      checkChild.stderr.end();
      checkChild.emit("close", 0, null);
      await enable;

      const capturePath = join(captureDirectory, "restart-capture.png");
      const captureBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
      writeFileSync(capturePath, captureBytes);
      watchChild.stdout.write(
        `${JSON.stringify({
          type: "captured",
          id: "capture-restart",
          capturedAt: "2026-07-13T20:00:00.000Z",
          path: capturePath,
          name: "restart-capture.png",
          sourceAppName: "Safari",
          sourceBundleIdentifier: "com.apple.Safari",
          sourceWindowTitle: "Synara",
        })}\n`,
      );
      await vi.waitFor(() => expect(onCaptured).toHaveBeenCalledTimes(1));
      firstManager.dispose();

      const restoredManager = new DesktopAppSnapManager({
        platform: "darwin",
        helperPath: process.execPath,
        captureDirectory,
        excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
        onState: vi.fn(),
        onCaptured: vi.fn(),
        onError: vi.fn(),
      });
      const restored = await restoredManager.listPendingCaptures();
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({
        id: "capture-restart",
        name: "restart-capture.png",
        sourceAppName: "Safari",
        sourceBundleIdentifier: "com.apple.Safari",
        sourceWindowTitle: "Synara",
      });
      expect(Buffer.from(restored[0]!.bytes)).toEqual(captureBytes);

      await restoredManager.acknowledgeCapture("capture-restart");
      expect(await restoredManager.listPendingCaptures()).toEqual([]);
      restoredManager.dispose();

      const finalManager = new DesktopAppSnapManager({
        platform: "darwin",
        helperPath: process.execPath,
        captureDirectory,
        excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
        onState: vi.fn(),
        onCaptured: vi.fn(),
        onError: vi.fn(),
      });
      expect(await finalManager.listPendingCaptures()).toEqual([]);
      finalManager.dispose();
    } finally {
      firstManager.dispose();
      rmSync(captureDirectory, { recursive: true, force: true });
    }
  });

  it("recovers a helper PNG left behind before pending metadata was persisted", async () => {
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-helper-recovery-"));
    const captureId = "6b981032-c848-4d0b-94f1-6de335391aa2";
    const helperPath = join(captureDirectory, `appsnap-${captureId}.png`);
    const captureBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    writeFileSync(helperPath, captureBytes);
    const now = () => new Date("2026-07-13T23:30:00.000Z");
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
      now,
    });

    try {
      const recovered = await manager.listPendingCaptures();
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        id: captureId,
        capturedAt: "2026-07-13T23:30:00.000Z",
        name: `appsnap-${captureId}.png`,
        sourceAppName: null,
      });
      expect(Buffer.from(recovered[0]!.bytes)).toEqual(captureBytes);
      expect(FS.existsSync(helperPath)).toBe(false);
      manager.dispose();

      const restartedManager = new DesktopAppSnapManager({
        platform: "darwin",
        helperPath: process.execPath,
        captureDirectory,
        excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
        onState: vi.fn(),
        onCaptured: vi.fn(),
        onError: vi.fn(),
        now,
      });
      expect(await restartedManager.listPendingCaptures()).toHaveLength(1);
      restartedManager.dispose();
    } finally {
      manager.dispose();
      rmSync(captureDirectory, { recursive: true, force: true });
    }
  });
});

describe("AppSnap capture path guard", () => {
  it("accepts child paths and rejects traversal or the directory itself", () => {
    expect(isPathInsideDirectory("/tmp/appsnap", "/tmp/appsnap/capture.png")).toBe(true);
    expect(isPathInsideDirectory("/tmp/appsnap", "/tmp/appsnap")).toBe(false);
    expect(isPathInsideDirectory("/tmp/appsnap", "/tmp/other/capture.png")).toBe(false);
  });
});

describe("AppSnap window picker requests", () => {
  async function createEnabledManager(): Promise<{
    manager: DesktopAppSnapManager;
    watchChild: FakeChildProcess;
    captureDirectory: string;
    onCaptured: Mock;
    onError: Mock;
    dispose: () => void;
  }> {
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-picker-"));
    const checkChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    const onCaptured = vi.fn();
    const onError = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      spawn,
      onState: vi.fn(),
      onCaptured,
      onError,
    });
    const enable = manager.setEnabled(true);
    await flushPromises();
    checkChild.stdout.end(
      `${JSON.stringify({ type: "permissions", inputMonitoring: "granted", screenRecording: "granted" })}\n`,
    );
    checkChild.stderr.end();
    checkChild.emit("close", 0, null);
    await enable;
    return {
      manager,
      watchChild,
      captureDirectory,
      onCaptured,
      onError,
      dispose: () => {
        manager.dispose();
        rmSync(captureDirectory, { recursive: true, force: true });
      },
    };
  }

  function lastStdinLine(child: FakeChildProcess): string {
    return child.stdin.read()?.toString().trimEnd() ?? "";
  }

  it("lists windows through a correlated request", async () => {
    const { manager, watchChild, dispose } = await createEnabledManager();
    try {
      const listing = manager.listWindows();
      await flushPromises();
      const requestId = lastStdinLine(watchChild).slice("list-windows ".length);
      watchChild.stdout.write(
        `${JSON.stringify({
          type: "windows",
          requestId,
          windows: [
            {
              windowId: 42,
              appName: "Ghostty",
              bundleIdentifier: "com.mitchellh.ghostty",
              windowTitle: "dev",
            },
          ],
        })}\n`,
      );
      expect(await listing).toEqual([
        {
          windowId: 42,
          appName: "Ghostty",
          bundleIdentifier: "com.mitchellh.ghostty",
          windowTitle: "dev",
          appIconDataUrl: null,
        },
      ]);
    } finally {
      dispose();
    }
  });

  it("times out listWindows when the helper never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { manager, dispose } = await createEnabledManager();
      try {
        const listing = manager.listWindows();
        const assertion = expect(listing).rejects.toThrow(
          "Timed out while listing capturable windows.",
        );
        await vi.advanceTimersByTimeAsync(5_000);
        await assertion;
      } finally {
        dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("captures a specific window and keeps a pending record until acknowledged", async () => {
    const { manager, watchChild, captureDirectory, dispose } = await createEnabledManager();
    try {
      const capturing = manager.captureWindow(77);
      await flushPromises();
      const requestId = lastStdinLine(watchChild).slice("capture-window ".length, -3);
      expect(requestId).toMatch(/^picker-[a-f0-9-]+$/);
      const capturePath = join(captureDirectory, "req-capture.png");
      const captureBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
      writeFileSync(capturePath, captureBytes);
      watchChild.stdout.write(`${JSON.stringify({ type: "triggered", id: requestId })}\n`);
      watchChild.stdout.write(
        `${JSON.stringify({
          type: "captured",
          id: requestId,
          path: capturePath,
          name: "req-capture.png",
          sourceAppName: "Safari",
        })}\n`,
      );
      const capture = await capturing;
      expect(capture).toMatchObject({ id: requestId, name: "req-capture.png" });
      // The durable capture resolves before asynchronous helper-file cleanup.
      await expect.poll(() => FS.existsSync(capturePath)).toBe(false);
      expect(await manager.listPendingCaptures()).toHaveLength(1);
      await manager.acknowledgeCapture(capture.id);
      expect(await manager.listPendingCaptures()).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("rejects values outside the macOS window id range before writing to the helper", async () => {
    const { manager, watchChild, dispose } = await createEnabledManager();
    try {
      await expect(manager.captureWindow(0x1_0000_0000)).rejects.toThrow(
        "captureWindow requires a valid macOS window id.",
      );
      expect(lastStdinLine(watchChild)).toBe("");
    } finally {
      dispose();
    }
  });

  it("drops a late capture that arrives after the captureWindow timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { manager, watchChild, captureDirectory, onCaptured, onError, dispose } =
        await createEnabledManager();
      try {
        const capturing = manager.captureWindow(77);
        await flushPromises();
        const requestId = lastStdinLine(watchChild).slice("capture-window ".length, -3);
        const assertion = expect(capturing).rejects.toThrow(
          "Timed out while capturing the requested window.",
        );
        await vi.advanceTimersByTimeAsync(20_000);
        await assertion;
        const capturePath = join(captureDirectory, "late-capture.png");
        writeFileSync(
          capturePath,
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]),
        );
        watchChild.stdout.write(
          `${JSON.stringify({
            type: "captured",
            id: requestId,
            path: capturePath,
            name: "late-capture.png",
            sourceAppName: "Safari",
          })}\n`,
        );
        watchChild.stdout.write(
          `${JSON.stringify({
            type: "error",
            id: requestId,
            code: "capture-failed",
            message: "late helper error",
          })}\n`,
        );
        await vi.waitFor(() => expect(FS.existsSync(capturePath)).toBe(false));
        await flushPromises();
        expect(onCaptured).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
        expect(await manager.listPendingCaptures()).toHaveLength(0);
      } finally {
        dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes a capture whose request times out while durable persistence is in flight", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { manager, watchChild, captureDirectory, onCaptured, dispose } =
      await createEnabledManager();
    const originalRename = FS.promises.rename;
    let markRenameStarted!: () => void;
    const renameStarted = new Promise<void>((resolve) => {
      markRenameStarted = resolve;
    });
    let releaseRename!: () => void;
    const renameRelease = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const renameSpy = vi
      .spyOn(FS.promises, "rename")
      .mockImplementationOnce(async (oldPath, newPath) => {
        markRenameStarted();
        await renameRelease;
        return originalRename(oldPath, newPath);
      });

    try {
      const capturing = manager.captureWindow(77);
      await flushPromises();
      const requestId = lastStdinLine(watchChild).slice("capture-window ".length, -3);
      const capturePath = join(captureDirectory, `appsnap-${requestId}.png`);
      writeFileSync(capturePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]));
      watchChild.stdout.write(
        `${JSON.stringify({
          type: "captured",
          id: requestId,
          path: capturePath,
          name: `appsnap-${requestId}.png`,
        })}\n`,
      );
      await renameStarted;

      const assertion = expect(capturing).rejects.toThrow(
        "Timed out while capturing the requested window.",
      );
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
      releaseRename();
      for (let index = 0; index < 6; index += 1) await flushPromises();

      expect(onCaptured).not.toHaveBeenCalled();
      expect(await manager.listPendingCaptures()).toHaveLength(0);
      expect(FS.existsSync(capturePath)).toBe(false);
    } finally {
      releaseRename();
      renameSpy.mockRestore();
      dispose();
      vi.useRealTimers();
    }
  });

  it("does not recover an interrupted picker request as an unsolicited capture", async () => {
    const { manager, watchChild, captureDirectory, dispose } = await createEnabledManager();
    try {
      const capturing = manager.captureWindow(77);
      const assertion = expect(capturing).rejects.toThrow(
        "AppSnap stopped listening while a request was in flight.",
      );
      await flushPromises();
      const requestId = lastStdinLine(watchChild).slice("capture-window ".length, -3);
      await manager.setEnabled(false);
      await assertion;

      const orphanedPickerPath = join(captureDirectory, `appsnap-${requestId}.png`);
      writeFileSync(
        orphanedPickerPath,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]),
      );
      manager.dispose();

      const restoredManager = new DesktopAppSnapManager({
        platform: "darwin",
        helperPath: process.execPath,
        captureDirectory,
        excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
        onState: vi.fn(),
        onCaptured: vi.fn(),
        onError: vi.fn(),
      });
      expect(await restoredManager.listPendingCaptures()).toHaveLength(0);
      expect(FS.existsSync(orphanedPickerPath)).toBe(false);
      restoredManager.dispose();
    } finally {
      dispose();
    }
  });

  it("recovers an unacknowledged request-driven capture after a manager restart", async () => {
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-request-restart-"));
    const firstCheckChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(firstCheckChild)
      .mockReturnValueOnce(watchChild) as unknown as typeof ChildProcess.spawn;
    const firstManager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });

    try {
      const enable = firstManager.setEnabled(true);
      await flushPromises();
      firstCheckChild.stdout.end(
        `${JSON.stringify({
          type: "permissions",
          inputMonitoring: "granted",
          screenRecording: "granted",
        })}\n`,
      );
      firstCheckChild.stderr.end();
      firstCheckChild.emit("close", 0, null);
      await enable;

      const capturing = firstManager.captureWindow(77);
      await flushPromises();
      const requestId = lastStdinLine(watchChild).slice("capture-window ".length, -3);
      const capturePath = join(captureDirectory, "req-capture.png");
      const captureBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
      writeFileSync(capturePath, captureBytes);
      watchChild.stdout.write(`${JSON.stringify({ type: "triggered", id: requestId })}\n`);
      watchChild.stdout.write(
        `${JSON.stringify({
          type: "captured",
          id: requestId,
          path: capturePath,
          name: "req-capture.png",
          sourceAppName: "Safari",
        })}\n`,
      );
      const capture = await capturing;
      firstManager.dispose();

      const restoredManager = new DesktopAppSnapManager({
        platform: "darwin",
        helperPath: process.execPath,
        captureDirectory,
        excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
        spawn,
        onState: vi.fn(),
        onCaptured: vi.fn(),
        onError: vi.fn(),
      });
      const restored = await restoredManager.listPendingCaptures();
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({
        id: requestId,
        name: "req-capture.png",
        sourceAppName: "Safari",
      });
      expect(Buffer.from(restored[0]!.bytes)).toEqual(captureBytes);

      await restoredManager.acknowledgeCapture(capture.id);
      expect(await restoredManager.listPendingCaptures()).toHaveLength(0);
      restoredManager.dispose();

      const finalManager = new DesktopAppSnapManager({
        platform: "darwin",
        helperPath: process.execPath,
        captureDirectory,
        excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
        spawn,
        onState: vi.fn(),
        onCaptured: vi.fn(),
        onError: vi.fn(),
      });
      expect(await finalManager.listPendingCaptures()).toHaveLength(0);
      finalManager.dispose();
    } finally {
      firstManager.dispose();
      rmSync(captureDirectory, { recursive: true, force: true });
    }
  });
});

describe("AppSnap permission guide", () => {
  async function createGuideManager(): Promise<{
    manager: DesktopAppSnapManager;
    guideChild: FakeChildProcess;
    onPermissionGuideState: Mock;
    spawn: Mock;
    dispose: () => void;
  }> {
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-guide-"));
    const guideChild = createFakeChildProcess();
    const spawn = vi.fn().mockReturnValueOnce(guideChild);
    const onPermissionGuideState = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara Test",
      appBundlePath: "/Applications/Synara Test.app",
      spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
      onPermissionGuideState,
    });
    manager.showPermissionGuide("input-monitoring");
    await flushPromises();
    return {
      manager,
      guideChild,
      onPermissionGuideState,
      spawn,
      dispose: () => {
        manager.dispose();
        rmSync(captureDirectory, { recursive: true, force: true });
      },
    };
  }

  function lastStdinLine(child: FakeChildProcess): string {
    return child.stdin.read()?.toString().trimEnd() ?? "";
  }

  it("spawns the helper in permission-guide mode with the right arguments", async () => {
    const { guideChild, dispose, spawn } = await createGuideManager();
    try {
      expect(lastStdinLine(guideChild)).toBe("");
      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        [
          "--permission-guide",
          "--pane",
          "input-monitoring",
          "--app-path",
          "/Applications/Synara Test.app",
          "--app-name",
          "Synara Test",
        ],
        expect.any(Object),
      );
    } finally {
      dispose();
    }
  });

  it("forwards guide state events to the renderer", async () => {
    const { manager, guideChild, onPermissionGuideState, dispose } = await createGuideManager();
    try {
      guideChild.stdout.write(`${JSON.stringify({ type: "permission-guide", state: "shown" })}\n`);
      await flushPromises();
      expect(onPermissionGuideState).not.toHaveBeenCalledWith("shown");
      guideChild.stdout.write(
        `${JSON.stringify({ type: "permission-guide", state: "granted" })}\n`,
      );
      await flushPromises();
      expect(onPermissionGuideState).toHaveBeenCalledWith("granted");
    } finally {
      dispose();
    }
  });

  it("writes close and SIGTERMs the guide when hidden", async () => {
    const { manager, guideChild, dispose } = await createGuideManager();
    try {
      manager.hidePermissionGuide();
      await flushPromises();
      expect(guideChild.stdin.read()?.toString().trimEnd()).toBe("close");
      expect(guideChild.kill).not.toHaveBeenCalled();
      // Wait for the 500 ms SIGTERM delay to elapse.
      await new Promise<void>((resolve) => setTimeout(resolve, 600));
      expect(guideChild.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      dispose();
    }
  });

  it("forwards a crash/exit as closed when no final state was emitted", async () => {
    const { manager, guideChild, onPermissionGuideState, dispose } = await createGuideManager();
    try {
      guideChild.stdout.write(`${JSON.stringify({ type: "permission-guide", state: "shown" })}\n`);
      await flushPromises();
      guideChild.emit("exit", 1, null);
      guideChild.stdout.end();
      guideChild.stderr.end();
      guideChild.emit("close", 1, null);
      await flushPromises();
      expect(onPermissionGuideState).toHaveBeenLastCalledWith("closed");
    } finally {
      dispose();
    }
  });

  it("never raises an OS prompt when a guide opens", async () => {
    // No macOS prompt is ever raised by a guide: the inline steps plus the
    // coach are the whole flow. A denied prompt cannot be re-raised, while the
    // Settings page (toggle, or drag-and-drop where the list accepts it)
    // always works.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-guide-ax-"));
    const guideChild = createFakeChildProcess();
    const spawn = vi.fn().mockImplementation((_file: string, args: readonly string[]) => {
      if (args.includes("--permission-guide")) return guideChild;
      const requestChild = createFakeChildProcess();
      setImmediate(() => {
        requestChild.stdout.end(
          `${JSON.stringify({ type: "permissions", accessibility: "denied" })}\n`,
        );
        requestChild.stderr.end();
        requestChild.emit("close", 0, null);
      });
      return requestChild;
    });
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara Test",
      appBundlePath: "/Applications/Synara Test.app",
      spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
      onPermissionGuideState: vi.fn(),
    });
    try {
      manager.showPermissionGuide("accessibility");
      await flushPromises();
      expect(spawn).not.toHaveBeenCalledWith(
        process.execPath,
        ["--request-permissions", "--permission", "accessibility"],
        expect.any(Object),
      );
      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        expect.arrayContaining(["--permission-guide", "--pane", "accessibility"]),
        expect.any(Object),
      );
      // Renderer parity: the OS request never fires. Later watch ticks
      // re-check via --check-permissions (deduped while in flight).
      const requestCalls = () =>
        spawn.mock.calls.filter(([, args]) =>
          (args as readonly string[]).includes("--request-permissions"),
        );
      expect(requestCalls()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(800);
      await flushPromises();
      await vi.advanceTimersByTimeAsync(800);
      await flushPromises();
      expect(requestCalls()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      manager.dispose();
      rmSync(captureDirectory, { recursive: true, force: true });
    }
  });

  it("closes the guide when a fresh check sees the grant the coach cannot", async () => {
    // Accessibility grants never reach an already-running process, so the
    // coach's own poll stays false; the manager's fresh-helper watch must
    // detect the grant and retire the coach instead. Mock timers drive the
    // 800ms tick deterministically; in-flight dedup keeps overlapping ticks
    // from queueing a second check while the first is still pending.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-guide-watch-"));
    const guideChild = createFakeChildProcess();
    const spawn = vi.fn().mockImplementation((_file: string, args: readonly string[]) => {
      if (args.includes("--permission-guide")) return guideChild;
      const checkChild = createFakeChildProcess();
      setImmediate(() => {
        checkChild.stdout.end(
          `${JSON.stringify({ type: "permissions", accessibility: "granted" })}\n`,
        );
        checkChild.stderr.end();
        checkChild.emit("close", 0, null);
      });
      return checkChild;
    });
    const onPermissionGuideState = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara Test",
      appBundlePath: "/Applications/Synara Test.app",
      spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
      onPermissionGuideState,
    });
    try {
      manager.showPermissionGuide("accessibility");
      await flushPromises();
      expect(onPermissionGuideState).not.toHaveBeenCalledWith("granted");
      await vi.advanceTimersByTimeAsync(800);
      await flushPromises();
      await flushPromises();
      expect(onPermissionGuideState).toHaveBeenCalledWith("granted");
      expect(lastStdinLine(guideChild)).toBe("close");
    } finally {
      vi.useRealTimers();
      manager.dispose();
      rmSync(captureDirectory, { recursive: true, force: true });
    }
  });

  it("skips overlapping watch ticks while a grant check is in flight", async () => {
    // In-flight dedup: the second 800ms tick must not spawn a second helper
    // while the first check has not answered yet; once it resolves, the next
    // tick may poll again.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-guide-dedup-"));
    const guideChild = createFakeChildProcess();
    const checkChildren: FakeChildProcess[] = [];
    let releaseFirstCheck!: () => void;
    const firstCheckGate = new Promise<void>((resolve) => {
      releaseFirstCheck = resolve;
    });
    const spawn = vi.fn().mockImplementation((_file: string, args: readonly string[]) => {
      if (args.includes("--permission-guide")) return guideChild;
      const checkChild = createFakeChildProcess();
      checkChildren.push(checkChild);
      if (checkChildren.length === 1) {
        void firstCheckGate.then(() => {
          checkChild.stdout.end(
            `${JSON.stringify({ type: "permissions", inputMonitoring: "denied" })}\n`,
          );
          checkChild.stderr.end();
          checkChild.emit("close", 0, null);
        });
      } else {
        setImmediate(() => {
          checkChild.stdout.end(
            `${JSON.stringify({ type: "permissions", inputMonitoring: "denied" })}\n`,
          );
          checkChild.stderr.end();
          checkChild.emit("close", 0, null);
        });
      }
      return checkChild;
    });
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara Test",
      appBundlePath: "/Applications/Synara Test.app",
      spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
      onPermissionGuideState: vi.fn(),
    });
    try {
      manager.showPermissionGuide("input-monitoring");
      await flushPromises();
      await vi.advanceTimersByTimeAsync(800);
      await flushPromises();
      expect(checkChildren).toHaveLength(1);
      // Second tick fires while the first check is still pending: no new spawn.
      await vi.advanceTimersByTimeAsync(800);
      await flushPromises();
      expect(checkChildren).toHaveLength(1);
      releaseFirstCheck();
      await flushPromises();
      await flushPromises();
      // Pending cleared: the next tick polls again.
      await vi.advanceTimersByTimeAsync(800);
      await flushPromises();
      await flushPromises();
      expect(checkChildren).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      manager.dispose();
      rmSync(captureDirectory, { recursive: true, force: true });
    }
  });

  it("closes an ungranted guide after the 10-minute watch bound", async () => {
    // The grant watch must not poll forever: after 10 minutes without a grant
    // it stops, emits closed honestly via the existing guide-state plumbing,
    // and pushes the current snapshot via the existing onState path. No new IPC.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-guide-bound-"));
    const guideChild = createFakeChildProcess();
    const onState = vi.fn();
    const spawn = vi.fn().mockImplementation((_file: string, args: readonly string[]) => {
      if (args.includes("--permission-guide")) return guideChild;
      const checkChild = createFakeChildProcess();
      setImmediate(() => {
        checkChild.stdout.end(
          `${JSON.stringify({ type: "permissions", accessibility: "denied" })}\n`,
        );
        checkChild.stderr.end();
        checkChild.emit("close", 0, null);
      });
      return checkChild;
    });
    const onPermissionGuideState = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara Test",
      appBundlePath: "/Applications/Synara Test.app",
      spawn,
      onState,
      onCaptured: vi.fn(),
      onError: vi.fn(),
      onPermissionGuideState,
    });
    try {
      manager.showPermissionGuide("accessibility");
      await flushPromises();
      expect(onPermissionGuideState).not.toHaveBeenCalledWith("closed");
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      await flushPromises();
      await flushPromises();
      expect(onPermissionGuideState).toHaveBeenCalledWith("closed");
      expect(lastStdinLine(guideChild)).toBe("close");
      const closedCalls = onPermissionGuideState.mock.calls.filter(
        ([state]) => state === "closed",
      ).length;
      // Bound cleared on stop: further time never re-emits.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      await flushPromises();
      expect(onPermissionGuideState.mock.calls.filter(([state]) => state === "closed").length).toBe(
        closedCalls,
      );
    } finally {
      vi.useRealTimers();
      manager.dispose();
      rmSync(captureDirectory, { recursive: true, force: true });
    }
  });
});

describe("AppSnap setup registration failures", () => {
  const setupFailure = {
    type: "error",
    code: "permission_setup_registration_unresolved",
    message: "Move this app to Applications and reopen it before granting access.",
  };

  it("stops before opening Settings or a coach and preserves the error through passive refresh", async () => {
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-registration-"));
    const calls: string[][] = [];
    let registrationFails = true;
    const spawn = vi.fn((_file: string, args: readonly string[]) => {
      calls.push([...args]);
      const child = createFakeChildProcess();
      setImmediate(() => {
        child.stdout.end(
          `${JSON.stringify(args[0] === "--prepare-permission-setup" && registrationFails ? setupFailure : { type: "permissions", accessibility: "granted", inputMonitoring: "granted", screenRecording: "granted" })}\n`,
        );
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    });
    const openSettingsPane = vi.fn();
    const onError = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appBundlePath: "/Applications/Synara Test.app",
      appDisplayName: "Synara Test",
      spawn: spawn as unknown as typeof ChildProcess.spawn,
      openSettingsPane,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError,
    });
    try {
      const failed = await manager.startPermissionSetup([
        "accessibility",
        "screenRecording",
        "inputMonitoring",
      ]);
      expect(failed).toMatchObject({
        status: "error",
        message: setupFailure.message,
        permissionSetupErrorCode: setupFailure.code,
      });
      expect(calls[0]).toEqual([
        "--prepare-permission-setup",
        "--permission",
        "accessibility",
        "--permission",
        "screenRecording",
        "--permission",
        "inputMonitoring",
        "--app-path",
        "/Applications/Synara Test.app",
      ]);
      expect(openSettingsPane).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: setupFailure.code, message: setupFailure.message }),
        true,
      );
      const refreshed = await manager.refreshState([
        "accessibility",
        "screenRecording",
        "inputMonitoring",
      ]);
      expect(refreshed).toMatchObject({
        status: "error",
        message: setupFailure.message,
        permissionSetupErrorCode: setupFailure.code,
      });
      expect(calls.map((args) => args[0])).toEqual([
        "--prepare-permission-setup",
        "--check-permissions",
      ]);
      registrationFails = false;
      expect(
        (
          await manager.startPermissionSetup([
            "accessibility",
            "screenRecording",
            "inputMonitoring",
          ])
        ).message,
      ).toBeNull();
      expect(manager.getState().permissionSetupErrorCode).toBeUndefined();
      expect(openSettingsPane).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
      rmSync(captureDirectory, { recursive: true, force: true });
    }
  });

  it("drains an exiting coach registration failure and cancels its poll", async () => {
    vi.useFakeTimers();
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-coach-registration-"));
    const child = createFakeChildProcess();
    const spawn = vi.fn(() => child);
    const onPermissionGuideState = vi.fn();
    const onError = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appBundlePath: "/Applications/Synara Test.app",
      appDisplayName: "Synara Test",
      spawn: spawn as unknown as typeof ChildProcess.spawn,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError,
      onPermissionGuideState,
    });
    try {
      manager.showPermissionGuide("screen-recording");
      child.emit("exit", 1, null);
      child.stdout.end(`${JSON.stringify(setupFailure)}\n`);
      child.stderr.end();
      child.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.getState()).toMatchObject({ status: "error", message: setupFailure.message });
      expect(onPermissionGuideState).toHaveBeenLastCalledWith("closed");
      expect(child.stdin.read()?.toString()).toBe("close\n");
      await vi.advanceTimersByTimeAsync(2_500);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledOnce();
    } finally {
      manager.dispose();
      vi.useRealTimers();
      rmSync(captureDirectory, { recursive: true, force: true });
    }
  });
});

describe("AppSnap permission setup sessions", () => {
  function createSessionManager(state: {
    accessibility: string;
    screenRecording: string;
    inputMonitoring: string;
  }): {
    manager: DesktopAppSnapManager;
    guideChildren: FakeChildProcess[];
    requests: string[];
    openSettingsPane: Mock;
    closeSettingsApp: Mock;
    onPermissionGuideState: Mock;
    dispose: () => void;
  } {
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-session-"));
    const guideChildren: FakeChildProcess[] = [];
    const requests: string[] = [];
    const openSettingsPane = vi.fn();
    const closeSettingsApp = vi.fn();
    const onPermissionGuideState = vi.fn();
    const spawn = vi.fn().mockImplementation((_file: string, args: readonly string[]) => {
      if (args.includes("--permission-guide")) {
        const child = createFakeChildProcess();
        guideChildren.push(child);
        return child;
      }
      const child = createFakeChildProcess();
      if (args.includes("--request-permissions")) requests.push(args.join(" "));
      setImmediate(() => {
        child.stdout.end(`${JSON.stringify({ type: "permissions", ...state })}\n`);
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    });
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      appDisplayName: "Synara Test",
      appBundlePath: "/Applications/Synara Test.app",
      spawn,
      openSettingsPane,
      closeSettingsApp,
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
      onPermissionGuideState,
    });
    return {
      manager,
      guideChildren,
      requests,
      openSettingsPane,
      closeSettingsApp,
      onPermissionGuideState,
      dispose: () => {
        manager.dispose();
        rmSync(captureDirectory, { recursive: true, force: true });
      },
    };
  }

  it("walks each missing pane in sequence with no OS prompt, then closes Settings", async () => {
    const state = { accessibility: "denied", screenRecording: "denied", inputMonitoring: "denied" };
    const { manager, guideChildren, requests, openSettingsPane, closeSettingsApp, dispose } =
      createSessionManager(state);
    try {
      // Callers may pass kinds out of order with dupes: the queue build sorts
      // into [accessibility, inputMonitoring, screenRecording] and dedupes, so
      // a single queue with its shift-only consumer still walks each pane once.
      await manager.startPermissionSetup(["screenRecording", "accessibility", "screenRecording"]);
      await flushPromises();
      // Only the first missing pane is up: its settings page and its coach.
      // No macOS prompt ever fires.
      expect(openSettingsPane).toHaveBeenLastCalledWith("accessibility");
      expect(requests).toEqual([]);
      expect(guideChildren).toHaveLength(1);

      // The grant watch sees Accessibility flip: the first coach closes and the
      // session advances to Screen Recording on its own.
      state.accessibility = "granted";
      await vi.waitFor(() => expect(guideChildren).toHaveLength(2), { timeout: 4000 });
      expect(guideChildren[0]!.stdin.read()?.toString().trimEnd()).toBe("close");
      expect(openSettingsPane).toHaveBeenLastCalledWith("screen-recording");
      expect(requests).toEqual([]);

      state.screenRecording = "granted";
      await vi.waitFor(
        () => expect(guideChildren[1]!.stdin.read()?.toString().trimEnd()).toBe("close"),
        { timeout: 4000 },
      );
      await flushPromises();
      // The session is done: two panes opened, two coaches, no OS prompts, and
      // the Settings the session opened is closed again.
      expect(openSettingsPane).toHaveBeenCalledTimes(2);
      expect(guideChildren).toHaveLength(2);
      expect(closeSettingsApp).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it("skips panes that are already granted", async () => {
    const state = {
      accessibility: "granted",
      screenRecording: "denied",
      inputMonitoring: "denied",
    };
    const { manager, guideChildren, requests, openSettingsPane, closeSettingsApp, dispose } =
      createSessionManager(state);
    try {
      await manager.startPermissionSetup(["accessibility", "screenRecording"]);
      await flushPromises();
      expect(openSettingsPane).toHaveBeenCalledExactlyOnceWith("screen-recording");
      expect(requests).toEqual([]);
      expect(guideChildren).toHaveLength(1);
      // The session is still mid-walk: Settings stays open.
      expect(closeSettingsApp).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("ends the session when the coach is dismissed instead of respawning", async () => {
    const state = { accessibility: "denied", screenRecording: "denied", inputMonitoring: "denied" };
    const { manager, guideChildren, requests, closeSettingsApp, onPermissionGuideState, dispose } =
      createSessionManager(state);
    try {
      await manager.startPermissionSetup(["accessibility", "screenRecording"]);
      await flushPromises();
      expect(guideChildren).toHaveLength(1);
      // The user dismisses the first coach: the exit is not a grant, so the
      // session must stop rather than open the next pane over their dismissal.
      // A dismissed session never closes the user's Settings either.
      guideChildren[0]!.emit("exit", 0, null);
      guideChildren[0]!.stdout.end();
      guideChildren[0]!.stderr.end();
      guideChildren[0]!.emit("close", 0, null);
      await flushPromises();
      await new Promise<void>((resolve) => setTimeout(resolve, 900));
      expect(onPermissionGuideState).toHaveBeenLastCalledWith("closed");
      expect(guideChildren).toHaveLength(1);
      expect(requests).toEqual([]);
      expect(closeSettingsApp).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("reports closed and ends the session when the guide helper fails to spawn", async () => {
    const state = { accessibility: "denied", screenRecording: "denied", inputMonitoring: "denied" };
    const { manager, guideChildren, requests, closeSettingsApp, onPermissionGuideState, dispose } =
      createSessionManager(state);
    try {
      await manager.startPermissionSetup(["accessibility", "screenRecording"]);
      await flushPromises();
      expect(guideChildren).toHaveLength(1);
      // A spawn-level failure (EACCES/ENOENT) emits `error` without `exit`.
      guideChildren[0]!.emit("error", new Error("spawn EACCES"));
      await flushPromises();
      await new Promise<void>((resolve) => setTimeout(resolve, 900));
      expect(onPermissionGuideState).toHaveBeenLastCalledWith("closed");
      expect(guideChildren).toHaveLength(1);
      expect(requests).toEqual([]);
      expect(closeSettingsApp).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("opens and closes nothing when every grant is already held", async () => {
    const { manager, guideChildren, openSettingsPane, closeSettingsApp, dispose } =
      createSessionManager({
        accessibility: "granted",
        screenRecording: "granted",
        inputMonitoring: "granted",
      });
    try {
      await manager.startPermissionSetup(["accessibility", "screenRecording"]);
      await flushPromises();
      expect(guideChildren).toHaveLength(0);
      expect(openSettingsPane).not.toHaveBeenCalled();
      expect(closeSettingsApp).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});

describe("explicit AppSnap observation", () => {
  it("captures while disabled without permission or manual callback side effects", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synara-appsnap-request-"));
    const child = createFakeChildProcess();
    let outputDirectory = "";
    const spawn = vi.fn((_file: string, args: readonly string[]) => {
      outputDirectory = args[args.indexOf("--output-dir") + 1]!;
      return child;
    });
    const onCaptured = vi.fn();
    const onError = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: "/fake/helper",
      captureDirectory: directory,
      excludedBundleId: "synara",
      onState: vi.fn(),
      onCaptured,
      onError,
      spawn: spawn as unknown as typeof ChildProcess.spawn,
    });
    try {
      const capture = manager.captureCurrentApp("requested");
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      expect(spawn.mock.calls[0]?.[1]).toContain("--external-trigger");
      child.stdout.write('{"type":"ready"}\n');
      expect(child.stdin.read()?.toString()).toBe("trigger\n");
      const imagePath = join(outputDirectory, "capture.png");
      writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]));
      child.stdout.write(
        `${JSON.stringify({ type: "captured", id: "frame", path: imagePath, name: "capture.png", capturedAt: "2026-09-08T12:00:00Z", sourceAppName: "Preview" })}\n`,
      );
      await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));
      expect(FS.existsSync(outputDirectory)).toBe(true);
      await expect(manager.captureCurrentApp("while-exiting")).rejects.toThrow("in progress");
      child.emit("exit", 0, null);
      await expect(capture).resolves.toMatchObject({ id: "frame", sourceAppName: "Preview" });
      expect(manager.getState().enabled).toBe(false);
      expect(onCaptured).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(FS.existsSync(outputDirectory)).toBe(false);
    } finally {
      manager.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("cancels only the matching request and rejects concurrent requests", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synara-appsnap-cancel-"));
    const child = createFakeChildProcess();
    const spawn = vi.fn(() => child);
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: "/fake/helper",
      captureDirectory: directory,
      excludedBundleId: "synara",
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
      spawn: spawn as unknown as typeof ChildProcess.spawn,
    });
    try {
      const capture = manager.captureCurrentApp("cancel-me");
      const rejected = expect(capture).rejects.toThrow("cancelled");
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      await expect(manager.captureCurrentApp("second")).rejects.toThrow("in progress");
      manager.cancelCapture("unrelated");
      expect(child.kill).not.toHaveBeenCalled();
      manager.cancelCapture("cancel-me");
      await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));
      await expect(manager.captureCurrentApp("still-exiting")).rejects.toThrow("in progress");
      child.emit("exit", null, "SIGTERM");
      await rejected;
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      manager.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("AppSnap bounded helper shutdown", () => {
  it("escalates only its owned helper and holds the request until exit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synara-appsnap-shutdown-"));
    const child = createFakeChildProcess();
    const spawn = vi.fn(() => child);
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: "/fake/helper",
      captureDirectory: directory,
      excludedBundleId: "synara",
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
      spawn: spawn as unknown as typeof ChildProcess.spawn,
    });
    try {
      const capture = manager.captureCurrentApp("shutdown");
      const rejected = expect(capture).rejects.toThrow("cancelled");
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      vi.useFakeTimers();
      manager.cancelCapture("shutdown");
      await vi.advanceTimersByTimeAsync(0);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
      await expect(manager.captureCurrentApp("blocked")).rejects.toThrow("in progress");
      child.emit("exit", null, "SIGKILL");
      await rejected;
      expect(FS.readdirSync(directory)).toEqual([]);
    } finally {
      vi.useRealTimers();
      manager.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function fakeWindowsSource(
  id: string,
  name: string,
  png: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
) {
  return { id, name, thumbnail: { toPNG: () => png } };
}

function variedBitmap(): Buffer {
  const bitmap = Buffer.alloc(8 * 8 * 4);
  for (let index = 0; index < 64; index += 1) {
    const offset = index * 4;
    bitmap[offset] = (index * 37) % 256;
    bitmap[offset + 1] = (index * 91) % 256;
    bitmap[offset + 2] = (index * 13) % 256;
    bitmap[offset + 3] = 255;
  }
  return bitmap;
}

function stubNativeImageBlankness(blankBuffers: readonly Buffer[]): void {
  vi.mocked(nativeImage.createFromBuffer).mockImplementation((png: Buffer) => {
    const blank = blankBuffers.some((blankPng) => png.equals(blankPng));
    return {
      isEmpty: () => false,
      getSize: () => ({ width: 8, height: 8 }),
      toBitmap: () => (blank ? Buffer.alloc(8 * 8 * 4, 0) : variedBitmap()),
    } as ReturnType<typeof nativeImage.createFromBuffer>;
  });
}

describe("Windows native AppSnap", () => {
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

  function createWindowsManager(
    options: {
      enabled?: boolean;
      shortcutRegistry?: { register: Mock; unregister: Mock };
      windowsCaptureProbe?: DesktopAppSnapManagerOptions["windowsCaptureProbe"];
    } = {},
  ) {
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-win-"));
    const spawn = vi.fn();
    const onState = vi.fn();
    const onCaptured = vi.fn();
    const onError = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "win32",
      helperPath: "C:\\missing\\synara-appsnap-helper.exe",
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      spawn: spawn as unknown as typeof ChildProcess.spawn,
      ...(options.shortcutRegistry ? { shortcutRegistry: options.shortcutRegistry } : {}),
      ...(options.windowsCaptureProbe ? { windowsCaptureProbe: options.windowsCaptureProbe } : {}),
      onState,
      onCaptured,
      onError,
    });
    return {
      manager,
      captureDirectory,
      spawn,
      onState,
      onCaptured,
      onError,
      async enable() {
        if (options.enabled !== false) await manager.setEnabled(true);
      },
      dispose() {
        manager.dispose();
        rmSync(captureDirectory, { recursive: true, force: true });
        vi.mocked(desktopCapturer.getSources).mockReset();
        vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
        vi.mocked(nativeImage.createFromBuffer).mockReset();
        vi.mocked(nativeImage.createFromBuffer).mockImplementation(
          () =>
            ({
              isEmpty: () => false,
              getSize: () => ({ width: 8, height: 8 }),
              toBitmap: () => variedBitmap(),
            }) as ReturnType<typeof nativeImage.createFromBuffer>,
        );
      },
    };
  }

  it("initializes on Windows without throwing an unsupported state", () => {
    const f = createWindowsManager({ enabled: false });
    try {
      expect(f.manager.getState()).toMatchObject({
        platform: "windows",
        supported: true,
        enabled: false,
        status: "disabled",
        message: null,
        shortcut: { kind: "key-chord", modifier: "control", key: "KeyY" },
        inputMonitoringPermission: "unknown",
        screenRecordingPermission: "unknown",
      });
    } finally {
      f.dispose();
    }
  });

  it("probes Windows registration and rejects the macOS-only both-option-keys default", async () => {
    const register = vi.fn(() => true);
    const unregister = vi.fn();
    const f = createWindowsManager({
      enabled: false,
      shortcutRegistry: { register, unregister },
    });
    try {
      expect(f.manager.checkShortcut({ kind: "both-option-keys" })).toEqual({
        available: false,
        reason: "Both Option keys are a macOS-only shortcut. Choose a modifier and one other key.",
      });
      expect(
        f.manager.checkShortcut({ kind: "key-chord", modifier: "option", key: "KeyX" }),
      ).toEqual({ available: true, reason: null });
      expect(register).toHaveBeenCalledWith("Alt+X", expect.any(Function));
      expect(unregister).toHaveBeenCalledWith("Alt+X");

      const adopted = await f.manager.setShortcut({
        kind: "key-chord",
        modifier: "option",
        key: "KeyX",
      });
      expect(adopted.availability).toEqual({ available: true, reason: null });
      expect(adopted.state.shortcut).toEqual({
        kind: "key-chord",
        modifier: "option",
        key: "KeyX",
      });
    } finally {
      f.dispose();
    }
  });

  it("reserves a key-chord when enabling and captures the frontmost window on trigger", async () => {
    let windowsShortcutCallback: (() => void) | undefined;
    const register = vi.fn((_accelerator: string, callback: () => void) => {
      windowsShortcutCallback = callback;
      return true;
    });
    const unregister = vi.fn();
    const f = createWindowsManager({
      enabled: false,
      shortcutRegistry: { register, unregister },
    });
    try {
      await f.manager.setShortcut({ kind: "key-chord", modifier: "option", key: "KeyX" });
      const enabled = await f.manager.setEnabled(true);
      expect(enabled).toMatchObject({ status: "ready", enabled: true });
      expect(register).toHaveBeenCalledWith("Alt+X", expect.any(Function));

      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        fakeWindowsSource("window:555:0", "Notepad", PNG_BYTES),
      ] as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      windowsShortcutCallback?.();
      await vi.waitFor(() => expect(f.onCaptured).toHaveBeenCalledTimes(1));
      expect(f.onCaptured).toHaveBeenCalledWith(
        expect.objectContaining({
          mimeType: "image/png",
          sourceAppName: "Notepad",
          sizeBytes: PNG_BYTES.byteLength,
        }),
      );
      expect(await f.manager.listPendingCaptures()).toHaveLength(1);

      const disabled = await f.manager.setEnabled(false);
      expect(disabled.status).toBe("disabled");
      expect(unregister).toHaveBeenCalledWith("Alt+X");
    } finally {
      f.dispose();
    }
  });

  it("reports an error while enabled with the macOS-only both-option-keys shortcut", async () => {
    const f = createWindowsManager({ enabled: false });
    try {
      await f.manager.setShortcut({ kind: "both-option-keys" });
      const enabled = await f.manager.setEnabled(true);
      expect(enabled).toMatchObject({
        status: "error",
        enabled: true,
        message: "Both Option keys are a macOS-only shortcut. Choose a modifier and one other key.",
      });
    } finally {
      f.dispose();
    }
  });

  it("reports when another app owns the Windows accelerator", () => {
    const f = createWindowsManager({
      enabled: false,
      shortcutRegistry: { register: vi.fn(() => false), unregister: vi.fn() },
    });
    try {
      expect(
        f.manager.checkShortcut({ kind: "key-chord", modifier: "option", key: "KeyX" }),
      ).toEqual({
        available: false,
        reason: "Windows or another app is already using this shortcut.",
      });
    } finally {
      f.dispose();
    }
  });

  it("short-circuits refresh and permission setup without spawning a helper", async () => {
    const f = createWindowsManager({ enabled: false });
    try {
      const refreshed = await f.manager.refreshState([
        "accessibility",
        "inputMonitoring",
        "screenRecording",
      ]);
      expect(f.spawn).not.toHaveBeenCalled();
      expect(refreshed).toMatchObject({
        inputMonitoringPermission: "granted",
        screenRecordingPermission: "granted",
        status: "disabled",
      });

      await f.manager.setEnabled(true);
      const setup = await f.manager.startPermissionSetup(["screenRecording"]);
      expect(f.spawn).not.toHaveBeenCalled();
      expect(setup).toMatchObject({
        // Default Ctrl+Y cannot be reserved without a globalShortcut registry;
        // picker APIs still work while the shortcut row reports the conflict.
        status: "error",
        enabled: true,
        screenRecordingPermission: "granted",
      });
      expect(await f.manager.releaseHeldInput()).toBe(false);
      expect(f.spawn).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it("parses desktopCapturer window ids to HWND values", () => {
    expect(parseWindowsWindowId("window:12345:0")).toBe(12345);
    expect(parseWindowsWindowId("window:4294967295:0")).toBe(4294967295);
    expect(parseWindowsWindowId("screen:0:0")).toBeNull();
    expect(parseWindowsWindowId("window:0:0")).toBeNull();
    expect(parseWindowsWindowId("window:4294967296:0")).toBeNull();
    expect(parseWindowsWindowId("window:not-a-number:0")).toBeNull();
  });

  it("lists windows with parsed HWND ids and excludes Synara's own windows", async () => {
    const f = createWindowsManager();
    try {
      const synaraHandle = Buffer.alloc(4);
      synaraHandle.writeUInt32LE(12345, 0);
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
        { getNativeWindowHandle: () => synaraHandle },
      ] as unknown as ReturnType<typeof BrowserWindow.getAllWindows>);
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        fakeWindowsSource("window:12345:0", "Synara"),
        fakeWindowsSource("window:67890:0", "Notepad"),
        fakeWindowsSource("screen:0:0", "Entire screen"),
        fakeWindowsSource("window:0:0", "Invalid"),
      ] as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      await f.enable();
      const windows = await f.manager.listWindows();
      expect(windows).toEqual([
        {
          windowId: 67890,
          appName: "Notepad",
          bundleIdentifier: null,
          windowTitle: "Notepad",
          appIconDataUrl: null,
        },
      ]);
    } finally {
      f.dispose();
    }
  });

  it("captures a window, persists the PNG, and emits a well-formed capture payload", async () => {
    const f = createWindowsManager();
    try {
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        fakeWindowsSource("window:77:0", "Notepad", PNG_BYTES),
      ] as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      await f.enable();
      const capture = await f.manager.captureWindow(77);
      expect(capture).toMatchObject({
        mimeType: "image/png",
        sizeBytes: PNG_BYTES.byteLength,
        name: expect.stringMatching(/^appsnap-picker-[a-f0-9-]{36}\.png$/),
        sourceAppName: "Notepad",
        sourceWindowTitle: "Notepad",
        sourceBundleIdentifier: null,
      });
      expect(capture.bytes.byteLength).toBe(PNG_BYTES.byteLength);
      expect(Buffer.from(capture.bytes)).toEqual(PNG_BYTES);

      const files = readdirSync(f.captureDirectory);
      const pendingPng = files.find((entry) => /^pending-[a-f0-9]{64}\.png$/.test(entry));
      expect(pendingPng).toBeDefined();
      expect(FS.readFileSync(join(f.captureDirectory, pendingPng!))).toEqual(PNG_BYTES);
      expect(files.some((entry) => entry.startsWith("appsnap-picker-"))).toBe(false);
      expect(await f.manager.listPendingCaptures()).toHaveLength(1);
    } finally {
      f.dispose();
    }
  });

  it("rejects captureWindow when the HWND is gone", async () => {
    const f = createWindowsManager();
    try {
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        fakeWindowsSource("window:1:0", "Other"),
      ] as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      await f.enable();
      await expect(f.manager.captureWindow(999)).rejects.toThrow(
        "Window 999 is no longer available. (window_unavailable)",
      );
      expect(await f.manager.listPendingCaptures()).toEqual([]);
    } finally {
      f.dispose();
    }
  });

  it("rejects captureWindow when the window returns a blank frame", async () => {
    const f = createWindowsManager();
    const blankPng = Buffer.alloc(64, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(blankPng, 0);
    try {
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        fakeWindowsSource("window:77:0", "Screen Recorder", blankPng),
      ] as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>);
      stubNativeImageBlankness([blankPng]);

      await f.enable();
      await expect(f.manager.captureWindow(77)).rejects.toThrow(/blank frame.*\(capture-blocked\)/);
      expect(await f.manager.listPendingCaptures()).toEqual([]);
    } finally {
      f.dispose();
    }
  });

  it("captures the first non-Synara window via captureCurrentApp", async () => {
    const f = createWindowsManager();
    try {
      const synaraHandle = Buffer.alloc(4);
      synaraHandle.writeUInt32LE(111, 0);
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
        { getNativeWindowHandle: () => synaraHandle },
      ] as unknown as ReturnType<typeof BrowserWindow.getAllWindows>);
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        fakeWindowsSource("window:111:0", "Synara"),
        fakeWindowsSource("window:222:0", "Explorer", PNG_BYTES),
      ] as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      const capture = await f.manager.captureCurrentApp("win-current");
      expect(capture).toMatchObject({
        mimeType: "image/png",
        sizeBytes: PNG_BYTES.byteLength,
        sourceAppName: "Explorer",
      });
      expect(Buffer.from(capture.bytes)).toEqual(PNG_BYTES);
    } finally {
      f.dispose();
    }
  });

  it("rejects captureCurrentApp when the chosen window returns a blank frame", async () => {
    const f = createWindowsManager();
    const blankPng = Buffer.alloc(64, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(blankPng, 0);
    try {
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        fakeWindowsSource("window:555:0", "Screen Recorder", blankPng),
      ] as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>);
      stubNativeImageBlankness([blankPng]);

      await expect(f.manager.captureCurrentApp("win-blank")).rejects.toThrow(/blank frame/);
      expect(await f.manager.listPendingCaptures()).toEqual([]);
    } finally {
      f.dispose();
    }
  });

  it("skips a blank top window and captures the next viable one on hotkey", async () => {
    let windowsShortcutCallback: (() => void) | undefined;
    const register = vi.fn((_accelerator: string, callback: () => void) => {
      windowsShortcutCallback = callback;
      return true;
    });
    const f = createWindowsManager({
      enabled: false,
      shortcutRegistry: { register, unregister: vi.fn() },
    });
    const blankPng = Buffer.alloc(64, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(blankPng, 0);
    try {
      await f.manager.setShortcut({ kind: "key-chord", modifier: "option", key: "KeyX" });
      await f.manager.setEnabled(true);
      stubNativeImageBlankness([blankPng]);

      const synaraHandle = Buffer.alloc(4);
      synaraHandle.writeUInt32LE(111, 0);
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
        { getNativeWindowHandle: () => synaraHandle },
      ] as unknown as ReturnType<typeof BrowserWindow.getAllWindows>);
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        fakeWindowsSource("window:111:0", "Synara", PNG_BYTES),
        fakeWindowsSource("window:333:0", "Screen Recorder", blankPng),
        fakeWindowsSource("window:444:0", "Windows Terminal", PNG_BYTES),
      ] as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      windowsShortcutCallback?.();
      await vi.waitFor(() => expect(f.onCaptured).toHaveBeenCalledTimes(1));
      expect(f.onCaptured).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceAppName: "Windows Terminal",
          sizeBytes: PNG_BYTES.byteLength,
        }),
      );
      expect(await f.manager.listPendingCaptures()).toHaveLength(1);
    } finally {
      f.dispose();
    }
  });

  it("emits capture-blocked instead of attaching a blank frame on hotkey", async () => {
    let windowsShortcutCallback: (() => void) | undefined;
    const register = vi.fn((_accelerator: string, callback: () => void) => {
      windowsShortcutCallback = callback;
      return true;
    });
    const f = createWindowsManager({
      enabled: false,
      shortcutRegistry: { register, unregister: vi.fn() },
    });
    const blankPng = Buffer.alloc(64, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(blankPng, 0);
    try {
      await f.manager.setShortcut({ kind: "key-chord", modifier: "option", key: "KeyX" });
      await f.manager.setEnabled(true);
      stubNativeImageBlankness([blankPng]);
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        fakeWindowsSource("window:555:0", "Blank Recorder", blankPng),
      ] as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      windowsShortcutCallback?.();
      await vi.waitFor(() => expect(f.onError).toHaveBeenCalledTimes(1));
      expect(f.onError).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "capture-blocked",
          message: expect.stringContaining("blank frame"),
        }),
        false,
      );
      expect(f.onCaptured).not.toHaveBeenCalled();
      expect(await f.manager.listPendingCaptures()).toHaveLength(0);
    } finally {
      f.dispose();
    }
  });

  it("emits capture-blocked when the foreground window's frame is blank instead of falling back to another window", async () => {
    let windowsShortcutCallback: (() => void) | undefined;
    const register = vi.fn((_accelerator: string, callback: () => void) => {
      windowsShortcutCallback = callback;
      return true;
    });
    const f = createWindowsManager({
      enabled: false,
      shortcutRegistry: { register, unregister: vi.fn() },
      windowsCaptureProbe: () => ({
        foregroundHwnd: 67890n,
        ownedHwnds: new Set<string>(),
      }),
    });
    const blankPng = Buffer.alloc(64, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(blankPng, 0);
    try {
      await f.manager.setShortcut({ kind: "key-chord", modifier: "option", key: "KeyX" });
      await f.manager.setEnabled(true);
      stubNativeImageBlankness([blankPng]);
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        fakeWindowsSource("window:123:0", "Developer Tools - http://localhost:5733/", PNG_BYTES),
        fakeWindowsSource("window:67890:0", "Microsoft Edge", blankPng),
        fakeWindowsSource("window:456:0", "Notepad", PNG_BYTES),
      ] as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      windowsShortcutCallback?.();
      await vi.waitFor(() => expect(f.onError).toHaveBeenCalledTimes(1));
      expect(f.onError).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "capture-blocked",
          message: expect.stringContaining("blank frame"),
        }),
        false,
      );
      expect(f.onCaptured).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it("emits an error instead of going silent when getSources stalls under a screen recorder", async () => {
    let windowsShortcutCallback: (() => void) | undefined;
    const register = vi.fn((_accelerator: string, callback: () => void) => {
      windowsShortcutCallback = callback;
      return true;
    });
    const f = createWindowsManager({
      enabled: false,
      shortcutRegistry: { register, unregister: vi.fn() },
    });
    try {
      await f.manager.setShortcut({ kind: "key-chord", modifier: "option", key: "KeyX" });
      await f.manager.setEnabled(true);
      vi.mocked(desktopCapturer.getSources).mockReturnValue(new Promise<never>(() => {}));

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      windowsShortcutCallback?.();
      await vi.advanceTimersByTimeAsync(WINDOWS_SOURCES_TIMEOUT_MS + 500);
      await flushPromises();

      expect(f.onError).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "capture-failed",
          message: expect.stringContaining("screen recorder"),
        }),
        false,
      );
      expect(f.onCaptured).not.toHaveBeenCalled();
      expect(await f.manager.listPendingCaptures()).toHaveLength(0);

      // The stall must release the in-flight guard so the next press runs.
      windowsShortcutCallback?.();
      await vi.advanceTimersByTimeAsync(WINDOWS_SOURCES_TIMEOUT_MS + 500);
      await flushPromises();
      expect(desktopCapturer.getSources).toHaveBeenCalledTimes(2);
      expect(f.onError).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      f.dispose();
    }
  });

  it("rejects captureCurrentApp when getSources stalls under a screen recorder", async () => {
    const f = createWindowsManager();
    try {
      vi.mocked(desktopCapturer.getSources).mockReturnValue(new Promise<never>(() => {}));
      await f.enable();

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const capturing = expect(f.manager.captureCurrentApp("win-stall")).rejects.toThrow(
        /screen recorder/,
      );
      await vi.advanceTimersByTimeAsync(WINDOWS_SOURCES_TIMEOUT_MS + 500);
      await capturing;
      expect(f.onCaptured).not.toHaveBeenCalled();
      expect(await f.manager.listPendingCaptures()).toEqual([]);
    } finally {
      vi.useRealTimers();
      f.dispose();
    }
  });

  it("captures the foreground window even when another window is first in z-order", async () => {
    let windowsShortcutCallback: (() => void) | undefined;
    const register = vi.fn((_accelerator: string, callback: () => void) => {
      windowsShortcutCallback = callback;
      return true;
    });
    const f = createWindowsManager({
      enabled: false,
      shortcutRegistry: { register, unregister: vi.fn() },
      windowsCaptureProbe: () => ({
        foregroundHwnd: 67890n,
        ownedHwnds: new Set<string>(["111"]),
      }),
    });
    try {
      await f.manager.setShortcut({ kind: "key-chord", modifier: "option", key: "KeyX" });
      await f.manager.setEnabled(true);
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        fakeWindowsSource("window:123:0", "Developer Tools - http://localhost:5733/", PNG_BYTES),
        fakeWindowsSource("window:456:0", "Notepad", PNG_BYTES),
        fakeWindowsSource("window:67890:0", "Microsoft Edge", PNG_BYTES),
      ] as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      windowsShortcutCallback?.();
      await vi.waitFor(() => expect(f.onCaptured).toHaveBeenCalledTimes(1));
      expect(f.onCaptured).toHaveBeenCalledWith(
        expect.objectContaining({ sourceAppName: "Microsoft Edge" }),
      );
    } finally {
      f.dispose();
    }
  });

  it("excludes every own-process HWND from the probe, not just BrowserWindow handles", async () => {
    let windowsShortcutCallback: (() => void) | undefined;
    const register = vi.fn((_accelerator: string, callback: () => void) => {
      windowsShortcutCallback = callback;
      return true;
    });
    const f = createWindowsManager({
      enabled: false,
      shortcutRegistry: { register, unregister: vi.fn() },
      windowsCaptureProbe: () => ({
        foregroundHwnd: 456n,
        ownedHwnds: new Set<string>(["111", "123"]),
      }),
    });
    try {
      await f.manager.setShortcut({ kind: "key-chord", modifier: "option", key: "KeyX" });
      await f.manager.setEnabled(true);
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        fakeWindowsSource("window:123:0", "Developer Tools - http://localhost:5733/", PNG_BYTES),
        fakeWindowsSource("window:456:0", "Notepad", PNG_BYTES),
      ] as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      windowsShortcutCallback?.();
      await vi.waitFor(() => expect(f.onCaptured).toHaveBeenCalledTimes(1));
      expect(f.onCaptured).toHaveBeenCalledWith(
        expect.objectContaining({ sourceAppName: "Notepad" }),
      );
    } finally {
      f.dispose();
    }
  });

  it("emits no-window when only Synara windows are capturable", async () => {
    let windowsShortcutCallback: (() => void) | undefined;
    const register = vi.fn((_accelerator: string, callback: () => void) => {
      windowsShortcutCallback = callback;
      return true;
    });
    const onError = vi.fn();
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-win-"));
    const manager = new DesktopAppSnapManager({
      platform: "win32",
      helperPath: "C:\\missing\\synara-appsnap-helper.exe",
      captureDirectory,
      excludedBundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      spawn: vi.fn() as unknown as typeof ChildProcess.spawn,
      shortcutRegistry: { register, unregister: vi.fn() },
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError,
    });
    try {
      await manager.setShortcut({ kind: "key-chord", modifier: "option", key: "KeyX" });
      await manager.setEnabled(true);

      const synaraHandle = Buffer.alloc(4);
      synaraHandle.writeUInt32LE(111, 0);
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
        { getNativeWindowHandle: () => synaraHandle },
      ] as unknown as ReturnType<typeof BrowserWindow.getAllWindows>);
      vi.mocked(desktopCapturer.getSources).mockResolvedValue([
        fakeWindowsSource("window:111:0", "Synara", PNG_BYTES),
      ] as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>);

      windowsShortcutCallback?.();
      await vi.waitFor(() =>
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "no-window" }), false),
      );
    } finally {
      manager.dispose();
      rmSync(captureDirectory, { recursive: true, force: true });
      vi.mocked(desktopCapturer.getSources).mockReset();
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
      vi.mocked(nativeImage.createFromBuffer).mockReset();
      vi.mocked(nativeImage.createFromBuffer).mockImplementation(
        () =>
          ({
            isEmpty: () => false,
            getSize: () => ({ width: 8, height: 8 }),
            toBitmap: () => variedBitmap(),
          }) as ReturnType<typeof nativeImage.createFromBuffer>,
      );
    }
  });
});

describe("Windows capture candidate ranking", () => {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function markerPng(marker: number, length = 64): Buffer {
    const png = Buffer.alloc(length);
    PNG_SIGNATURE.copy(png, 0);
    png.fill(marker, 8);
    return png;
  }

  it("puts non-blank windows ahead of blank ones while preserving z-order", () => {
    const sources = [
      fakeWindowsSource("window:1:0", "Recorder", markerPng(0)),
      fakeWindowsSource("window:2:0", "Terminal", markerPng(1)),
      fakeWindowsSource("screen:0:0", "Screen", markerPng(1)),
      fakeWindowsSource("window:3:0", "Browser", markerPng(1)),
      fakeWindowsSource("window:4:0", "Cloaked", markerPng(0)),
    ];
    const ranked = collectWindowsCaptureCandidates(
      sources as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>,
      new Set<string>(),
      (png) => png[8] === 0,
    );
    expect(ranked.map((entry) => entry.source.name)).toEqual([
      "Terminal",
      "Browser",
      "Recorder",
      "Cloaked",
    ]);
    expect(ranked.map((entry) => entry.blank)).toEqual([false, false, true, true]);
  });

  it("drops Synara windows, non-window sources, and empty thumbnails", () => {
    const sources = [
      fakeWindowsSource("window:111:0", "Synara", markerPng(1)),
      fakeWindowsSource("screen:0:0", "Desktop", markerPng(1)),
      fakeWindowsSource("window:222:0", "Empty", Buffer.alloc(0)),
      fakeWindowsSource("window:333:0", "Terminal", markerPng(1)),
    ];
    const ranked = collectWindowsCaptureCandidates(
      sources as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>,
      new Set(["111"]),
      () => false,
    );
    expect(ranked.map((entry) => entry.source.name)).toEqual(["Terminal"]);
  });

  it("promotes the foreground window ahead of z-order peers", () => {
    const sources = [
      fakeWindowsSource("window:1:0", "DevTools", markerPng(1)),
      fakeWindowsSource("window:2:0", "Edge", markerPng(1)),
      fakeWindowsSource("window:3:0", "Terminal", markerPng(1)),
    ];
    const ranked = collectWindowsCaptureCandidates(
      sources as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>,
      new Set<string>(),
      () => false,
      { foregroundHwnd: 2n },
    );
    expect(ranked.map((entry) => entry.source.name)).toEqual(["Edge", "DevTools", "Terminal"]);
  });

  it("keeps z-order when the foreground window is not capturable", () => {
    const sources = [
      fakeWindowsSource("window:1:0", "DevTools", markerPng(1)),
      fakeWindowsSource("window:2:0", "Edge", markerPng(1)),
    ];
    const ranked = collectWindowsCaptureCandidates(
      sources as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>,
      new Set<string>(),
      () => false,
      { foregroundHwnd: 999n },
    );
    expect(ranked.map((entry) => entry.source.name)).toEqual(["DevTools", "Edge"]);
  });

  it("drops Synara-owned windows even when they are the foreground window", () => {
    const sources = [
      fakeWindowsSource("window:1:0", "DevTools", markerPng(1)),
      fakeWindowsSource("window:2:0", "Edge", markerPng(1)),
    ];
    const ranked = collectWindowsCaptureCandidates(
      sources as unknown as Awaited<ReturnType<typeof desktopCapturer.getSources>>,
      new Set(["1"]),
      () => false,
      { foregroundHwnd: 1n },
    );
    expect(ranked.map((entry) => entry.source.name)).toEqual(["Edge"]);
  });

  it("treats empty payloads as blank and only near-solid black thumbnails as blank", () => {
    expect(isBlankWindowsThumbnail(Buffer.alloc(0))).toBe(true);
    expect(
      isBlankWindowsThumbnail(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])),
    ).toBe(false);
    expect(isBlankWindowsThumbnail(markerPng(1))).toBe(false);

    const solidBlack = {
      createFromBuffer: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 8, height: 8 }),
        toBitmap: () => Buffer.alloc(8 * 8 * 4, 0),
      }),
    };
    const solidWhite = {
      createFromBuffer: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 8, height: 8 }),
        toBitmap: () => Buffer.alloc(8 * 8 * 4, 255),
      }),
    };
    const content = {
      createFromBuffer: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 8, height: 8 }),
        toBitmap: () => variedBitmap(),
      }),
    };
    expect(isBlankWindowsThumbnail(markerPng(1), solidBlack)).toBe(true);
    expect(isBlankWindowsThumbnail(markerPng(1), solidWhite)).toBe(false);
    expect(isBlankWindowsThumbnail(markerPng(1), content)).toBe(false);
  });
});
