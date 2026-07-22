import * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DesktopIslandHelperManager,
  ISLAND_HELPER_MAX_LINE_BYTES,
  parseIslandHelperOutput,
  type DesktopIslandHelperManagerOptions,
} from "./islandHelperManager";

type FakeChildProcess = ChildProcess.ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

interface FakeChildFixture {
  child: FakeChildProcess;
  stdin: string[];
}

function createFakeChildProcess(): FakeChildFixture {
  const child = new EventEmitter() as FakeChildProcess;
  const stdin = new PassThrough();
  const writes: string[] = [];
  stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));
  Object.assign(child, {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return { child, stdin: writes };
}

function emitJson(child: FakeChildProcess, message: object): void {
  child.stdout.write(`${JSON.stringify(message)}\n`);
}

function messagesWrittenTo(fixture: FakeChildFixture): Array<Record<string, unknown>> {
  return fixture.stdin
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createManagerOptions(
  spawn: typeof ChildProcess.spawn,
  overrides: Partial<DesktopIslandHelperManagerOptions> = {},
): DesktopIslandHelperManagerOptions {
  return {
    platform: "darwin",
    capability: true,
    helperPath: "/Applications/Synara.app/Contents/Resources/synara-island-helper",
    helperExists: () => true,
    spawn,
    onAction: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("native island helper protocol", () => {
  it("parses only the versioned handshake, acknowledgements, and bounded action union", () => {
    expect(parseIslandHelperOutput('{"type":"ready","protocolVersion":1}')).toEqual({
      type: "ready",
      protocolVersion: 1,
    });
    expect(parseIslandHelperOutput('{"type":"ready","protocolVersion":2}')).toBeNull();
    expect(parseIslandHelperOutput('{"type":"rendered","revision":4}')).toEqual({
      type: "rendered",
      revision: 4,
    });
    expect(
      parseIslandHelperOutput(
        JSON.stringify({
          type: "action",
          actionId: "action-1",
          revision: 4,
          kind: "allow-once",
          threadId: "thread-1",
          requestId: "approval-1",
        }),
      ),
    ).toEqual({
      type: "action",
      actionId: "action-1",
      revision: 4,
      kind: "allow-once",
      threadId: "thread-1",
      requestId: "approval-1",
    });
    expect(
      parseIslandHelperOutput(
        JSON.stringify({
          type: "action",
          actionId: "action-2",
          revision: 4,
          kind: "allow-once",
          threadId: "thread-1",
        }),
      ),
    ).toBeNull();
    expect(parseIslandHelperOutput("not json")).toBeNull();
  });
});

describe("DesktopIslandHelperManager capability gates", () => {
  it("keeps the React fallback without spawning outside macOS", () => {
    const spawn = vi.fn() as unknown as typeof ChildProcess.spawn;
    const onFallback = vi.fn();
    const manager = new DesktopIslandHelperManager(
      createManagerOptions(spawn, { platform: "linux", onFallback }),
    );

    expect(manager.start()).toMatchObject({
      status: "unsupported",
      nativeActive: false,
      failure: { code: "unsupported-platform" },
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(onFallback).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("does not probe or spawn a helper when the build capability is disabled", () => {
    const spawn = vi.fn() as unknown as typeof ChildProcess.spawn;
    const helperExists = vi.fn(() => true);
    const manager = new DesktopIslandHelperManager(
      createManagerOptions(spawn, { capability: false, helperExists }),
    );

    expect(manager.start()).toMatchObject({
      status: "unavailable",
      failure: { code: "capability-disabled" },
    });
    expect(helperExists).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    manager.dispose();
  });
});

describe("DesktopIslandHelperManager snapshots", () => {
  it("waits for ready, allows one in-flight revision, and coalesces to the latest snapshot", () => {
    const fixture = createFakeChildProcess();
    const spawn = vi.fn(() => fixture.child) as unknown as typeof ChildProcess.spawn;
    const manager = new DesktopIslandHelperManager(createManagerOptions(spawn));

    expect(manager.publishSnapshot({ mode: "activity", title: "First" })).toBe(1);
    expect(manager.start()).toMatchObject({ status: "starting", nativeActive: false });
    expect(spawn).toHaveBeenCalledWith(
      "/Applications/Synara.app/Contents/Resources/synara-island-helper",
      ["--stdio-jsonl"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    expect(messagesWrittenTo(fixture)).toEqual([]);

    emitJson(fixture.child, { type: "ready", protocolVersion: 1 });
    expect(manager.getState()).toMatchObject({
      status: "ready",
      nativeActive: false,
      renderedRevision: null,
    });
    expect(messagesWrittenTo(fixture)).toEqual([
      {
        type: "snapshot",
        revision: 1,
        payload: { mode: "activity", title: "First" },
      },
    ]);

    expect(manager.publishSnapshot({ mode: "activity", title: "Second" })).toBe(2);
    expect(manager.publishSnapshot({ mode: "approval", title: "Latest" })).toBe(3);
    expect(messagesWrittenTo(fixture)).toHaveLength(1);

    emitJson(fixture.child, { type: "rendered", revision: 1 });
    expect(messagesWrittenTo(fixture)).toEqual([
      expect.objectContaining({ revision: 1 }),
      {
        type: "snapshot",
        revision: 3,
        payload: { mode: "approval", title: "Latest" },
      },
    ]);
    emitJson(fixture.child, { type: "rendered", revision: 3 });
    expect(manager.getState()).toMatchObject({
      status: "ready",
      nativeActive: true,
      renderedRevision: 3,
    });
    manager.dispose();
  });

  it("rejects an oversized outgoing snapshot without consuming a revision", () => {
    const fixture = createFakeChildProcess();
    const spawn = vi.fn(() => fixture.child) as unknown as typeof ChildProcess.spawn;
    const onError = vi.fn();
    const manager = new DesktopIslandHelperManager(createManagerOptions(spawn, { onError }));

    expect(manager.publishSnapshot({ text: "x".repeat(ISLAND_HELPER_MAX_LINE_BYTES) })).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "snapshot-too-large" }));
    expect(manager.publishSnapshot({ mode: "idle" })).toBe(1);
    manager.dispose();
  });

  it("derives native visibility from the acknowledged in-flight revision while coalescing", () => {
    const fixture = createFakeChildProcess();
    const spawn = vi.fn(() => fixture.child) as unknown as typeof ChildProcess.spawn;
    const manager = new DesktopIslandHelperManager(createManagerOptions(spawn));

    manager.publishSnapshot({ mode: "activity", title: "Visible" });
    manager.start();
    emitJson(fixture.child, { type: "ready", protocolVersion: 1 });
    emitJson(fixture.child, { type: "rendered", revision: 1 });
    expect(manager.getState()).toMatchObject({
      nativeActive: true,
      renderedRevision: 1,
    });

    manager.publishSnapshot({ mode: "idle", sessions: [] });
    manager.publishSnapshot({ mode: "approval", title: "Queued after hide" });
    expect(messagesWrittenTo(fixture).map((message) => message.revision)).toEqual([1, 2]);

    emitJson(fixture.child, { type: "rendered", revision: 2 });
    expect(manager.getState()).toMatchObject({
      nativeActive: false,
      renderedRevision: 2,
    });
    expect(messagesWrittenTo(fixture).map((message) => message.revision)).toEqual([1, 2, 3]);

    emitJson(fixture.child, { type: "rendered", revision: 3 });
    expect(manager.getState()).toMatchObject({
      nativeActive: true,
      renderedRevision: 3,
    });
    manager.dispose();
  });
});

describe("DesktopIslandHelperManager actions", () => {
  it("accepts actions only for the rendered revision and deduplicates action ids", () => {
    const fixture = createFakeChildProcess();
    const spawn = vi.fn(() => fixture.child) as unknown as typeof ChildProcess.spawn;
    const onAction = vi.fn();
    const onError = vi.fn();
    const manager = new DesktopIslandHelperManager(
      createManagerOptions(spawn, { onAction, onError }),
    );

    manager.publishSnapshot({ mode: "approval" });
    manager.start();
    emitJson(fixture.child, { type: "ready", protocolVersion: 1 });
    emitJson(fixture.child, { type: "rendered", revision: 1 });

    const action = {
      type: "action",
      actionId: "approval-action-1",
      revision: 1,
      kind: "allow-once",
      threadId: "thread-1",
      requestId: "request-1",
    };
    emitJson(fixture.child, action);
    emitJson(fixture.child, action);
    emitJson(fixture.child, { ...action, actionId: "stale-action", revision: 99 });
    emitJson(fixture.child, {
      type: "action",
      actionId: "invalid-action",
      revision: 1,
      kind: "allow-once",
      threadId: "thread-1",
    });

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith({
      actionId: "approval-action-1",
      revision: 1,
      kind: "allow-once",
      threadId: "thread-1",
      requestId: "request-1",
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "invalid-action" }));
    manager.dispose();
  });
});

describe("DesktopIslandHelperManager failure recovery", () => {
  it("falls back and replays the latest snapshot after a crash restart", () => {
    vi.useFakeTimers();
    const first = createFakeChildProcess();
    const second = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child) as unknown as typeof ChildProcess.spawn;
    const onFallback = vi.fn();
    const manager = new DesktopIslandHelperManager(
      createManagerOptions(spawn, {
        maxRestarts: 1,
        restartDelayMs: 10,
        readyTimeoutMs: 100,
        onFallback,
      }),
    );

    manager.publishSnapshot({ mode: "activity", title: "Current" });
    manager.start();
    emitJson(first.child, { type: "ready", protocolVersion: 1 });
    emitJson(first.child, { type: "rendered", revision: 1 });
    first.child.emit("exit", 9, null);

    expect(first.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(manager.getState()).toMatchObject({
      status: "restarting",
      nativeActive: false,
      restartCount: 1,
      renderedRevision: null,
      failure: { code: "helper-crashed" },
    });
    expect(onFallback).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(10);
    expect(spawn).toHaveBeenCalledTimes(2);
    emitJson(second.child, { type: "ready", protocolVersion: 1 });
    expect(messagesWrittenTo(second)).toEqual([
      {
        type: "snapshot",
        revision: 1,
        payload: { mode: "activity", title: "Current" },
      },
    ]);
    manager.dispose();
  });

  it("stops retrying after the ready-timeout restart ceiling", () => {
    vi.useFakeTimers();
    const first = createFakeChildProcess();
    const second = createFakeChildProcess();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child) as unknown as typeof ChildProcess.spawn;
    const manager = new DesktopIslandHelperManager(
      createManagerOptions(spawn, {
        maxRestarts: 1,
        restartDelayMs: 10,
        readyTimeoutMs: 50,
      }),
    );

    manager.start();
    vi.advanceTimersByTime(50);
    expect(manager.getState().status).toBe("restarting");
    vi.advanceTimersByTime(10);
    expect(spawn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(50);

    expect(manager.getState()).toMatchObject({
      status: "fallback",
      nativeActive: false,
      restartCount: 1,
      failure: { code: "ready-timeout" },
    });
    vi.advanceTimersByTime(1_000);
    expect(spawn).toHaveBeenCalledTimes(2);
    manager.dispose();
  });

  it("bounds helper output lines before JSON parsing", () => {
    const fixture = createFakeChildProcess();
    const spawn = vi.fn(() => fixture.child) as unknown as typeof ChildProcess.spawn;
    const manager = new DesktopIslandHelperManager(createManagerOptions(spawn, { maxRestarts: 0 }));

    manager.start();
    fixture.child.stdout.write(Buffer.alloc(ISLAND_HELPER_MAX_LINE_BYTES + 1, 0x78));

    expect(manager.getState()).toMatchObject({
      status: "fallback",
      nativeActive: false,
      failure: { code: "protocol-line-too-large" },
    });
    expect(fixture.child.kill).toHaveBeenCalledWith("SIGTERM");
    manager.dispose();
  });

  it("clears timers, closes stdin, and never restarts after disposal", () => {
    vi.useFakeTimers();
    const fixture = createFakeChildProcess();
    const spawn = vi.fn(() => fixture.child) as unknown as typeof ChildProcess.spawn;
    const onAction = vi.fn();
    const manager = new DesktopIslandHelperManager(
      createManagerOptions(spawn, { onAction, readyTimeoutMs: 25, restartDelayMs: 10 }),
    );

    manager.start();
    manager.dispose();
    fixture.child.emit("exit", 1, null);
    emitJson(fixture.child, {
      type: "action",
      actionId: "late-action",
      revision: 1,
      kind: "open-thread",
      threadId: "thread-1",
    });
    vi.advanceTimersByTime(1_000);

    expect(manager.getState().status).toBe("disposed");
    expect(messagesWrittenTo(fixture)).toEqual([{ type: "shutdown" }]);
    expect(fixture.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
  });
});
