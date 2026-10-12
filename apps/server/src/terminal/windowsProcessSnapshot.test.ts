import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProcessChildrenMap } from "./processTreeKiller";
import {
  createWindowsProcessSnapshotObserver,
  createPreparedWindowsTeardownProcessSnapshotObserver,
  createWindowsTeardownProcessSnapshotObserver,
  parseWindowsProcessSnapshotLine,
  type ProcessChildrenSnapshotWorker,
} from "./windowsProcessSnapshot";

function snapshot(
  entries: Array<{ ppid: number; pid: number; command: string }>,
): ProcessChildrenMap {
  const childrenByParentPid: ProcessChildrenMap = new Map();
  for (const entry of entries) {
    const siblings = childrenByParentPid.get(entry.ppid) ?? [];
    siblings.push({ pid: entry.pid, command: entry.command });
    childrenByParentPid.set(entry.ppid, siblings);
  }
  return childrenByParentPid;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Windows process snapshots", () => {
  it("parses base64-delimited rows without corrupting Windows command lines", () => {
    const command = '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo';
    const encoded = Buffer.from(command, "utf8").toString("base64");

    expect(parseWindowsProcessSnapshotLine(`42\t7\t${encoded}`)).toEqual({
      pid: 42,
      ppid: 7,
      command,
    });
    expect(parseWindowsProcessSnapshotLine(`bad\t7\t${encoded}`)).toBeNull();
    expect(parseWindowsProcessSnapshotLine("42\t7\tnot-base64")).toBeNull();
  });

  it("accepts the Windows System Idle Process row", () => {
    const idleProcess = "System Idle Process";
    const startedAt = "20260903100453.000000+120";
    expect(
      parseWindowsProcessSnapshotLine(
        `0\t0\t${startedAt}\t${Buffer.from(idleProcess, "utf8").toString("base64")}`,
      ),
    ).toEqual({
      pid: 0,
      ppid: 0,
      command: idleProcess,
      startedAt,
    });
  });

  it("coalesces concurrent terminal requests and reuses one worker across snapshots", async () => {
    const firstCapture = deferred<ProcessChildrenMap>();
    const firstSnapshot = snapshot([
      { ppid: 100, pid: 101, command: "codex.exe" },
      { ppid: 200, pid: 201, command: "node.exe build.js" },
    ]);
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi
        .fn<() => Promise<ProcessChildrenMap>>()
        .mockImplementationOnce(() => firstCapture.promise)
        .mockResolvedValue(firstSnapshot),
      dispose: vi.fn(),
    };
    const createWorker = vi.fn(() => worker);
    const observer = createWindowsProcessSnapshotObserver({ createWorker });

    const terminalOne = observer.capture();
    const terminalTwo = observer.capture();
    const terminalThree = observer.capture();
    await Promise.resolve();

    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(worker.capture).toHaveBeenCalledTimes(1);

    firstCapture.resolve(firstSnapshot);
    await expect(Promise.all([terminalOne, terminalTwo, terminalThree])).resolves.toEqual([
      firstSnapshot,
      firstSnapshot,
      firstSnapshot,
    ]);

    await expect(observer.capture()).resolves.toBe(firstSnapshot);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(worker.capture).toHaveBeenCalledTimes(2);
    observer.dispose();
  });

  it("times out a stalled worker and does not create another process during backoff", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const stalledCapture = deferred<ProcessChildrenMap>();
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn(() => stalledCapture.promise),
      dispose: vi.fn(),
    };
    const createWorker = vi.fn(() => worker);
    const observer = createWindowsProcessSnapshotObserver({
      createWorker,
      now: () => now,
      probeTimeoutMs: 50,
      retryBackoffBaseMs: 200,
      retryBackoffMaxMs: 800,
    });

    const capture = observer.capture();
    await vi.advanceTimersByTimeAsync(50);

    await expect(capture).resolves.toBeNull();
    expect(worker.dispose).toHaveBeenCalledTimes(1);
    expect(observer.retryDelayMs()).toBe(200);

    await expect(observer.capture()).resolves.toBeNull();
    expect(createWorker).toHaveBeenCalledTimes(1);

    now += 199;
    await expect(observer.capture()).resolves.toBeNull();
    expect(createWorker).toHaveBeenCalledTimes(1);
    observer.dispose();
  });

  it("backs off repeated failures and resets after a successful recovery", async () => {
    let now = 5_000;
    const recoveredSnapshot = snapshot([{ ppid: 300, pid: 301, command: "claude.exe" }]);
    const failedWorker = (): ProcessChildrenSnapshotWorker => ({
      capture: vi.fn().mockRejectedValue(new Error("WMI unavailable")),
      dispose: vi.fn(),
    });
    const recoveredWorker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn().mockResolvedValue(recoveredSnapshot),
      dispose: vi.fn(),
    };
    const workers = [failedWorker(), failedWorker(), recoveredWorker];
    const createWorker = vi.fn(() => workers.shift() ?? recoveredWorker);
    const observer = createWindowsProcessSnapshotObserver({
      createWorker,
      now: () => now,
      retryBackoffBaseMs: 100,
      retryBackoffMaxMs: 400,
    });

    await expect(observer.capture()).resolves.toBeNull();
    expect(observer.retryDelayMs()).toBe(100);

    now += 100;
    await expect(observer.capture()).resolves.toBeNull();
    expect(observer.retryDelayMs()).toBe(200);

    now += 200;
    await expect(observer.capture()).resolves.toBe(recoveredSnapshot);
    expect(observer.retryDelayMs()).toBe(0);

    await expect(observer.capture()).resolves.toBe(recoveredSnapshot);
    expect(createWorker).toHaveBeenCalledTimes(3);
    expect(recoveredWorker.capture).toHaveBeenCalledTimes(2);
    observer.dispose();
  });

  it("retries teardown snapshots within the process-exit proof window", async () => {
    vi.useFakeTimers();
    const recoveredSnapshot = snapshot([{ ppid: 400, pid: 401, command: "provider.exe" }]);
    const failedWorker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn().mockRejectedValue(new Error("CIM unavailable")),
      dispose: vi.fn(),
    };
    const recoveredWorker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn().mockResolvedValue(recoveredSnapshot),
      dispose: vi.fn(),
    };
    const workers = [failedWorker, recoveredWorker];
    const observer = createWindowsTeardownProcessSnapshotObserver({
      createWorker: () => workers.shift() ?? recoveredWorker,
    });

    const capture = observer.captureWithin(1_500);
    await vi.advanceTimersByTimeAsync(100);

    await expect(capture).resolves.toBe(recoveredSnapshot);
    expect(failedWorker.capture).toHaveBeenCalledTimes(1);
    expect(recoveredWorker.capture).toHaveBeenCalledTimes(1);
    observer.dispose();
  });

  it("does not start a fallback probe after the teardown snapshot budget expires", async () => {
    vi.useFakeTimers();
    const stalledCapture = deferred<ProcessChildrenMap>();
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn(() => stalledCapture.promise),
      dispose: vi.fn(),
    };
    const createWorker = vi.fn(() => worker);
    const observer = createWindowsTeardownProcessSnapshotObserver({ createWorker });

    const capture = observer.captureWithin(500);
    await vi.advanceTimersByTimeAsync(500);

    await expect(capture).resolves.toBeNull();
    expect(createWorker).toHaveBeenCalledTimes(1);
    observer.dispose();
  });

  it("prepares once while alive and drains that table before a fresh teardown snapshot", async () => {
    const preparation = deferred<ProcessChildrenMap>();
    const staleSnapshot = snapshot([{ ppid: 100, pid: 101, command: "provider.exe" }]);
    const freshSnapshot = snapshot([
      { ppid: 100, pid: 101, command: "provider.exe" },
      { ppid: 101, pid: 102, command: "late-worker.exe" },
    ]);
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi
        .fn()
        .mockImplementationOnce(() => preparation.promise)
        .mockResolvedValue(freshSnapshot),
      dispose: vi.fn(),
    };
    const createWorker = vi.fn(() => worker);
    const observer = createPreparedWindowsTeardownProcessSnapshotObserver({ createWorker });
    await Promise.resolve();
    expect(worker.capture).toHaveBeenCalledTimes(1);

    const first = observer.captureWithin(3_000);
    const second = observer.captureWithin(3_000);
    expect(worker.capture).toHaveBeenCalledTimes(1);
    preparation.resolve(staleSnapshot);

    await expect(Promise.all([first, second])).resolves.toEqual([freshSnapshot, freshSnapshot]);
    expect(worker.capture).toHaveBeenCalledTimes(2);
    expect(createWorker).toHaveBeenCalledTimes(1);
    observer.dispose();
  });

  it("completes cold initialization before admission without extending subsequent snapshot probes", async () => {
    vi.useFakeTimers();
    const preparation = deferred<ProcessChildrenMap>();
    const stalled = deferred<ProcessChildrenMap>();
    const staleSnapshot = snapshot([{ ppid: 100, pid: 101, command: "before-spawn.exe" }]);
    const freshSnapshot = snapshot([{ ppid: 100, pid: 102, command: "owned-provider.exe" }]);
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi
        .fn()
        .mockImplementationOnce(() => preparation.promise)
        .mockResolvedValueOnce(freshSnapshot)
        .mockImplementation(() => stalled.promise),
      dispose: vi.fn(),
    };
    const createWorker = vi.fn(() => worker);
    const observer = createPreparedWindowsTeardownProcessSnapshotObserver({
      createWorker,
      preparationTimeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(3_500);
    expect(worker.dispose).not.toHaveBeenCalled();
    expect(worker.capture).toHaveBeenCalledTimes(1);
    let ready = false;
    const prepared = observer.waitUntilReady().then((value) => {
      ready = value;
      return value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(false);
    preparation.resolve(staleSnapshot);
    await expect(prepared).resolves.toBe(true);
    await expect(observer.captureWithin(3_000)).resolves.toBe(freshSnapshot);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(worker.capture).toHaveBeenCalledTimes(2);

    let settled = false;
    const capture = observer.captureWithin(3_000).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(capture).resolves.toBeNull();
    expect(worker.dispose).toHaveBeenCalledTimes(1);
    observer.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails readiness at its initialization budget without publishing a late table", async () => {
    vi.useFakeTimers();
    const preparation = deferred<ProcessChildrenMap>();
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn(() => preparation.promise),
      dispose: vi.fn(),
    };
    const observer = createPreparedWindowsTeardownProcessSnapshotObserver({
      createWorker: () => worker,
      preparationTimeoutMs: 5_000,
    });
    let settled = false;
    const ready = observer.waitUntilReady().then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(ready).resolves.toBe(false);
    expect(worker.dispose).toHaveBeenCalledTimes(1);
    preparation.resolve(new Map());
    await expect(observer.waitUntilReady()).resolves.toBe(false);
    observer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not count a failed preparation as successful readiness", async () => {
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn().mockRejectedValue(new Error("CIM unavailable")),
      dispose: vi.fn(),
    };
    const observer = createPreparedWindowsTeardownProcessSnapshotObserver({
      createWorker: () => worker,
      preparationTimeoutMs: 5_000,
    });
    await expect(observer.waitUntilReady()).resolves.toBe(false);
    expect(worker.dispose).toHaveBeenCalledTimes(1);
    observer.dispose();
  });

  it("cancels readiness before worker creation when disposed in the same turn", async () => {
    vi.useFakeTimers();
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn().mockResolvedValue(new Map()),
      dispose: vi.fn(),
    };
    const createWorker = vi.fn(() => worker);
    const observer = createPreparedWindowsTeardownProcessSnapshotObserver({
      createWorker,
      preparationTimeoutMs: 5_000,
    });
    const ready = observer.waitUntilReady();
    observer.dispose();
    await expect(ready).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(createWorker).not.toHaveBeenCalled();
    expect(worker.capture).not.toHaveBeenCalled();
    expect(worker.dispose).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts preparation and the fresh query against the original teardown deadline", async () => {
    vi.useFakeTimers();
    const preparation = deferred<ProcessChildrenMap>();
    const fresh = deferred<ProcessChildrenMap>();
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi
        .fn()
        .mockImplementationOnce(() => preparation.promise)
        .mockImplementation(() => fresh.promise),
      dispose: vi.fn(() => fresh.reject(new Error("worker disposed"))),
    };
    const observer = createPreparedWindowsTeardownProcessSnapshotObserver({
      createWorker: () => worker,
    });
    let settled = false;
    const capture = observer.captureWithin(3_000).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(2_000);
    preparation.resolve(new Map());
    await vi.advanceTimersByTimeAsync(999);
    expect(worker.capture).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(capture).resolves.toBeNull();
    observer.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an expired preparation wait unknown and discards its late table", async () => {
    vi.useFakeTimers();
    const preparation = deferred<ProcessChildrenMap>();
    const freshSnapshot = snapshot([{ ppid: 100, pid: 102, command: "late-worker.exe" }]);
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi
        .fn()
        .mockImplementationOnce(() => preparation.promise)
        .mockResolvedValue(freshSnapshot),
      dispose: vi.fn(),
    };
    const observer = createPreparedWindowsTeardownProcessSnapshotObserver({
      createWorker: () => worker,
    });
    const expired = observer.captureWithin(250);
    await vi.advanceTimersByTimeAsync(250);
    await expect(expired).resolves.toBeNull();
    expect(worker.capture).toHaveBeenCalledTimes(1);

    preparation.resolve(new Map());
    await vi.advanceTimersByTimeAsync(0);
    await expect(observer.captureWithin(250)).resolves.toBe(freshSnapshot);
    expect(worker.capture).toHaveBeenCalledTimes(2);
    observer.dispose();
  });

  it("recovers failed preparation only through the existing bounded teardown backoff", async () => {
    vi.useFakeTimers();
    const freshSnapshot = snapshot([{ ppid: 100, pid: 102, command: "provider.exe" }]);
    const failedWorker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn().mockRejectedValue(new Error("cold CIM unavailable")),
      dispose: vi.fn(),
    };
    const recoveredWorker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn().mockResolvedValue(freshSnapshot),
      dispose: vi.fn(),
    };
    const createWorker = vi.fn().mockReturnValueOnce(failedWorker).mockReturnValue(recoveredWorker);
    const observer = createPreparedWindowsTeardownProcessSnapshotObserver({ createWorker });
    await vi.advanceTimersByTimeAsync(0);
    expect(failedWorker.dispose).toHaveBeenCalledTimes(1);
    const capture = observer.captureWithin(500);
    await vi.advanceTimersByTimeAsync(99);
    expect(createWorker).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(capture).resolves.toBe(freshSnapshot);
    expect(createWorker).toHaveBeenCalledTimes(2);
    observer.dispose();
  });

  it("disposes an in-flight preparation wait without publishing its late completion", async () => {
    vi.useFakeTimers();
    const preparation = deferred<ProcessChildrenMap>();
    const worker: ProcessChildrenSnapshotWorker = {
      capture: vi.fn(() => preparation.promise),
      dispose: vi.fn(() => preparation.reject(new Error("worker disposed"))),
    };
    const createWorker = vi.fn(() => worker);
    const observer = createPreparedWindowsTeardownProcessSnapshotObserver({ createWorker });
    const capture = observer.captureWithin(3_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(worker.capture).toHaveBeenCalledTimes(1);
    expect(worker.dispose).not.toHaveBeenCalled();
    observer.dispose();
    await expect(capture).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await expect(observer.captureWithin(3_000)).resolves.toBeNull();
    expect(createWorker).toHaveBeenCalledTimes(1);
    observer.dispose();
    expect(worker.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ordinary", createWindowsProcessSnapshotObserver],
    ["teardown", createWindowsTeardownProcessSnapshotObserver],
    ["prepared", createPreparedWindowsTeardownProcessSnapshotObserver],
  ] as const)(
    "does not create or capture a %s worker after immediate disposal",
    async (_name, create) => {
      vi.useFakeTimers();
      const worker: ProcessChildrenSnapshotWorker = {
        capture: vi.fn().mockResolvedValue(new Map()),
        dispose: vi.fn(),
      };
      const createWorker = vi.fn(() => worker);
      const observer = create({ createWorker });
      const capture = observer.capture();
      // Dispose in the same turn, before the queued worker-creation callback runs.
      observer.dispose();
      await vi.advanceTimersByTimeAsync(0);

      expect(createWorker).not.toHaveBeenCalled();
      expect(worker.capture).not.toHaveBeenCalled();
      expect(worker.dispose).not.toHaveBeenCalled();
      await expect(capture).resolves.toBeNull();
      await expect(observer.capture()).resolves.toBeNull();
      observer.dispose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
