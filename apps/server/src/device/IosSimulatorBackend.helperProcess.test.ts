/**
 * The real `HelperClient` and `IosSimulatorBackend` under `DeviceManager`,
 * against a scripted stand-in for the helper process.
 *
 * Only `spawn` is replaced: the client's own JSON-RPC framing, its client-side
 * attachment cache, its frame-socket setup and its exit handling all run as
 * shipped. That matters here, because the bug lives in how those real pieces
 * interact (a cached attachment that is never re-sent), which a hand-written
 * helper fake would paper over.
 */
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeAgentGatewayDeviceTools } from "../agentGateway/deviceTools.ts";
import type { ProcessRunResult } from "../processRunner.ts";
import { DeviceManager } from "./DeviceManager.ts";
import { HelperClient } from "./helperClient.ts";
import { IosSimulatorBackend } from "./IosSimulatorBackend.ts";

const spawnHook = vi.hoisted(() => ({
  current: null as null | ((command: string, args: readonly string[]) => unknown),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: unknown) =>
      spawnHook.current
        ? spawnHook.current(command, args)
        : actual.spawn(command, [...args], options as never),
  };
});

const DEVICE = "AAAA-1111";
const OTHER_DEVICE = "BBBB-2222";
const THREAD = "thread-a";

const ok = (stdout: string): ProcessRunResult => ({
  stdout,
  stderr: "",
  code: 0,
  signal: null,
  timedOut: false,
});

function deviceListJson(booted: boolean): string {
  return JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
        {
          udid: DEVICE,
          name: "iPhone 17 Pro",
          state: booted ? "Booted" : "Shutdown",
          isAvailable: true,
        },
      ],
    },
  });
}

/** The simulator the helper talks to; a test bumps the boot to model a reboot. */
interface FakeSimulator {
  bootGeneration: number;
  readonly tappedDevices: string[];
  holdAttach?: {
    readonly udid: string;
    readonly received: () => void;
    readonly resume: Promise<void>;
  };
  holdTap?: {
    readonly received: () => void;
    readonly resume: Promise<void>;
  };
  holdDescribe?: FakeSimulator["holdTap"];
}

type HelperRequest = {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

/**
 * Speaks the helper's stdio protocol. Its attachment is bound to the boot it
 * was made against, and `stream.start` on an attachment from an earlier boot
 * fails the way the real helper was observed to: "display has no framebuffer
 * surface yet", every time, until a fresh `attach` is sent.
 */
class FakeHelperProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: string[] = [];
  readonly streamStarts: Array<"ok" | "stale"> = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  private attachedGeneration: number | null = null;
  private attachedUdid: string | null = null;
  private pendingInput = "";

  constructor(private readonly simulator: FakeSimulator) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.pendingInput += chunk.toString("utf8");
      let newline = this.pendingInput.indexOf("\n");
      while (newline !== -1) {
        const line = this.pendingInput.slice(0, newline);
        this.pendingInput = this.pendingInput.slice(newline + 1);
        if (line.trim()) this.handle(JSON.parse(line) as HelperRequest);
        newline = this.pendingInput.indexOf("\n");
      }
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    setImmediate(() => this.exit(null, signal));
    return true;
  }

  private exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  private handle(request: HelperRequest): void {
    this.requests.push(request.method);
    switch (request.method) {
      case "attach": {
        const udid = String(request.params?.udid);
        this.attachedGeneration = this.simulator.bootGeneration;
        this.attachedUdid = udid;
        const attachment = {
          pointWidth: 393,
          pointHeight: 852,
          pixelWidth: 1179,
          pixelHeight: 2556,
          scale: 3,
          capabilities: { input: true, accessibility: true },
        };
        const hold = this.simulator.holdAttach;
        if (hold?.udid === udid) {
          hold.received();
          void hold.resume.then(() => this.reply(request.id, attachment));
        } else {
          this.reply(request.id, attachment);
        }
        return;
      }
      case "tap":
        if (this.attachedUdid === null) {
          this.fail(request.id, "not attached to a simulator");
          return;
        }
        this.simulator.tappedDevices.push(this.attachedUdid);
        if (this.simulator.holdTap) {
          this.simulator.holdTap.received();
          void this.simulator.holdTap.resume.then(() => this.reply(request.id, { ok: true }));
        } else {
          this.reply(request.id, { ok: true });
        }
        return;
      case "describe-ui": {
        const description = { tree: { role: "Application", children: [] } };
        const hold = this.simulator.holdDescribe;
        if (hold) {
          hold.received();
          void hold.resume.then(() => this.reply(request.id, description));
        } else {
          this.reply(request.id, description);
        }
        return;
      }
      case "screenshot":
        writeFileSync(String(request.params?.path), this.attachedUdid ?? "not attached");
        this.reply(request.id, { ok: true });
        return;
      case "stream.start":
        if (this.attachedGeneration === null) {
          this.fail(request.id, "not attached to a simulator");
          return;
        }
        if (this.attachedGeneration !== this.simulator.bootGeneration) {
          this.streamStarts.push("stale");
          this.fail(request.id, "display has no framebuffer surface yet");
          return;
        }
        this.streamStarts.push("ok");
        this.reply(request.id, {});
        return;
      case "stream.stop":
        // The native helper dispatches on one control queue. A stalled tap
        // prevents a subsequent stop request from answering as well.
        if (this.simulator.holdTap) {
          void this.simulator.holdTap.resume.then(() => this.reply(request.id, {}));
        } else {
          this.reply(request.id, {});
        }
        return;
      default:
        this.reply(request.id, { ok: true });
    }
  }

  private reply(id: number, result: unknown): void {
    setImmediate(() => this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`));
  }

  private fail(id: number, message: string): void {
    setImmediate(() =>
      this.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`,
      ),
    );
  }
}

/**
 * A manager over the real backend and client, with a virtual clock for the
 * attach retry loop so the 60s display deadline costs no wall time.
 */
function makeStack(options: { initiallyBooted?: boolean; compile?: Promise<void> } = {}) {
  const simulator: FakeSimulator = { bootGeneration: 1, tappedDevices: [] };
  const processes: FakeHelperProcess[] = [];
  spawnHook.current = () => {
    const child = new FakeHelperProcess(simulator);
    processes.push(child);
    return child;
  };

  let booted = options.initiallyBooted ?? true;
  const shutdowns: string[] = [];
  const backend = new IosSimulatorBackend({
    platform: "darwin",
    processEnv: {},
    helperCacheRoot: "/tmp/synara-device-test-cache",
    makeHelperClient: (binaryPath, env) =>
      new HelperClient({ binaryPath, env, requestTimeoutMs: 2_000 }),
    run: async (command, args) => {
      if (command === "xcode-select") return ok("/Applications/Xcode.app/Contents/Developer");
      if (command === "xcodebuild") return ok("Xcode 26.2\nBuild version 17C52");
      if (command === "xcrun" && args[1] === "list") return ok(deviceListJson(booted));
      if (command === "xcrun" && args[1] === "boot") booted = true;
      if (command === "xcrun" && args[1] === "shutdown") {
        booted = false;
        shutdowns.push(args[2]!);
      }
      return ok("");
    },
  });
  // As in IosSimulatorBackend.reboot.test.ts: stand in for the compiled binary.
  const compiling = Promise.withResolvers<void>();
  Object.defineProperty(backend, "compileHelperIfNeeded", {
    value: async () => {
      compiling.resolve();
      await options.compile;
      return "/tmp/synara-device-test-cache/synara-device-helper";
    },
  });

  let clock = 0;
  const manager = new DeviceManager({
    backend,
    now: () => clock,
    setTimeout: (handler, ms) => {
      clock += ms;
      return setTimeout(handler, 0);
    },
  });
  return {
    simulator,
    processes,
    backend,
    manager,
    compiling: compiling.promise,
    shutdowns,
    elapsedVirtualMs: () => clock,
  };
}

type ThreadSnapshot = Awaited<ReturnType<DeviceManager["getThreadState"]>>;

async function waitForState(
  manager: DeviceManager,
  predicate: (state: ThreadSnapshot) => boolean,
): Promise<ThreadSnapshot> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    const state = await manager.getThreadState(THREAD);
    if (predicate(state) || Date.now() >= deadline) return state;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const streaming = (state: ThreadSnapshot) =>
  state.attachedDeviceUdid === DEVICE && state.attachPhase == null && state.lastError === null;

let disposeStack: (() => Promise<void>) | null = null;

afterEach(async () => {
  await disposeStack?.();
  disposeStack = null;
  spawnHook.current = null;
});

describe("stream start after the simulator was rebooted outside Synara", () => {
  it("re-attaches and streams again instead of timing out on the display wait", async () => {
    const { simulator, processes, manager, elapsedVirtualMs } = makeStack();
    disposeStack = () => manager.dispose();
    await manager.attach(THREAD, DEVICE);
    expect(streaming(await waitForState(manager, streaming))).toBe(true);
    expect(processes[0]?.streamStarts).toEqual(["ok"]);

    // Simulator.app or the agent's own shell reboots the device. Synara sees
    // no shutdown, so the client still holds the attachment from boot 1.
    simulator.bootGeneration = 2;
    // The user re-selects the device (detach, then attach the same udid).
    await manager.detach(THREAD);
    await manager.attach(THREAD, DEVICE);
    const settled = await waitForState(
      manager,
      (state) => state.attachPhase == null && state.attachedDeviceUdid === DEVICE,
    );

    const helper = processes.at(-1)!;
    // A re-sent `attach` fixes this immediately on the real helper; retrying
    // `stream.start` on the old attachment never does.
    expect(settled.lastError).toBeNull();
    expect(helper.streamStarts.at(-1)).toBe("ok");
    expect(helper.requests.filter((method) => method === "attach").length).toBeGreaterThan(1);
    expect(elapsedVirtualMs()).toBeLessThan(60_000);
  });
});

it("routes a background tap and screenshot to its simulator while another simulator starts streaming", async () => {
  const { simulator, backend } = makeStack();
  disposeStack = () => backend.dispose();
  const received = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  simulator.holdAttach = {
    udid: DEVICE,
    received: received.resolve,
    resume: resume.promise,
  };

  const backgroundTap = backend.tap(DEVICE, 10, 10);
  await received.promise;
  try {
    await backend.attachStream(OTHER_DEVICE, () => {});
    await backend.tap(OTHER_DEVICE, 20, 20);
  } finally {
    resume.resolve();
    await backgroundTap;
  }

  expect(simulator.tappedDevices).toEqual([OTHER_DEVICE, DEVICE]);
  const screenshot = await backend.screenshot(DEVICE);
  expect(Buffer.from(screenshot.bytesBase64, "base64").toString("utf8")).toBe(DEVICE);
});

it.each([
  { toolName: "device_tap", args: { x: 20, y: 20 }, backendMethod: "tap", nativeMethod: "tap" },
  {
    toolName: "device_type",
    args: { text: "replacement", method: "keys", clear: true },
    backendMethod: "keyEvent",
    nativeMethod: "key",
  },
] as const)(
  "does not dispatch a stopped $toolName after the device queue clears",
  async (input) => {
    const { simulator, processes, backend, manager } = makeStack();
    disposeStack = () => manager.dispose();
    const received = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    simulator.holdDescribe = { received: received.resolve, resume: resume.promise };
    const description = backend.describeUi(DEVICE);
    await received.promise;

    const queuedInput = vi.spyOn(backend, input.backendMethod);
    const stop = new AbortController();
    const tool = makeAgentGatewayDeviceTools({ manager, authorizeAction: async () => true }).find(
      (entry) => entry.definition.name === input.toolName,
    )!;
    const interrupted = Effect.runPromise(
      tool.handler(
        { udid: DEVICE, ...input.args, observe: false },
        {
          principal: {
            kind: "provider-session",
            sessionKey: "test",
            threadId: THREAD,
            provider: "codex",
            turnId: "turn",
          },
          callerThreadId: THREAD,
          callerThreadLabel: null,
          callerSessionKey: "test",
          callerProvider: "codex",
          callerCapabilities: new Set(["device:control"]),
          callerTurnId: "turn",
          assertCallerTurnActive: () => Effect.void,
          jsonRpcRequestId: 1,
        },
      ),
      { signal: stop.signal },
    ).then(
      () => false,
      () => true,
    );

    try {
      await expect.poll(() => queuedInput.mock.calls.length).toBe(1);
      const outcome = queuedInput.mock.results[0]!.value.catch((error: unknown) => error);
      stop.abort();
      resume.resolve();
      const result = await outcome;
      expect(await interrupted).toBe(true);
      expect(processes.flatMap((child) => child.requests)).not.toContain(input.nativeMethod);
      expect(result).toMatchObject({ name: "AbortError" });
    } finally {
      stop.abort();
      resume.resolve();
      await description;
      await interrupted;
      queuedInput.mockRestore();
    }
  },
);

it("shuts down a Synara-owned simulator on quit before its first helper finishes compiling", async () => {
  const compiler = Promise.withResolvers<void>();
  const { manager, processes, compiling, shutdowns } = makeStack({
    initiallyBooted: false,
    compile: compiler.promise,
  });
  expect(await manager.boot(DEVICE)).toMatchObject({ device: { bootSource: "synara" } });
  const tap = manager.tap(DEVICE, 10, 10).catch((error: unknown) => error);
  await compiling;

  const disposal = manager.dispose();
  try {
    const nextTick = new Promise((resolve) => setImmediate(() => resolve("pending")));
    await expect(Promise.race([disposal.then(() => "disposed"), nextTick])).resolves.toBe(
      "disposed",
    );
    await expect(Promise.race([tap, nextTick])).resolves.toBeInstanceOf(Error);
    expect(shutdowns).toEqual([DEVICE]);
  } finally {
    compiler.resolve();
    await disposal;
    await tap;
  }
  expect(await tap).toBeInstanceOf(Error);
  expect(processes).toHaveLength(0);
});

it("quits while idle shutdown is waiting for stream state publication", async () => {
  const compiler = Promise.withResolvers<void>();
  const { backend, manager, compiling, shutdowns } = makeStack({
    initiallyBooted: false,
    compile: compiler.promise,
  });
  await manager.boot(DEVICE);
  await manager.attach(THREAD, DEVICE);
  await compiling;
  const unsubscribe = manager.subscribeFrames(DEVICE, {
    send: () => {},
    bufferedAmount: () => 0,
    isOpen: () => true,
  });
  const publicationStarted = Promise.withResolvers<void>();
  const finishPublication = Promise.withResolvers<void>();
  const availability = backend.availability.bind(backend);
  const availabilitySpy = vi.spyOn(backend, "availability").mockImplementationOnce(async () => {
    publicationStarted.resolve();
    await finishPublication.promise;
    return await availability();
  });
  compiler.resolve();
  await publicationStarted.promise;
  await manager.detach(THREAD);

  const idleStarted = Promise.withResolvers<void>();
  const shutdown = manager.shutdown.bind(manager);
  const shutdownSpy = vi.spyOn(manager, "shutdown").mockImplementation((udid, onlyIfIdle) => {
    idleStarted.resolve();
    return shutdown(udid, onlyIfIdle);
  });
  unsubscribe();
  await idleStarted.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(shutdowns).toEqual([]);

  let disposed = false;
  const disposal = manager.dispose().then(() => {
    disposed = true;
  });
  try {
    await expect.poll(() => disposed).toBe(true);
    expect(shutdowns).toEqual([DEVICE]);
  } finally {
    finishPublication.resolve();
    await disposal;
    shutdownSpy.mockRestore();
    availabilitySpy.mockRestore();
  }
});

it.each([false, true])(
  "disposes a helper with outstanding input without waiting for a reply (streaming=%s)",
  async (preview) => {
    const { simulator, backend, manager } = makeStack();
    if (preview) {
      await manager.attach(THREAD, DEVICE);
      expect(streaming(await waitForState(manager, streaming))).toBe(true);
    }
    const received = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    simulator.holdTap = { received: received.resolve, resume: resume.promise };
    const tap = (preview ? manager : backend).tap(DEVICE, 10, 10).catch((error: unknown) => error);
    await received.promise;

    const disposal = (preview ? manager : backend).dispose();
    try {
      const nextTick = new Promise((resolve) => setImmediate(() => resolve("pending")));
      await expect(Promise.race([tap, nextTick])).resolves.toBeInstanceOf(Error);
      await disposal;
    } finally {
      resume.resolve();
      await disposal;
      await tap;
    }
  },
);
