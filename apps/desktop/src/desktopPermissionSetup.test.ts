import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopPermission, DesktopPermissionSetupState } from "@synara/contracts";
import { DesktopPermissionSetup } from "./desktopPermissionSetup";

function fixture() {
  const grants: Record<DesktopPermission, "granted" | "denied"> = {
    accessibility: "denied",
    screenRecording: "denied",
    inputMonitoring: "denied",
  };
  const permissions = {
    check: vi.fn(async () => ({ ...grants })),
    request: vi.fn(async () => ({ ...grants })),
  };
  const guide = { show: vi.fn(), close: vi.fn(async () => {}) };
  const states: DesktopPermissionSetupState[] = [];
  const beforeStart = vi.fn(async () => {});
  const setup = new DesktopPermissionSetup({
    appName: "Synara Cua",
    appPath: "/Applications/Synara Cua.app",
    permissions,
    guide,
    beforeStart,
    onState: (state) => states.push(state),
  });
  return { setup, grants, permissions, guide, states, beforeStart };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
afterEach(() => vi.useRealTimers());

describe("shared desktop permission setup", () => {
  it("does no checking or prompting until setup is explicitly started", async () => {
    vi.useFakeTimers();
    const f = fixture();
    expect(f.setup.getState().phase).toBe("idle");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.permissions.check).not.toHaveBeenCalled();
    expect(f.guide.show).not.toHaveBeenCalled();
    await f.setup.dispose();
  });

  it("detects grants without renderer focus and advances exactly one permission at a time", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.setup.start("computer");
    await flush();
    expect(f.setup.getState()).toMatchObject({ current: "accessibility", phase: "waiting" });
    expect(f.permissions.request).toHaveBeenCalledExactlyOnceWith(
      ["accessibility"],
      expect.any(AbortSignal),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.permissions.request).toHaveBeenCalledTimes(1);
    f.grants.accessibility = "granted";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.setup.getState()).toMatchObject({
      current: "screenRecording",
      grants: { accessibility: "granted" },
    });
    expect(f.permissions.request).toHaveBeenLastCalledWith(
      ["screenRecording"],
      expect.any(AbortSignal),
    );
    f.grants.screenRecording = "granted";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.setup.getState().phase).toBe("complete");
    const checks = f.permissions.check.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.permissions.check).toHaveBeenCalledTimes(checks);
    expect(f.setup.getState().phase).toBe("idle");
    expect(f.permissions.request).toHaveBeenCalledTimes(2);
    await f.setup.dispose();
  });

  it("skips already-granted scopes and keeps AppSnap separate from Accessibility", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.grants.inputMonitoring = "granted";
    await f.setup.start("appsnap");
    await flush();
    expect(f.permissions.check).toHaveBeenCalledWith(["inputMonitoring", "screenRecording"]);
    expect(f.permissions.request).toHaveBeenCalledExactlyOnceWith(
      ["screenRecording"],
      expect.any(AbortSignal),
    );
    await f.setup.dispose();
  });

  it("deduplicates repeated Set up clicks and prevents overlapping polls", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let resolve!: (value: typeof f.grants) => void;
    f.permissions.check.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await Promise.all([f.setup.start("computer"), f.setup.start("computer")]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.beforeStart).toHaveBeenCalledTimes(1);
    expect(f.permissions.check).toHaveBeenCalledTimes(1);
    resolve({ ...f.grants });
    await flush();
    await f.setup.dispose();
  });

  it("dismissal aborts its pending request and cannot advance or reopen the guide later", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release!: (value: typeof f.grants) => void;
    f.permissions.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await f.setup.start("computer");
    await flush();
    const signal = (f.permissions.request.mock.calls[0] as unknown as [unknown, AbortSignal])[1];
    await f.setup.stop();
    expect(signal.aborted).toBe(true);
    release({ ...f.grants, accessibility: "granted" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.setup.getState().phase).toBe("idle");
    expect(f.permissions.request).toHaveBeenCalledTimes(1);
    expect(f.guide.show).toHaveBeenCalledTimes(1);
  });

  it("ignores a previous feature's delayed check after switching setup", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release!: (value: typeof f.grants) => void;
    f.permissions.check.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await f.setup.start("computer");
    await f.setup.start("appsnap");
    await flush();
    release({ ...f.grants, accessibility: "granted" });
    await flush();
    expect(f.setup.getState()).toMatchObject({ feature: "appsnap", current: "inputMonitoring" });
    expect(f.permissions.request).toHaveBeenCalledExactlyOnceWith(
      ["inputMonitoring"],
      expect.any(AbortSignal),
    );
    await f.setup.dispose();
  });

  it("dismisses starts waiting for cleanup, including queued clicks", async () => {
    const f = fixture();
    let release!: () => void;
    f.guide.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = f.setup.start("computer");
    const queued = f.setup.start("appsnap");
    await f.setup.stop();
    release();
    await Promise.all([first, queued]);
    expect(f.beforeStart).not.toHaveBeenCalled();
    expect(f.permissions.check).not.toHaveBeenCalled();
    expect(f.setup.getState().phase).toBe("idle");
    await f.setup.dispose();
  });

  it("retains confirmed grants on probe failure and can recover without another click", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.grants.accessibility = "granted";
    await f.setup.start("computer");
    await flush();
    f.permissions.check.mockRejectedValueOnce(new Error("Probe failed"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.setup.getState()).toMatchObject({
      phase: "error",
      grants: { accessibility: "granted" },
      message: "Probe failed",
    });
    f.grants.screenRecording = "granted";
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.setup.getState().phase).toBe("complete");
    await f.setup.dispose();
  });

  it("bounds an abandoned setup and clears every polling timer on shutdown", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.setup.start("computer");
    await flush();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.setup.getState()).toMatchObject({
      phase: "idle",
      message: expect.stringContaining("five minutes"),
    });
    expect(vi.getTimerCount()).toBe(0);
    await f.setup.dispose();
    await expect(f.setup.start("computer")).rejects.toThrow("shutting down");
  });
});
