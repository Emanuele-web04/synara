import * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_PERMISSIONS } from "@synara/shared/computerPermissions";

import {
  APP_SNAP_PERMISSIONS,
  DesktopPermissionService,
  desktopPermissionSettingsUrl,
} from "./desktopPermissions";

function createChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
}

function complete(child: ReturnType<typeof createChild>, state: Record<string, string>) {
  child.stdout.end(`${JSON.stringify({ type: "permissions", ...state })}\n`);
  child.stderr.end();
  child.emit("close", 0);
}

async function flush() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function createService(children: ReturnType<typeof createChild>[], timeoutMs?: number) {
  const spawn = vi.fn();
  for (const child of children) spawn.mockReturnValueOnce(child);
  const openSettings = vi.fn(async () => undefined);
  const service = new DesktopPermissionService({
    platform: "darwin",
    helperPath: process.execPath,
    spawn: spawn as unknown as typeof ChildProcess.spawn,
    openSettings,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  return { service, spawn, openSettings };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("desktop permission service", () => {
  it("cancels an aged queued setup without opening a late prompt or cancelling another owner", async () => {
    const first = createChild();
    const refreshed = createChild();
    const { service, spawn, openSettings } = createService([first, refreshed]);
    const other = service.request(APP_SNAP_PERMISSIONS);
    const abort = new AbortController();
    const setup = service.request(COMPUTER_PERMISSIONS, abort.signal);
    const cancelled = expect(setup).rejects.toThrow("cancelled");
    await flush();
    abort.abort();
    await cancelled;
    expect(first.kill).not.toHaveBeenCalled();
    complete(first, { inputMonitoring: "granted", screenRecording: "granted" });
    await flush();
    complete(refreshed, { inputMonitoring: "granted", screenRecording: "granted" });
    await other;
    await service.dispose();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("reaps its active prompt on dismissal before admitting a replacement", async () => {
    const first = createChild();
    const next = createChild();
    const { service, spawn } = createService([first, next]);
    const abort = new AbortController();
    const request = service.request(COMPUTER_PERMISSIONS, abort.signal);
    const cancelled = expect(request).rejects.toThrow("cancelled");
    await flush();
    abort.abort();
    await cancelled;
    const check = service.check(COMPUTER_PERMISSIONS);
    await flush();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(first.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    first.emit("close", null);
    await flush();
    complete(next, { accessibility: "granted", screenRecording: "granted" });
    await check;
    await service.dispose();
  });
  it("reports a missing helper as a build failure without spawning or opening Settings", async () => {
    const spawn = vi.fn();
    const openSettings = vi.fn();
    const service = new DesktopPermissionService({
      platform: "darwin",
      helperPath: "/tmp/synara-permission-helper-does-not-exist",
      spawn: spawn as unknown as typeof ChildProcess.spawn,
      openSettings,
    });
    await expect(service.check(COMPUTER_PERMISSIONS)).rejects.toThrow(
      "missing from this desktop build",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
    await service.dispose();
  });

  it("deduplicates concurrent checks but starts a fresh process for later checks", async () => {
    const first = createChild();
    const second = createChild();
    const { service, spawn, openSettings } = createService([first, second]);
    const check = service.check(COMPUTER_PERMISSIONS);
    expect(service.check(["screenRecording", "accessibility"])).toBe(check);
    await flush();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ["--check-permissions", "--permission", "accessibility", "--permission", "screenRecording"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    complete(first, { accessibility: "denied", screenRecording: "granted" });
    expect(await check).toEqual({ accessibility: "denied", screenRecording: "granted" });
    const refreshed = service.check(COMPUTER_PERMISSIONS);
    await flush();
    expect(spawn).toHaveBeenCalledTimes(2);
    complete(second, { accessibility: "granted", screenRecording: "granted" });
    expect(await refreshed).toEqual({ accessibility: "granted", screenRecording: "granted" });
    expect(openSettings).not.toHaveBeenCalled();
    await service.dispose();
  });

  it("refreshes requested scopes in a new process and opens only the remaining Settings pane", async () => {
    const requestChild = createChild();
    const freshChild = createChild();
    const { service, spawn, openSettings } = createService([requestChild, freshChild]);
    const request = service.request(COMPUTER_PERMISSIONS);
    expect(service.request(COMPUTER_PERMISSIONS)).toBe(request);
    await flush();
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      "--request-permissions",
      "--permission",
      "accessibility",
      "--permission",
      "screenRecording",
    ]);
    complete(requestChild, { accessibility: "denied", screenRecording: "denied" });
    await flush();
    expect(openSettings).not.toHaveBeenCalled();
    complete(freshChild, { accessibility: "granted", screenRecording: "denied" });
    expect(await request).toEqual({ accessibility: "granted", screenRecording: "denied" });
    expect(openSettings).toHaveBeenCalledExactlyOnceWith("screenRecording");
    expect(JSON.stringify(spawn.mock.calls)).not.toContain("inputMonitoring");
    await service.dispose();
  });

  it("serializes requests from both features and waits for helper stdout to drain", async () => {
    const computerChild = createChild();
    const appSnapRequestChild = createChild();
    const freshChild = createChild();
    const { service, spawn, openSettings } = createService([
      computerChild,
      appSnapRequestChild,
      freshChild,
    ]);
    const computer = service.check(COMPUTER_PERMISSIONS);
    const appSnap = service.request(APP_SNAP_PERMISSIONS);
    await flush();
    computerChild.emit("exit", 0);
    await flush();
    expect(spawn).toHaveBeenCalledTimes(1);
    complete(computerChild, { accessibility: "granted", screenRecording: "granted" });
    await computer;
    await flush();
    expect(spawn.mock.calls[1]?.[1]).toEqual(["--request-permissions"]);
    complete(appSnapRequestChild, { inputMonitoring: "granted", screenRecording: "granted" });
    await flush();
    expect(spawn.mock.calls[2]?.[1]).toEqual(["--check-permissions"]);
    complete(freshChild, { inputMonitoring: "granted", screenRecording: "granted" });
    expect(await appSnap).toEqual({ inputMonitoring: "granted", screenRecording: "granted" });
    expect(openSettings).not.toHaveBeenCalled();
    await service.dispose();
  });

  it("rejects incomplete permission output instead of treating an omitted scope as granted", async () => {
    const child = createChild();
    const { service } = createService([child]);
    const check = service.check(COMPUTER_PERMISSIONS);
    const failure = expect(check).rejects.toThrow("requested permission state");
    await flush();
    complete(child, { inputMonitoring: "granted", screenRecording: "granted" });
    await failure;
    await service.dispose();
  });

  it("keeps queued commands blocked until a timed-out helper closes", async () => {
    vi.useFakeTimers();
    const child = createChild();
    const nextChild = createChild();
    const { service, spawn } = createService([child, nextChild], 20);
    const first = service.check(COMPUTER_PERMISSIONS);
    const firstFailure = expect(first).rejects.toThrow("timed out");
    const next = service.check(APP_SNAP_PERMISSIONS);
    await flush();
    await vi.advanceTimersByTimeAsync(20);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    expect(spawn).toHaveBeenCalledTimes(1);
    child.emit("close", null);
    await firstFailure;
    await flush();
    expect(spawn).toHaveBeenCalledTimes(2);
    complete(nextChild, { inputMonitoring: "granted", screenRecording: "granted" });
    await next;
    await service.dispose();
  });

  it("fails closed after the cleanup deadline until the owned helper eventually closes", async () => {
    vi.useFakeTimers();
    const child = createChild();
    const nextChild = createChild();
    const { service, spawn } = createService([child, nextChild], 20);
    const check = service.check(COMPUTER_PERMISSIONS);
    const failure = expect(check).rejects.toThrow("timed out");
    await flush();
    await vi.advanceTimersByTimeAsync(2_020);
    await failure;
    await expect(service.check(APP_SNAP_PERMISSIONS)).rejects.toThrow("has not stopped");
    expect(spawn).toHaveBeenCalledTimes(1);
    child.emit("close", null);
    const retry = service.check(APP_SNAP_PERMISSIONS);
    await flush();
    complete(nextChild, { inputMonitoring: "denied", screenRecording: "granted" });
    await retry;
    await service.dispose();
  });

  it("cancels its owned helper on disposal and does not start queued work", async () => {
    const child = createChild();
    const { service, spawn } = createService([child]);
    const check = service.check(COMPUTER_PERMISSIONS);
    const cancelled = expect(check).rejects.toThrow("cancelled");
    const queued = service.check(APP_SNAP_PERMISSIONS);
    const shutdown = expect(queued).rejects.toThrow("shutting down");
    await flush();
    const disposing = service.dispose();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    child.emit("close", null);
    await Promise.all([cancelled, shutdown, disposing]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("does not open Settings if disposal starts as the fresh request check finishes", async () => {
    const requestChild = createChild();
    const freshChild = createChild();
    const { service, openSettings } = createService([requestChild, freshChild]);
    const request = service.request(COMPUTER_PERMISSIONS);
    const shutdown = expect(request).rejects.toThrow("shutting down");
    await flush();
    complete(requestChild, { accessibility: "denied", screenRecording: "denied" });
    await flush();
    complete(freshChild, { accessibility: "denied", screenRecording: "denied" });
    await service.dispose();
    await shutdown;
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("expires a queued passive check without stopping the other feature's permission request", async () => {
    vi.useFakeTimers();
    const requestChild = createChild();
    const freshChild = createChild();
    const { service, spawn } = createService([requestChild, freshChild]);
    const request = service.request(COMPUTER_PERMISSIONS);
    const check = service.check(APP_SNAP_PERMISSIONS);
    const expired = expect(check).rejects.toThrow("operation timed out");
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    await expired;
    expect(requestChild.kill).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    complete(requestChild, { accessibility: "granted", screenRecording: "granted" });
    await flush();
    complete(freshChild, { accessibility: "granted", screenRecording: "granted" });
    await request;
    await service.dispose();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("includes queue time in a request deadline and never launches an expired queued prompt", async () => {
    vi.useFakeTimers();
    const firstChild = createChild();
    const freshChild = createChild();
    const secondChild = createChild();
    const { service, spawn, openSettings } = createService([firstChild, freshChild, secondChild]);
    const first = service.request(COMPUTER_PERMISSIONS);
    const second = service.request(APP_SNAP_PERMISSIONS);
    const secondExpired = expect(second).rejects.toThrow("operation timed out");
    const queued = service.request(["screenRecording"]);
    const queuedExpired = expect(queued).rejects.toThrow("operation timed out");
    await flush();
    await vi.advanceTimersByTimeAsync(59_000);
    complete(firstChild, { accessibility: "granted", screenRecording: "granted" });
    await flush();
    await vi.advanceTimersByTimeAsync(9_000);
    complete(freshChild, { accessibility: "granted", screenRecording: "granted" });
    await first;
    await flush();
    expect(spawn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(22_000);
    await Promise.all([secondExpired, queuedExpired]);
    expect(secondChild.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    secondChild.emit("close", null);
    await service.dispose();
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("uses the dedicated Settings destination for each permission", () => {
    expect(desktopPermissionSettingsUrl("accessibility")).toContain("Privacy_Accessibility");
    expect(desktopPermissionSettingsUrl("screenRecording")).toContain("Privacy_ScreenCapture");
    expect(desktopPermissionSettingsUrl("inputMonitoring")).toContain("Privacy_ListenEvent");
  });

  it("releases the permission lane when opening Settings never settles", async () => {
    vi.useFakeTimers();
    const requestChild = createChild();
    const freshChild = createChild();
    const nextChild = createChild();
    const { service, openSettings } = createService([requestChild, freshChild, nextChild]);
    openSettings.mockImplementation(() => new Promise(() => {}));
    const request = service.request(COMPUTER_PERMISSIONS);
    const expired = expect(request).rejects.toThrow("operation timed out");
    await flush();
    complete(requestChild, { accessibility: "denied", screenRecording: "granted" });
    await flush();
    complete(freshChild, { accessibility: "denied", screenRecording: "granted" });
    await flush();
    expect(openSettings).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(90_000);
    await expired;
    const check = service.check(APP_SNAP_PERMISSIONS);
    await flush();
    complete(nextChild, { inputMonitoring: "granted", screenRecording: "granted" });
    await expect(check).resolves.toMatchObject({ screenRecording: "granted" });
    await service.dispose();
    expect(nextChild.kill).not.toHaveBeenCalled();
  });
});
