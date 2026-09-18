import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type * as ChildProcess from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EscapeKillSwitchMonitor } from "./escapeKillSwitchMonitor";

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

function makeMonitor(overrides?: { onEscape?: () => void; onError?: (message: string) => void }) {
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
