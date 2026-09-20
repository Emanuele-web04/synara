import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type * as ChildProcess from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EscapeKillSwitchMonitor,
  type EscapeKillSwitchMonitorOptions,
} from "./escapeKillSwitchMonitor";

/**
 * A stand-in for the `--escape-monitor` helper: stdin lines are captured as
 * arm/disarm commands, stdout is the NDJSON channel the helper reports on,
 * and `close`/`error` simulate the process dying underneath the monitor.
 * `stdin.write` is a plain function rather than a real Writable so command
 * delivery is synchronous in assertions.
 */
class FakeHelper extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdinCommands: string[] = [];
  readonly stdin = {
    write: (chunk: string | Uint8Array) => {
      this.stdinCommands.push(String(chunk));
      return true;
    },
  };
  readonly kill = vi.fn();
}

function makeMonitor(
  overrides?: Partial<
    Pick<
      EscapeKillSwitchMonitorOptions,
      "onEscape" | "onError" | "onPhysicalInput" | "onStateChange"
    >
  >,
) {
  const helpers: FakeHelper[] = [];
  const spawn = (() => {
    const helper = new FakeHelper();
    helpers.push(helper);
    return helper;
  }) as unknown as typeof ChildProcess.spawn;
  const monitor = new EscapeKillSwitchMonitor({
    helperPath: "/fixture/appsnap",
    onEscape: overrides?.onEscape ?? (() => undefined),
    ...(overrides?.onError ? { onError: overrides.onError } : {}),
    ...(overrides?.onPhysicalInput ? { onPhysicalInput: overrides.onPhysicalInput } : {}),
    ...(overrides?.onStateChange ? { onStateChange: overrides.onStateChange } : {}),
    spawn,
  });
  return { monitor, helpers };
}

describe("EscapeKillSwitchMonitor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards arm and disarm commands to the helper", () => {
    const { monitor, helpers } = makeMonitor();
    monitor.start();
    const helper = helpers[0]!;
    monitor.setArmed(true);
    monitor.setArmed(false);
    expect(helper.stdinCommands).toEqual(["arm\n", "disarm\n"]);
    monitor.dispose();
  });

  it("reports an escape line from the helper exactly once per line", async () => {
    const onEscape = vi.fn();
    const { monitor, helpers } = makeMonitor({ onEscape });
    monitor.start();
    monitor.setArmed(true);
    helpers[0]!.stdout.write('{"type":"ready"}\n');
    helpers[0]!.stdout.write('{"type":"escape","capturedAt":"2026-09-18T00:00:00Z"}\n');
    await vi.waitFor(() => expect(onEscape).toHaveBeenCalledTimes(1));
    // A second physical press is a second event — the monitor must not
    // coalesce repeated presses, because each one re-confirms the kill.
    helpers[0]!.stdout.write('{"type":"escape"}\n');
    await vi.waitFor(() => expect(onEscape).toHaveBeenCalledTimes(2));
    monitor.dispose();
  });

  it("ignores ready and state messages but forwards helper errors", async () => {
    const onEscape = vi.fn();
    const onError = vi.fn();
    const { monitor, helpers } = makeMonitor({ onEscape, onError });
    monitor.start();
    const helper = helpers[0]!;
    helper.stdout.write('{"type":"ready"}\n');
    helper.stdout.write('{"type":"escape-monitor-state","armed":true}\n');
    helper.stdout.write(
      '{"type":"error","code":"input-monitoring-required","message":"input monitoring denied"}\n',
    );
    helper.stdout.write("not json at all\n");
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("input monitoring denied"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onEscape).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("respawns after an unexpected exit and replays the armed state", () => {
    vi.useFakeTimers();
    const { monitor, helpers } = makeMonitor();
    monitor.start();
    monitor.setArmed(true);
    const first = helpers[0]!;
    first.emit("close", 1);
    // First respawn waits the base backoff, not forever.
    vi.advanceTimersByTime(1_100);
    expect(helpers).toHaveLength(2);
    const second = helpers[1]!;
    // The armed side of the gate is replayed so a restarted helper does not
    // silently widen the window where Escape is inert.
    expect(second.stdinCommands).toEqual(["arm\n"]);
    monitor.dispose();
  });

  it("publishes missing listener access and recovers when the existing helper becomes ready", async () => {
    const onStateChange = vi.fn();
    const onPhysicalInput = vi.fn();
    const onEscape = vi.fn();
    const { monitor, helpers } = makeMonitor({ onStateChange, onPhysicalInput, onEscape });
    monitor.start();
    monitor.setArmed(true);
    const helper = helpers[0]!;
    helper.stdout.write(
      '{"type":"error","code":"input-monitoring-required","message":"Permission required"}\n',
    );
    helper.stdout.write(
      '{"type":"physical-input","kind":"keyboard","pid":50,"text":"never forwarded"}\n',
    );
    helper.stdout.write('{"type":"escape"}\n');
    await vi.waitFor(() =>
      expect(monitor.state).toEqual({ ready: false, error: "input-monitoring-required" }),
    );
    expect(onPhysicalInput).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();
    helper.stdout.write('{"type":"ready"}\n');
    helper.stdout.write(
      '{"type":"physical-input","kind":"pointer","pid":50,"windowId":70,"text":"never forwarded"}\n',
    );
    await vi.waitFor(() =>
      expect(onPhysicalInput).toHaveBeenCalledWith({
        type: "physical-input",
        kind: "pointer",
        pid: 50,
        windowId: 70,
      }),
    );
    expect(monitor.state).toEqual({ ready: true });
    expect(helpers).toHaveLength(1);
    expect(onStateChange).toHaveBeenLastCalledWith({ ready: true });
    monitor.setArmed(false);
    helper.stdout.write('{"type":"physical-input","kind":"keyboard","pid":50}\n');
    helper.stdout.write('{"type":"escape"}\n');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onPhysicalInput).toHaveBeenCalledTimes(1);
    expect(onEscape).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("replaces a denied listener only after a fresh permission probe confirms the grant", async () => {
    const { monitor, helpers } = makeMonitor();
    const denied = monitor.activate();
    helpers[0]!.stdout.write(
      '{"type":"error","code":"input-monitoring-required","message":"Denied"}\n',
    );
    await denied;
    await monitor.activate();
    expect(helpers).toHaveLength(1);
    const recovered = monitor.activate(true);
    expect(helpers).toHaveLength(2);
    expect(helpers[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    helpers[0]!.stdout.write('{"type":"ready"}\n');
    expect(monitor.state.ready).toBe(false);
    helpers[1]!.stdout.write('{"type":"ready"}\n');
    await recovered;
    expect(monitor.state.ready).toBe(true);
    monitor.dispose();
  });

  it("closes readiness on helper exit and ignores late messages from that process", async () => {
    const onPhysicalInput = vi.fn();
    const { monitor, helpers } = makeMonitor({ onPhysicalInput });
    monitor.start();
    monitor.setArmed(true);
    const helper = helpers[0]!;
    helper.stdout.write('{"type":"ready"}\n');
    await vi.waitFor(() => expect(monitor.state.ready).toBe(true));
    helper.emit("close", 1);
    helper.stdout.write('{"type":"ready"}\n');
    helper.stdout.write('{"type":"physical-input","kind":"keyboard","pid":50}\n');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(monitor.state).toEqual({ ready: false, error: "input_monitor_unavailable" });
    expect(onPhysicalInput).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("waits for first activation readiness without spawning or polling while unused", async () => {
    const { monitor, helpers } = makeMonitor();
    expect(helpers).toHaveLength(0);
    let completed = false;
    const activation = monitor.activate().then(() => {
      completed = true;
    });
    expect(helpers).toHaveLength(1);
    expect(helpers[0]!.stdinCommands).toEqual(["arm\n"]);
    expect(completed).toBe(false);
    helpers[0]!.stdout.write('{"type":"ready"}\n');
    await activation;
    expect(monitor.state.ready).toBe(true);
    monitor.setArmed(false);
    expect(monitor.state).toEqual({ ready: false, error: "input_monitor_idle" });
    const reactivated = monitor.activate();
    expect(monitor.state.ready).toBe(false);
    helpers[0]!.stdout.write('{"type":"ready"}\n');
    await reactivated;
    expect(helpers).toHaveLength(1);
    monitor.dispose();
  });

  it("bounds readiness waits and does not restart a helper after disarm", async () => {
    vi.useFakeTimers();
    const { monitor, helpers } = makeMonitor();
    const activation = monitor.activate();
    await vi.advanceTimersByTimeAsync(1_000);
    await activation;
    expect(monitor.state.ready).toBe(false);
    helpers[0]!.emit("close", 1);
    monitor.setArmed(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(helpers).toHaveLength(1);
    monitor.dispose();
  });

  it("does not spawn twice when activation overtakes the restart timer", async () => {
    vi.useFakeTimers();
    const { monitor, helpers } = makeMonitor();
    const firstActivation = monitor.activate();
    helpers[0]!.stdout.write('{"type":"ready"}\n');
    await firstActivation;
    helpers[0]!.emit("close", 1);
    const secondActivation = monitor.activate();
    helpers[1]!.stdout.write('{"type":"ready"}\n');
    await secondActivation;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(helpers).toHaveLength(2);
    monitor.dispose();
  });

  it("does not respawn once disposed", () => {
    vi.useFakeTimers();
    const { monitor, helpers } = makeMonitor();
    monitor.start();
    const first = helpers[0]!;
    monitor.dispose();
    expect(first.kill).toHaveBeenCalledWith("SIGTERM");
    first.emit("close", 0);
    vi.advanceTimersByTime(60_000);
    expect(helpers).toHaveLength(1);
  });
});
