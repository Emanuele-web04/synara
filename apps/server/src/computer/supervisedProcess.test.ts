import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it } from "vitest";

import { ComputerBackendError } from "./ComputerBackend.ts";
import { startSupervisedProcess, type ProcessTreeTeardown } from "./supervisedProcess.ts";
import { teardownProviderProcessTree } from "../platform/supervisedProcessTeardown.ts";
import type {
  CapturedProcess,
  CapturedProcessTree,
  TerminalKillSignal,
} from "../platform/processTreeController.ts";

const ROOT_PID = 4_242;
const XWAYLAND: CapturedProcess = { pid: 4_243, command: "Xwayland :9" };

/** A child process that records signals instead of dying, with a pid a teardown can target. */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdio = [null, this.stdout, this.stderr];
  readonly pid = ROOT_PID;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.end(signal ?? "SIGTERM");
    return true;
  }

  /** The process actually ending, as Node reports it. */
  end(signal: NodeJS.Signals | null, code: number | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  unref(): void {}
  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

interface TeardownRecorder {
  readonly teardown: ProcessTreeTeardown;
  readonly signals: Array<{ readonly signal: TerminalKillSignal; readonly pids: number[] }>;
  /** Milliseconds of virtual time the teardown waited; never real sleep. */
  elapsed(): number;
}

/**
 * The real platform teardown with a fake process table underneath it, so
 * escalation and the exit proof are exercised rather than stubbed — and no
 * signal ever reaches a real pid.
 */
function recordingTeardown(options: {
  /** Descendants that survive SIGTERM; SIGKILL always clears them. */
  readonly survivesTerm?: boolean;
  /** A child stuck in uninterruptible IO: nothing ever proves its exit. */
  readonly neverProvesExit?: boolean;
  readonly child?: FakeChild;
}): TeardownRecorder {
  const signals: TeardownRecorder["signals"] = [];
  const tree: CapturedProcessTree = { descendants: [XWAYLAND], captureComplete: true };
  let survivors: CapturedProcess[] = [XWAYLAND];
  let clock = 0;
  const teardown: ProcessTreeTeardown = (input) =>
    teardownProviderProcessTree(input, {
      platform: "linux",
      captureProcessTree: async () => tree,
      inspectProcessTree: async () => ({
        verified: !options.neverProvesExit,
        survivors: [...survivors],
      }),
      isRootRunning: async () => false,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      processTreeKiller: {
        capture: () => tree,
        inspect: () => ({ verified: !options.neverProvesExit, survivors: [...survivors] }),
        signal: (signalInput) => {
          signals.push({
            signal: signalInput.signal,
            pids: [
              ...(signalInput.includeRootTree === true ? [signalInput.rootPid] : []),
              ...signalInput.tree.descendants.map((descendant) => descendant.pid),
            ],
          });
          if (signalInput.signal === "SIGTERM") {
            options.child?.end("SIGTERM");
            if (options.survivesTerm !== true) survivors = [];
          } else if (!options.neverProvesExit) {
            survivors = [];
          }
        },
      },
    });
  return { teardown, signals, elapsed: () => clock };
}

function start(child: FakeChild, teardown?: ProcessTreeTeardown) {
  return startSupervisedProcess({
    command: "kwin_wayland",
    args: [],
    env: {},
    spawnProcess: () => child.asChildProcess(),
    ...(teardown ? { teardownProcessTree: teardown } : {}),
  });
}

describe("terminate", () => {
  it("ends the whole process tree, not only the root the server spawned", async () => {
    // kwin_wayland forks an Xwayland; signalling the compositor alone leaves it
    // reparented to init, still holding the session's sockets.
    const child = new FakeChild();
    const recorder = recordingTeardown({ child });
    await start(child, recorder.teardown).terminate();

    expect(recorder.signals[0]).toEqual({ signal: "SIGTERM", pids: [ROOT_PID, XWAYLAND.pid] });
    expect(recorder.signals).toHaveLength(1);
  });

  it("escalates to SIGKILL when a descendant ignores SIGTERM", async () => {
    const child = new FakeChild();
    const recorder = recordingTeardown({ child, survivesTerm: true });
    await start(child, recorder.teardown).terminate();

    expect(recorder.signals.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    // The root already exited under SIGTERM, so its numeric pid is never
    // signalled again: that number can have been reused by then.
    expect(recorder.signals[1]?.pids).toEqual([XWAYLAND.pid]);
  });

  it("returns instead of hanging when no exit can ever be proven", async () => {
    // A child in uninterruptible IO survives SIGKILL for as long as the IO
    // takes. dispose() must still complete: the teardown is bounded and the
    // failure is recorded rather than thrown.
    const child = new FakeChild();
    const recorder = recordingTeardown({ child, neverProvesExit: true });
    const supervised = start(child, recorder.teardown);

    await expect(supervised.terminate()).resolves.toBeUndefined();
    expect(recorder.signals.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(supervised.diagnostic()).toContain("could not prove exit");
    // Bounded by the platform deadlines rather than by the child.
    expect(recorder.elapsed()).toBeLessThanOrEqual(10_000);
  });

  it("is single-flight, so a double dispose signals once", async () => {
    const child = new FakeChild();
    const recorder = recordingTeardown({ child });
    const supervised = start(child, recorder.teardown);

    await Promise.all([supervised.terminate(), supervised.terminate()]);
    await supervised.terminate();

    expect(recorder.signals).toHaveLength(1);
  });

  it("still sweeps descendants of a child that already exited on its own", async () => {
    // The compositor crashed; its Xwayland did not. Nothing else will reap it.
    const child = new FakeChild();
    const recorder = recordingTeardown({ child });
    const supervised = start(child, recorder.teardown);
    child.end(null, 1);

    await supervised.terminate();
    expect(recorder.signals[0]).toEqual({ signal: "SIGTERM", pids: [XWAYLAND.pid] });
  });

  it("releases every pipe so the event loop has no reason to stay awake", async () => {
    const child = new FakeChild();
    await start(child, recordingTeardown({ child }).teardown).terminate();

    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });
});

describe("exit reporting", () => {
  it("records the first ending, and reports it to listeners exactly once", async () => {
    const child = new FakeChild();
    const supervised = start(child);
    const reasons: string[] = [];
    supervised.onExit((reason) => reasons.push(reason));

    expect(supervised.exitDiagnostic()).toBeUndefined();
    child.end(null, 1);
    child.emit("error", new Error("and then a spawn error"));

    expect(supervised.exitDiagnostic()).toBe("exit code 1, signal null");
    expect(reasons).toEqual(["exit code 1, signal null"]);
  });

  it("calls a listener registered after the exit, so no watcher can miss it", async () => {
    const child = new FakeChild();
    const supervised = start(child);
    child.end("SIGKILL");
    const reasons: string[] = [];
    supervised.onExit((reason) => reasons.push(reason));

    await Promise.resolve();
    expect(reasons).toEqual(["exit code null, signal SIGKILL"]);
  });

  it("stops calling a listener that unsubscribed", () => {
    const child = new FakeChild();
    const supervised = start(child);
    const reasons: string[] = [];
    supervised.onExit((reason) => reasons.push(reason))();
    child.end(null, 0);

    expect(reasons).toEqual([]);
  });
});

describe("stderr diagnostics", () => {
  it("keeps the tail rather than the whole log", () => {
    const child = new FakeChild();
    const supervised = start(child);
    for (let index = 0; index < 8; index += 1) {
      child.stderr.emit("data", Buffer.from(`${"x".repeat(1_024)}\n`));
    }
    child.stderr.emit("data", Buffer.from("could not open drm device"));

    const diagnostic = supervised.diagnostic();
    expect(diagnostic).toContain("could not open drm device");
    // Bounded: a chatty compositor cannot grow this buffer without limit.
    expect(diagnostic.length).toBeLessThan(8 * 1_024);
  });

  it("says nothing when the process said nothing", () => {
    expect(start(new FakeChild()).diagnostic()).toBe("");
  });
});

describe("readFirstStdoutLine", () => {
  it("resolves with the first line a daemon prints", async () => {
    const child = new FakeChild();
    const supervised = start(child);
    const line = supervised.readFirstStdoutLine(1_000);
    child.stdout.write("unix:path=/tmp/bus,guid=abc\nignored\n");

    await expect(line).resolves.toBe("unix:path=/tmp/bus,guid=abc");
  });

  it("assembles a line that arrives in pieces", async () => {
    const child = new FakeChild();
    const supervised = start(child);
    const line = supervised.readFirstStdoutLine(1_000);
    child.stdout.write("unix:path=");
    child.stdout.write("/tmp/bus\n");

    await expect(line).resolves.toBe("unix:path=/tmp/bus");
  });

  it("fails fast with the process's own diagnostic when it exits first", async () => {
    const child = new FakeChild();
    const supervised = start(child);
    const line = supervised.readFirstStdoutLine(60_000);
    child.stderr.emit("data", Buffer.from("Failed to start message bus"));
    child.end(null, 1);

    // The deadline is a minute away; waiting it out for an answer that can no
    // longer come is the failure this race exists to avoid.
    await expect(line).rejects.toThrow(
      /exited before it printed anything: exit code 1, signal null\. Last kwin_wayland output: Failed to start message bus/,
    );
    await expect(line).rejects.toBeInstanceOf(ComputerBackendError);
  });

  it("fails fast on a spawn error too", async () => {
    const child = new FakeChild();
    const supervised = start(child);
    const line = supervised.readFirstStdoutLine(60_000);
    child.emit("error", new Error("spawn dbus-daemon ENOENT"));

    await expect(line).rejects.toThrow(/spawn dbus-daemon ENOENT/);
  });

  it("gives up on a process that started and then said nothing", async () => {
    const child = new FakeChild();
    await expect(start(child).readFirstStdoutLine(5)).rejects.toThrow(
      /printed no output within 5 ms/,
    );
  });

  it("ignores an exit that happens after the line was read", async () => {
    const child = new FakeChild();
    const supervised = start(child);
    const line = supervised.readFirstStdoutLine(1_000);
    child.stdout.write("unix:path=/tmp/bus\n");
    await expect(line).resolves.toBe("unix:path=/tmp/bus");

    // The listeners are detached on settle, so this cannot reject a settled
    // promise or leave a handler on a process that outlives the read.
    expect(() => child.end(null, 0)).not.toThrow();
  });

  it("refuses a process spawned with no stdout pipe to read", async () => {
    const child = new FakeChild();
    const supervised = startSupervisedProcess({
      command: "kwin_wayland",
      args: [],
      env: {},
      spawnProcess: () =>
        ({
          ...child.asChildProcess(),
          stdout: null,
          stdio: [null, null, child.stderr],
          on: () => undefined,
          unref: () => undefined,
        }) as unknown as ChildProcess,
    });

    await expect(supervised.readFirstStdoutLine(1_000)).rejects.toThrow(/has no stdout to read/);
  });
});

describe("startSupervisedProcess", () => {
  it("converts a spawn failure into the one error type callers catch", () => {
    expect(() =>
      startSupervisedProcess({
        command: "kwin_wayland",
        args: [],
        env: {},
        spawnProcess: () => {
          throw new Error("spawn kwin_wayland ENOENT");
        },
      }),
    ).toThrow(/kwin_wayland could not be started: spawn kwin_wayland ENOENT/);
  });
});
