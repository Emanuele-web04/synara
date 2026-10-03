import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type * as ChildProcess from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  AudioLevelMonitor,
  combineAudioLevelSources,
  combineAudioLevelSubscriptions,
  parseAudioInputsMessage,
  parseAudioLevelMessage,
} from "./audioLevelMonitor";

/** A stand-in for the `--audio-level` helper's NDJSON stdout. */
class FakeHelper extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn();

  emitLine(payload: unknown): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}

function makeMonitor() {
  const helpers: FakeHelper[] = [];
  const spawnArgs: unknown[][] = [];
  const levels: number[] = [];
  const errors: string[] = [];
  const spawn = ((...args: unknown[]) => {
    spawnArgs.push(args);
    const helper = new FakeHelper();
    helpers.push(helper);
    return helper;
  }) as unknown as typeof ChildProcess.spawn;
  const monitor = new AudioLevelMonitor({
    helperPath: "/fixture/appsnap",
    onLevel: (level) => levels.push(level),
    onError: (message) => errors.push(message),
    spawn,
  });
  return { monitor, helpers, spawnArgs, levels, errors };
}

const flushLines = () => new Promise((resolve) => setImmediate(resolve));

describe("parseAudioLevelMessage", () => {
  it("clamps levels and drops malformed lines", () => {
    expect(parseAudioLevelMessage('{"type":"audio-level","level":0.42}')).toEqual({
      type: "audio-level",
      level: 0.42,
    });
    expect(parseAudioLevelMessage('{"type":"audio-level","level":3}')).toEqual({
      type: "audio-level",
      level: 1,
    });
    expect(parseAudioLevelMessage('{"type":"audio-level","level":"loud"}')).toBeNull();
    expect(parseAudioLevelMessage("not json")).toBeNull();
  });
});

describe("combineAudioLevelSources", () => {
  it("listens to both when subscribers ask for different sources", () => {
    expect(combineAudioLevelSources([])).toBeNull();
    expect(combineAudioLevelSources(["system", "system"])).toBe("system");
    expect(combineAudioLevelSources(["microphone"])).toBe("microphone");
    expect(combineAudioLevelSources(["system", "microphone"])).toBe("both");
    expect(combineAudioLevelSources(["both"])).toBe("both");
  });
});

describe("combineAudioLevelSubscriptions", () => {
  it("keeps the newest microphone choice and drops it for Mac audio alone", () => {
    expect(
      combineAudioLevelSubscriptions([
        { source: "system", microphoneId: "BuiltInMicrophoneDevice" },
      ]),
    ).toEqual({ source: "system", microphoneId: null });
    expect(
      combineAudioLevelSubscriptions([
        { source: "microphone", microphoneId: "old" },
        { source: "system", microphoneId: null },
        { source: "microphone", microphoneId: "BuiltInMicrophoneDevice" },
      ]),
    ).toEqual({ source: "both", microphoneId: "BuiltInMicrophoneDevice" });
  });
});

describe("parseAudioInputsMessage", () => {
  it("reads the helper's device list and skips malformed entries", () => {
    const output = [
      "noise",
      JSON.stringify({
        type: "audio-inputs",
        devices: [
          { id: "80-99:input", name: "WH-1000XM5", bluetooth: true, default: true },
          { id: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone" },
          { id: "", name: "empty" },
          { name: "no id" },
          { id: "x".repeat(513), name: "too long" },
        ],
      }),
    ].join("\n");
    expect(parseAudioInputsMessage(output)).toEqual([
      { id: "80-99:input", name: "WH-1000XM5", bluetooth: true, default: true },
      {
        id: "BuiltInMicrophoneDevice",
        name: "MacBook Pro Microphone",
        bluetooth: false,
        default: false,
      },
    ]);
    expect(parseAudioInputsMessage("not json")).toEqual([]);
  });
});

describe("AudioLevelMonitor", () => {
  it("passes the chosen microphone and restarts only when it matters", () => {
    const { monitor, helpers, spawnArgs } = makeMonitor();
    monitor.setSubscription(1, "microphone", "BuiltInMicrophoneDevice");
    expect(spawnArgs[0]?.[1]).toEqual([
      "--audio-level",
      "--source",
      "microphone",
      "--input-device",
      "BuiltInMicrophoneDevice",
    ]);

    monitor.setSubscription(1, "microphone", null);
    expect(helpers[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawnArgs[1]?.[1]).toEqual(["--audio-level", "--source", "microphone"]);

    // Mac audio alone ignores the microphone choice.
    monitor.setSubscription(1, "system", "BuiltInMicrophoneDevice");
    monitor.setSubscription(1, "system", "other");
    expect(helpers).toHaveLength(3);
    expect(spawnArgs[2]?.[1]).toEqual(["--audio-level", "--source", "system"]);
    monitor.dispose();
  });

  it("runs one helper while any subscriber is on and stops it after the last leaves", () => {
    const { monitor, helpers, spawnArgs } = makeMonitor();

    expect(monitor.setSubscription(1, "system")).toBe("active");
    expect(monitor.setSubscription(2, "system")).toBe("active");
    expect(helpers).toHaveLength(1);
    expect(spawnArgs[0]?.[1]).toEqual(["--audio-level", "--source", "system"]);

    monitor.setSubscription(1, null);
    expect(helpers[0]!.kill).not.toHaveBeenCalled();

    expect(monitor.setSubscription(2, null)).toBe("off");
    expect(helpers[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(monitor.isRunning).toBe(false);
  });

  it("restarts the helper with the new sources when the choice changes", () => {
    const { monitor, helpers, spawnArgs } = makeMonitor();
    monitor.setSubscription(1, "system");
    monitor.setSubscription(1, "both");

    expect(helpers[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawnArgs[1]?.[1]).toEqual([
      "--audio-level",
      "--source",
      "system",
      "--source",
      "microphone",
    ]);

    // Re-sending the same source keeps the running helper.
    monitor.setSubscription(1, "both");
    expect(helpers).toHaveLength(2);
    monitor.dispose();
  });

  it("forwards levels and rests the trail when the helper dies", async () => {
    const { monitor, helpers, levels, errors } = makeMonitor();
    monitor.setSubscription(1, "microphone");
    const helper = helpers[0]!;

    helper.emitLine({ type: "ready" });
    helper.emitLine({ type: "audio-level", level: 0.5 });
    await flushLines();
    expect(levels).toEqual([0.5]);

    helper.emitLine({ type: "error", code: "microphone_denied", message: "off" });
    await flushLines();
    helper.emit("close", 64);
    expect(monitor.status).toBe("unavailable");
    expect(levels).toEqual([0.5, 0]);
    expect(errors).toEqual(["microphone_denied: off"]);

    // The next subscription change retries with a fresh helper.
    monitor.setSubscription(2, "microphone");
    expect(helpers).toHaveLength(2);
    monitor.dispose();
  });

  it("ignores output from a helper it already stopped", async () => {
    const { monitor, helpers, levels } = makeMonitor();
    monitor.setSubscription(1, "system");
    const helper = helpers[0]!;
    monitor.setSubscription(1, null);

    helper.emitLine({ type: "audio-level", level: 0.8 });
    await flushLines();
    helper.emit("close", 0);
    expect(levels).toEqual([]);
  });
});
