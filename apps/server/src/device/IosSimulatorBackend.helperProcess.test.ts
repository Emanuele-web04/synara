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
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

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
const THREAD = "thread-a";

const ok = (stdout: string): ProcessRunResult => ({
  stdout,
  stderr: "",
  code: 0,
  signal: null,
  timedOut: false,
});

const DEVICE_LIST_JSON = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
      { udid: DEVICE, name: "iPhone 17 Pro", state: "Booted", isAvailable: true },
    ],
  },
});

/** The simulator the helper talks to; a test bumps the boot to model a reboot. */
interface FakeSimulator {
  bootGeneration: number;
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
      case "attach":
        this.attachedGeneration = this.simulator.bootGeneration;
        this.reply(request.id, {
          pointWidth: 393,
          pointHeight: 852,
          pixelWidth: 1179,
          pixelHeight: 2556,
          scale: 3,
          capabilities: { input: true, accessibility: true },
        });
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
function makeStack() {
  const simulator: FakeSimulator = { bootGeneration: 1 };
  const processes: FakeHelperProcess[] = [];
  spawnHook.current = () => {
    const child = new FakeHelperProcess(simulator);
    processes.push(child);
    return child;
  };

  const backend = new IosSimulatorBackend({
    platform: "darwin",
    processEnv: {},
    helperCacheRoot: "/tmp/synara-device-test-cache",
    makeHelperClient: (binaryPath, env) =>
      new HelperClient({ binaryPath, env, requestTimeoutMs: 2_000 }),
    run: async (command, args) => {
      if (command === "xcode-select") return ok("/Applications/Xcode.app/Contents/Developer");
      if (command === "xcodebuild") return ok("Xcode 26.2\nBuild version 17C52");
      if (command === "xcrun" && args[1] === "list") return ok(DEVICE_LIST_JSON);
      return ok("");
    },
  });
  // As in IosSimulatorBackend.reboot.test.ts: stand in for the compiled binary.
  Object.defineProperty(backend, "compileHelperIfNeeded", {
    value: async () => "/tmp/synara-device-test-cache/synara-device-helper",
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
