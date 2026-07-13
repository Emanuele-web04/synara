import * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  DesktopAppSnapManager,
  desktopAppSnapPlatform,
  isPathInsideDirectory,
  parseAppSnapHelperMessage,
} from "./appSnapManager";

function createFakeChildProcess(): ChildProcess.ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcess.ChildProcessWithoutNullStreams;
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

describe("desktop AppSnap platform state", () => {
  it("exposes an explicit unsupported state outside macOS", async () => {
    const onState = vi.fn();
    const manager = new DesktopAppSnapManager({
      platform: "win32",
      helperPath: "C:\\missing\\synara-appsnap-helper.exe",
      captureDirectory: "C:\\tmp\\appsnap",
      excludedBundleId: "com.synara.app",
      onState,
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });

    expect(desktopAppSnapPlatform("darwin")).toBe("macos");
    expect(desktopAppSnapPlatform("linux")).toBe("linux");
    expect(await manager.setEnabled(true)).toMatchObject({
      platform: "windows",
      supported: false,
      enabled: false,
      status: "unsupported",
      shortcut: null,
    });
    expect(onState).not.toHaveBeenCalled();
  });

  it("preserves a missing-helper error instead of reporting a permission problem", async () => {
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: "/tmp/synara-appsnap-helper-that-does-not-exist",
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: "com.synara.app",
      onState: vi.fn(),
      onCaptured: vi.fn(),
      onError: vi.fn(),
    });

    expect(await manager.setEnabled(true)).toMatchObject({
      status: "error",
      shortcut: "both-option-keys",
      message: "The AppSnap native helper is missing from this desktop build.",
    });
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
    const spawn = vi
      .fn()
      .mockReturnValueOnce(checkChild)
      .mockReturnValueOnce(requestChild) as unknown as typeof ChildProcess.spawn;
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: "com.synara.app",
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
      ["--request-permissions"],
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
    const manager = new DesktopAppSnapManager({
      platform: "darwin",
      helperPath: process.execPath,
      captureDirectory: "/tmp/synara-appsnap-test",
      excludedBundleId: "com.synara.app",
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
    manager.dispose();
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
      excludedBundleId: "com.synara.app",
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
      expect(manager.listPendingCaptures()).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
      expect(manager.listPendingCaptures()[0]?.id).toBe("capture-1");
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "pending-capture-overflow" }),
        false,
      );
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
