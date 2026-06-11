// FILE: main.backendProcess.test.ts
// Purpose: Lock backend spawn, crash-restart backoff, and teardown against a fake spawner.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendProcessController, type BackendProcessControllerDeps } from "./main.backendProcess";
import type { ServerListeningDetector } from "./serverListeningDetector";

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed: NodeJS.Signals[] = [];
  stdout = null;
  stderr = null;
  kill(signal: NodeJS.Signals): boolean {
    this.killed.push(signal);
    return true;
  }
}

function fakeDetector(): ServerListeningDetector {
  return {
    promise: Promise.resolve(),
    push: vi.fn(),
    fail: vi.fn(),
  } as unknown as ServerListeningDetector;
}

function createController(overrides: Partial<BackendProcessControllerDeps> = {}) {
  const child = new FakeChild();
  const spawn = vi.fn(() => child as never);
  const detector = fakeDetector();
  const deps: BackendProcessControllerDeps = {
    spawn: spawn as unknown as BackendProcessControllerDeps["spawn"],
    execPath: "/usr/bin/electron",
    resolveBackendEntry: vi.fn(() => "/app/server/index.mjs"),
    resolveBackendCwd: vi.fn(() => "/home/user"),
    backendEntryExists: vi.fn(() => true),
    buildEnv: vi.fn(() => ({ FOO: "bar" })),
    getBackendPort: vi.fn(() => 5050),
    createListeningDetector: vi.fn(() => detector),
    captureBackendLogs: vi.fn(() => false),
    writeBackendLog: vi.fn(),
    writeSessionBoundary: vi.fn(),
    getIsQuitting: vi.fn(() => false),
    cancelReadinessWait: vi.fn(),
    reserveEndpoint: vi.fn(async () => {}),
    ensureInitialWindowOpen: vi.fn(),
    formatErrorMessage: vi.fn((e) => (e instanceof Error ? e.message : String(e))),
    forceKillDelayMs: 3000,
    shutdownTimeoutMs: 8000,
    ...overrides,
  };
  const controller = new BackendProcessController(deps);
  return { controller, deps, spawn, child, detector };
}

describe("BackendProcessController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("spawns with ELECTRON_RUN_AS_NODE and inherited stdio when output is not captured", () => {
    const { controller, deps, spawn, detector } = createController();
    controller.start();

    expect(spawn).toHaveBeenCalledTimes(1);
    const call = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string>; stdio: string },
    ];
    expect(call[0]).toBe("/usr/bin/electron");
    expect(call[1]).toEqual(["/app/server/index.mjs"]);
    expect(call[2].env).toMatchObject({
      FOO: "bar",
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(call[2].stdio).toBe("inherit");
    expect(deps.writeSessionBoundary).toHaveBeenCalledWith(
      "START",
      expect.stringContaining("pid="),
    );
    expect(controller.getListeningPromise()).toBe(detector.promise);
  });

  it("pipes backend stdio when output is captured", () => {
    const { controller, spawn } = createController({
      captureBackendLogs: vi.fn(() => true),
    });
    controller.start();

    const call = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string>; stdio: Array<string> },
    ];
    expect(call[2].stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("does not spawn while quitting or when already running", () => {
    const quitting = createController({ getIsQuitting: vi.fn(() => true) });
    quitting.controller.start();
    expect(quitting.spawn).not.toHaveBeenCalled();

    const running = createController();
    running.controller.start();
    running.controller.start();
    expect(running.spawn).toHaveBeenCalledTimes(1);
  });

  it("schedules a restart when the server entry is missing (no spawn)", () => {
    const scheduleEntry = createController({
      backendEntryExists: vi.fn(() => false),
    });
    scheduleEntry.controller.start();
    expect(scheduleEntry.spawn).not.toHaveBeenCalled();
    // restart timer is pending; advancing should attempt a reserve+restart
    vi.advanceTimersByTime(600);
    expect(scheduleEntry.deps.reserveEndpoint).toHaveBeenCalledWith("backend restart");
  });

  it("restarts after an unexpected exit with exponential backoff", () => {
    const { controller, deps, child } = createController();
    controller.start();

    child.exitCode = 1;
    child.emit("exit", 1, null);
    expect(deps.writeSessionBoundary).toHaveBeenCalledWith(
      "END",
      expect.stringContaining("code=1"),
    );

    vi.advanceTimersByTime(500);
    expect(deps.reserveEndpoint).toHaveBeenCalledWith("backend restart");
  });

  it("does not restart on exit while quitting", () => {
    let quitting = false;
    const { controller, deps, child } = createController({
      getIsQuitting: () => quitting,
    });
    controller.start();
    quitting = true;
    child.exitCode = 0;
    child.emit("exit", 0, null);
    vi.advanceTimersByTime(10_000);
    expect(deps.reserveEndpoint).not.toHaveBeenCalled();
  });

  it("stop() SIGTERMs the child and arms a force-kill", () => {
    const { controller, deps, child } = createController();
    controller.start();
    controller.stop();
    expect(child.killed).toContain("SIGTERM");
    expect(deps.cancelReadinessWait).toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(child.killed).toContain("SIGKILL");
  });

  it("stopAndWaitForExit resolves once the child exits", async () => {
    const { controller, child } = createController();
    controller.start();
    const promise = controller.stopAndWaitForExit();
    expect(child.killed).toContain("SIGTERM");
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await expect(promise).resolves.toBeUndefined();
  });
});
