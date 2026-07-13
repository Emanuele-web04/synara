import * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as FS from "node:fs";
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

    watchChild.stdout.write('{"type":"ready"');
    await manager.setEnabled(false);
    watchChild.stdout.end("}\n");
    await flushPromises();

    expect(manager.getState().status).toBe("disabled");
    expect(watchChild.kill).toHaveBeenCalledWith("SIGTERM");
    manager.dispose();
  });

  it("coalesces concurrent listener reconciliation while the capture directory is prepared", async () => {
    const captureDirectory = mkdtempSync(join(tmpdir(), "synara-appsnap-reconcile-"));
    const firstCheckChild = createFakeChildProcess();
    const secondCheckChild = createFakeChildProcess();
    const watchChild = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(firstCheckChild)
      .mockReturnValueOnce(secondCheckChild)
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
      excludedBundleId: "com.synara.app",
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
      secondCheckChild.stdout.end(
        `${JSON.stringify({
          type: "permissions",
          inputMonitoring: "granted",
          screenRecording: "granted",
        })}\n`,
      );
      secondCheckChild.stderr.end();
      secondCheckChild.emit("close", 0, null);
      await flushPromises();

      expect(spawn).toHaveBeenCalledTimes(2);
      releaseMkdir();
      await Promise.all([enable, refresh]);
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(spawn).toHaveBeenLastCalledWith(
        process.execPath,
        ["--watch", "--output-dir", captureDirectory, "--excluded-bundle-id", "com.synara.app"],
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
      excludedBundleId: "com.synara.app",
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
        excludedBundleId: "com.synara.app",
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
        excludedBundleId: "com.synara.app",
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
});

describe("AppSnap capture path guard", () => {
  it("accepts child paths and rejects traversal or the directory itself", () => {
    expect(isPathInsideDirectory("/tmp/appsnap", "/tmp/appsnap/capture.png")).toBe(true);
    expect(isPathInsideDirectory("/tmp/appsnap", "/tmp/appsnap")).toBe(false);
    expect(isPathInsideDirectory("/tmp/appsnap", "/tmp/other/capture.png")).toBe(false);
  });
});
