/**
 * A supervised child process whose failures explain themselves.
 *
 * Every helper this feature boots — the nested compositor and its private bus —
 * fails in the same three ways: it never starts, it exits early, or it starts
 * and then says nothing. All three are only diagnosable from the process's own
 * stderr, and none of them should be waited out to a deadline when the process
 * is already gone. So a spawn error or an early exit is recorded rather than
 * thrown, every wait watches for it, and the stderr tail rides along on the
 * failure message.
 *
 * Ending one is not this module's own invention. `kwin_wayland` forks an
 * Xwayland of its own, and a SIGTERM to the compositor alone leaves that
 * Xwayland — and every X11 client behind it — reparented to init and holding
 * the session's sockets. The platform's `supervisedProcessTeardown` already
 * owns that sequence for provider runtimes (TERM, then KILL over the captured
 * tree, with proof of exit), so this class delegates to it rather than keeping
 * a second, weaker copy that only signals the root.
 */
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";

import { ComputerBackendError } from "./ComputerBackend.ts";
import {
  teardownChildProcessTree,
  type teardownProviderProcessTree,
} from "../platform/supervisedProcessTeardown.ts";

/** Enough child stderr to quote a startup failure, never a whole log. */
const MAX_DIAGNOSTIC_BYTES = 4 * 1024;

/** The platform teardown, injectable so tests never signal a real process tree. */
export type ProcessTreeTeardown = typeof teardownProviderProcessTree;

/**
 * One supervised child. A spawn error or an early exit is recorded instead of
 * thrown, so every wait can fail fast with the process's own diagnostic rather
 * than running to its deadline.
 */
export class SupervisedProcess {
  private readonly stderr: Buffer[] = [];
  private stderrBytes = 0;
  private exited: string | undefined;
  private terminated: Promise<void> | undefined;
  private readonly exitListeners = new Set<(reason: string) => void>();

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly child: ChildProcess,
    private readonly teardownProcessTree?: ProcessTreeTeardown,
  ) {
    child.stderr?.on("data", (chunk: Buffer) => this.pushStderr(chunk));
    child.on("error", (error) => this.recordExit(describeProcessError(error)));
    child.on("exit", (code, signal) =>
      this.recordExit(`exit code ${code ?? "null"}, signal ${signal ?? "null"}`),
    );
    // The process handle must not hold the server's event loop open. The stdio
    // pipes stay referenced until terminate destroys them, because the startup
    // handshake reads them and an unreferenced pipe can lose that race.
    child.unref();
  }

  /** The child's own pid, for the marker a later server sweeps stale sessions with. */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** A daemon that prints its address and then serves; only the first line matters. */
  readFirstStdoutLine(timeoutMs: number): Promise<string> {
    const stdout = this.child.stdout;
    if (!stdout) {
      return Promise.reject(new ComputerBackendError(`${this.command} has no stdout to read.`));
    }
    return new Promise<string>((resolve, reject) => {
      let buffered = "";
      const settle = (outcome: () => void) => {
        clearTimeout(timer);
        stdout.off("data", onData);
        this.child.off("exit", onExit);
        this.child.off("error", onExit);
        outcome();
      };
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const newline = buffered.indexOf("\n");
        if (newline >= 0) settle(() => resolve(buffered.slice(0, newline).trim()));
      };
      const onExit = () => {
        settle(() =>
          reject(
            new ComputerBackendError(
              `${this.command} exited before it printed anything: ${this.exitDiagnostic() ?? "unknown reason"}.${this.diagnostic()}`,
            ),
          ),
        );
      };
      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new ComputerBackendError(
              `${this.command} printed no output within ${timeoutMs} ms.${this.diagnostic()}`,
            ),
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      stdout.on("data", onData);
      this.child.once("exit", onExit);
      this.child.once("error", onExit);
    });
  }

  /** How the process ended, or `undefined` while it is still running. */
  exitDiagnostic(): string | undefined {
    return this.exited;
  }

  /**
   * Calls back once, with the reason, when the process ends — immediately if it
   * has already ended.
   *
   * A session whose bus daemon outlives its dead compositor is a session whose
   * D-Bus clients never see a disconnect, so nothing ever invalidates their
   * connections. This is how the session learns to take the rest of itself down
   * instead.
   */
  onExit(listener: (reason: string) => void): () => void {
    if (this.exited !== undefined) {
      const reason = this.exited;
      queueMicrotask(() => listener(reason));
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** The tail of stderr, formatted for appending to a failure message. */
  diagnostic(): string {
    const text = Buffer.concat(this.stderr).toString("utf8").trim();
    return text.length > 0 ? ` Last ${this.command} output: ${text}` : "";
  }

  /**
   * Ends the process and everything it forked, and releases its pipes.
   *
   * Single-flight and never rejecting: this runs from `dispose()` on paths that
   * are already failing, and a teardown that throws would strand the pipes it
   * was called to release. An unproven exit is recorded in the diagnostic
   * instead, which is the only place a caller can act on it.
   */
  terminate(): Promise<void> {
    this.terminated ??= this.runTeardown();
    return this.terminated;
  }

  private async runTeardown(): Promise<void> {
    try {
      if (this.child.pid !== undefined) {
        // Bounded by the platform module's own TERM and KILL deadlines, so a
        // child wedged in uninterruptible IO cannot hang the whole dispose.
        await teardownChildProcessTree(this.child, this.teardownProcessTree);
      } else if (this.exited === undefined) {
        this.child.kill("SIGKILL");
      }
    } catch (error) {
      this.pushStderr(
        Buffer.from(
          `\n${this.command} teardown could not prove exit: ${describeProcessError(error)}`,
        ),
      );
    } finally {
      // Every pipe, not just stdout and stderr: a helper spawned with a stdin
      // or an extra frame channel would otherwise leave those fds referenced
      // and the event loop with a reason to stay awake.
      for (const stream of this.child.stdio) {
        (stream as { destroy?: () => void } | null)?.destroy?.();
      }
    }
  }

  private recordExit(reason: string): void {
    if (this.exited !== undefined) return;
    this.exited = reason;
    const listeners = [...this.exitListeners];
    this.exitListeners.clear();
    for (const listener of listeners) listener(reason);
  }

  private pushStderr(chunk: Buffer): void {
    this.stderr.push(chunk);
    this.stderrBytes += chunk.byteLength;
    while (this.stderrBytes > MAX_DIAGNOSTIC_BYTES && this.stderr.length > 1) {
      this.stderrBytes -= this.stderr.shift()?.byteLength ?? 0;
    }
  }
}

export type SupervisedSpawn = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdio?: StdioOptions,
) => ChildProcess;

/** stdin ignored, stderr piped: enough for a daemon that is only watched. */
const DEFAULT_SUPERVISED_STDIO: StdioOptions = ["ignore", "pipe", "pipe"];

/**
 * The default spawn for a supervised child: an ordinary child of this process,
 * so a signal to the server's process group reaches it too, with stderr piped
 * because the diagnostic is the whole point.
 */
export const spawnSupervisedProcess: SupervisedSpawn = (command, args, env, stdio) =>
  spawn(command, [...args], { stdio: stdio ?? DEFAULT_SUPERVISED_STDIO, env });

/**
 * Spawns and wraps a child, converting a spawn failure into the same error type
 * every later failure uses so a caller has one thing to catch.
 */
export function startSupervisedProcess(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** Non-default pipe layout, e.g. a helper with an extra fd 3 frame channel. */
  readonly stdio?: StdioOptions;
  readonly spawnProcess?: SupervisedSpawn;
  readonly teardownProcessTree?: ProcessTreeTeardown;
}): SupervisedProcess {
  const spawnProcess = options.spawnProcess ?? spawnSupervisedProcess;
  let child: ChildProcess;
  try {
    child = spawnProcess(options.command, options.args, options.env, options.stdio);
  } catch (error) {
    throw new ComputerBackendError(
      `${options.command} could not be started: ${describeProcessError(error)}`,
      { cause: error },
    );
  }
  return new SupervisedProcess(options.command, options.args, child, options.teardownProcessTree);
}

export function describeProcessError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
