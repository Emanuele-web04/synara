import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EscapeKillSwitchMonitor } from "./escapeKillSwitchMonitor";

class Helper extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = { write: vi.fn(() => true) };
  readonly kill = vi.fn(() => true);

  send(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

const monitors: EscapeKillSwitchMonitor[] = [];
function fixture() {
  const helpers: Helper[] = [];
  const onEscape = vi.fn();
  const onPhysicalInput = vi.fn();
  const spawn = (() => {
    const helper = new Helper();
    helpers.push(helper);
    return helper;
  }) as unknown as typeof ChildProcess.spawn;
  const monitor = new EscapeKillSwitchMonitor({
    helperPath: "/fixture/appsnap",
    spawn,
    onEscape,
    onPhysicalInput,
  });
  monitors.push(monitor);
  monitor.setArmed(true);
  return { monitor, helpers, onEscape, onPhysicalInput };
}

describe("Escape listener readiness recovery", () => {
  afterEach(() => {
    for (const monitor of monitors.splice(0)) monitor.dispose();
    vi.useRealTimers();
  });

  it("retires a silent listener and waits for the replacement's ready acknowledgement", async () => {
    vi.useFakeTimers();
    const { monitor, helpers, onEscape, onPhysicalInput } = fixture();
    const old = helpers[0]!;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(old.kill).toHaveBeenCalledWith("SIGTERM");
    expect(monitor.state.ready).toBe(false);
    old.send({ type: "ready" });
    old.send({ type: "escape" });
    old.send({ type: "physical-input", kind: "keyboard" });
    expect(monitor.state.ready).toBe(false);
    expect(onEscape).not.toHaveBeenCalled();
    expect(onPhysicalInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(helpers).toHaveLength(2);
    expect(helpers[1]!.stdin.write).toHaveBeenCalledWith("arm\n");
    expect(monitor.state.ready).toBe(false);
    helpers[1]!.send({ type: "ready" });
    expect(monitor.state.ready).toBe(true);
    helpers[1]!.send({ type: "escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("does not extend the watchdog on repeated arms or transient errors", async () => {
    vi.useFakeTimers();
    const { monitor, helpers } = fixture();
    await vi.advanceTimersByTimeAsync(4_000);
    monitor.setArmed(true);
    helpers[0]!.send({ type: "error", code: "event_tap_disabled", message: "Disabled" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(helpers[0]!.kill).toHaveBeenCalledTimes(1);
  });

  it("lets a temporarily disabled tap recover without replacing a healthy helper", async () => {
    vi.useFakeTimers();
    const { monitor, helpers } = fixture();
    helpers[0]!.send({ type: "ready" });
    helpers[0]!.send({ type: "error", code: "event_tap_disabled", message: "Disabled" });
    expect(monitor.state.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(4_000);
    helpers[0]!.send({ type: "ready" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(monitor.state.ready).toBe(true);
    expect(helpers).toHaveLength(1);
    expect(helpers[0]!.kill).not.toHaveBeenCalled();
  });

  it("recovers a disabled tap that stays alive but never acknowledges readiness", async () => {
    vi.useFakeTimers();
    const { monitor, helpers } = fixture();
    helpers[0]!.send({ type: "ready" });
    helpers[0]!.send({ type: "error", code: "event_tap_unavailable", message: "Unavailable" });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(helpers).toHaveLength(2);
    expect(helpers[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(monitor.state.ready).toBe(false);
  });

  it("does not churn a permission-denied helper or treat another arm as a grant", async () => {
    vi.useFakeTimers();
    const { monitor, helpers } = fixture();
    helpers[0]!.send({ type: "error", code: "input-monitoring-required", message: "Denied" });
    monitor.setArmed(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(helpers).toHaveLength(1);
    expect(helpers[0]!.kill).not.toHaveBeenCalled();
    expect(monitor.state).toEqual({ ready: false, error: "input-monitoring-required" });
  });

  it.each(["disarm", "dispose"] as const)("cancels watchdog recovery on %s", async (action) => {
    vi.useFakeTimers();
    const { monitor, helpers } = fixture();
    if (action === "disarm") monitor.setArmed(false);
    else monitor.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(helpers).toHaveLength(1);
    expect(monitor.state.ready).toBe(false);
    expect(helpers[0]!.kill).toHaveBeenCalledTimes(action === "dispose" ? 1 : 0);
  });

  it("backs off repeated silent starts rather than spawning in a tight loop", async () => {
    vi.useFakeTimers();
    const { helpers } = fixture();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(helpers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(helpers).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(helpers).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(helpers).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(helpers).toHaveLength(4);
  });
});
