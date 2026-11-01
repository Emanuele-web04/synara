/**
 * What the server publishes must fit the contract it publishes against.
 *
 * `ThreadDeviceState` and `DeviceAvailability` are encoded by the RPC layer on
 * every `device.attach`/`getThreadState` response and every `device.event`
 * push. A value past a contract limit fails that encode, so the pane gets an
 * RPC failure instead of the state (and the error) it was supposed to show.
 * These tests encode what the server produces with the real contract schemas.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DeviceAvailability, ThreadDeviceState } from "@synara/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { ProcessRunResult } from "../processRunner.ts";
import { DeviceManager } from "./DeviceManager.ts";
import { FakeDeviceBackend, type FakeDeviceSeed } from "./FakeDeviceBackend.ts";
import { IosSimulatorBackend } from "./IosSimulatorBackend.ts";

const THREAD = "thread-a";
const DEVICE = "AAAA-1111";

const encodeThreadState = Schema.encodeUnknownSync(ThreadDeviceState);
const encodeAvailability = Schema.encodeUnknownSync(DeviceAvailability);

/**
 * The contract violation an encode reports, or null when the value fits.
 * The schema error quotes the whole offending value, so only the verdict and
 * the path are kept.
 */
function contractViolation(encode: (value: unknown) => unknown, value: unknown): string | null {
  try {
    encode(value);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const verdict = message.split(", got ")[0] ?? message;
    const at = /at \[[^\n]*\]\s*$/u.exec(message)?.[0].trim() ?? "";
    return `${verdict} ${at}`.trim();
  }
}

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

/**
 * What a failed helper compile writes to stderr against an Xcode whose private
 * headers moved: one diagnostic per use site, easily several KB.
 */
const LONG_COMPILE_STDERR = Array.from(
  { length: 40 },
  (_, index) =>
    `/Users/dev/Library/Caches/synara/device-helper/Sources/SimulatorBridge.swift:${100 + index}:13: ` +
    `error: cannot find type 'SimDeviceIOClient' in scope`,
).join("\n");

const cacheRoots: string[] = [];

afterEach(async () => {
  for (const root of cacheRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A real backend on a machine where the helper build fails with long stderr. */
async function makeFailingCompileBackend(): Promise<IosSimulatorBackend> {
  const cacheRoot = await mkdtemp(path.join(tmpdir(), "synara-contract-limits-"));
  cacheRoots.push(cacheRoot);
  return new IosSimulatorBackend({
    platform: "darwin",
    processEnv: {},
    helperCacheRoot: cacheRoot,
    run: async (command, args) => {
      if (command === "xcode-select") return ok("/Applications/Xcode.app/Contents/Developer");
      if (command === "xcodebuild") return ok("Xcode 26.3\nBuild version 17D1");
      if (command === "xcrun" && args[1] === "list") return ok(DEVICE_LIST_JSON);
      if (command === "/bin/sh") {
        return { stdout: "", stderr: LONG_COMPILE_STDERR, code: 65, signal: null, timedOut: false };
      }
      return ok("");
    },
  });
}

describe("error messages longer than the contract allows", () => {
  it("reports a failed helper build as availability the contract can encode", async () => {
    const backend = await makeFailingCompileBackend();
    await expect(backend.compileHelperIfNeeded()).rejects.toThrow(/Device helper build failed/u);

    const availability = await backend.availability();

    expect(availability.kind).toBe("helper-unavailable");
    expect(contractViolation(encodeAvailability, availability)).toBeNull();
  });

  it("publishes a thread state the contract can encode after the helper build fails", async () => {
    const backend = await makeFailingCompileBackend();
    const manager = new DeviceManager({ backend, attachDeadlineMs: 0, attachRetryMs: 1 });

    await manager.attach(THREAD, DEVICE);
    let state = await manager.getThreadState(THREAD);
    for (let attempt = 0; attempt < 500 && state.lastError === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      state = await manager.getThreadState(THREAD);
    }

    expect(state.lastError).toMatch(/Device helper build failed/u);
    // `device.attach`, `device.getThreadState` and every `device.event` push
    // encode this value; a failed encode replaces the error with an RPC failure.
    expect(contractViolation(encodeThreadState, state)).toBeNull();
    await manager.dispose();
  });
});

describe("more simulators than the contract allows", () => {
  it("publishes a thread state the contract can encode on a machine with many simulators", async () => {
    // Three runtimes with the stock device types already exceed 64 simulators,
    // and the thread snapshot lists shut-down devices too.
    const seeds: FakeDeviceSeed[] = Array.from({ length: 70 }, (_, index) => ({
      udid: `FAKE-${String(index).padStart(4, "0")}`,
      name: `iPhone ${index}`,
      runtime: `iOS 26.${index % 3}`,
      state: "shutdown",
    }));
    const manager = new DeviceManager({
      backend: new FakeDeviceBackend({ devices: seeds }),
      attachDeadlineMs: 0,
      attachRetryMs: 1,
    });

    const state = await manager.getThreadState(THREAD);

    expect(contractViolation(encodeThreadState, state)).toBeNull();
  });
});
