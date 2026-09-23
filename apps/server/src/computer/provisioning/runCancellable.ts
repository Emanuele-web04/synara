/**
 * A child process that a caller can actually stop.
 *
 * `execFile` with a `timeout` signals only the direct child: a `bash` script
 * that has spawned `cmake`, which spawned `ninja`, which spawned a dozen
 * compilers, leaves all of them running when bash dies, and nothing ever
 * reaps them. This spawns the child in its own process group and, on abort or
 * timeout, hands the whole tree to the platform teardown that already knows how
 * to TERM, escalate to KILL, and prove exit. There is one implementation of
 * that sequence in the server and this is a client of it, not a second copy.
 */
import { spawn } from "node:child_process";

import { teardownChildProcessTree } from "../../platform/supervisedProcessTeardown.ts";

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL_LINES = 12;

export interface RunCancellableOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /**
   * Per stream. Output beyond this keeps its tail, because the tail is what
   * every consumer wants: the built path is the last stdout line and the
   * compiler's reason is the last stderr lines.
   */
  readonly maxOutputBytes?: number | undefined;
}

export interface RunCancellableResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** Non-zero exit. `stderrTail` is the part of stderr worth showing a person. */
export class CommandFailedError extends Error {
  readonly command: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string;

  constructor(input: {
    readonly command: string;
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: string;
  }) {
    const tail = stderrTail(input.stderr);
    const outcome =
      input.code !== null ? `exited with code ${input.code}` : `was killed by ${input.signal}`;
    super(`${input.command} ${outcome}${tail ? `: ${tail}` : ""}`);
    this.name = "CommandFailedError";
    this.command = input.command;
    this.code = input.code;
    this.signal = input.signal;
    this.stderrTail = tail;
  }
}

export class CommandTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    super(`${command} did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped.`);
    this.name = "CommandTimeoutError";
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

export function stderrTail(stderr: string): string {
  return stderr.trimEnd().split("\n").slice(-STDERR_TAIL_LINES).join("\n").trim();
}

/** Bounded accumulator that keeps the most recent bytes. */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.size -= dropped.length;
    }
    if (this.size > this.limit) {
      const only = this.chunks[0]!;
      this.chunks = [only.subarray(only.length - this.limit)];
      this.size = this.limit;
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/**
 * Runs `command` to completion, or stops it and everything it spawned.
 *
 * Resolves on exit 0. Rejects with the abort reason when `signal` fires, with
 * `CommandTimeoutError` when `timeoutMs` elapses, and with `CommandFailedError`
 * on any other non-zero exit. In the first two cases the promise does not
 * settle until the process tree is proven gone, so a caller that retries after
 * a cancel is never racing the build it just cancelled.
 */
export function runCancellable(
  command: string,
  args: readonly string[],
  options: RunCancellableOptions = {},
): Promise<RunCancellableResult> {
  const { signal, timeoutMs, cwd, env } = options;
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise<RunCancellableResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = new TailBuffer(limit);
    const stderr = new TailBuffer(limit);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    let settled = false;
    let interruption: { reason: unknown } | undefined;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
    };
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      outcome();
    };

    const interrupt = (reason: unknown) => {
      if (interruption || settled) return;
      interruption = { reason };
      // The child may have exited between the trigger and this call; teardown
      // handles that case itself, so it is always safe to hand over. The
      // rejection is delivered from "close" below once the tree is gone.
      void teardownChildProcessTree(child).catch((error: unknown) => {
        // Teardown could not prove the tree exited. The caller's reason still
        // wins, but not before the failure is attached so it is not lost.
        interruption = { reason: withTeardownFailure(reason, error) };
        settle(() => reject(interruption!.reason));
      });
    };
    const onAbort = () => interrupt(signal!.reason);

    child.once("error", (error) => settle(() => reject(error)));
    child.once("close", (code, exitSignal) => {
      settle(() => {
        if (interruption) {
          reject(interruption.reason);
        } else if (code === 0) {
          resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code });
        } else {
          reject(
            new CommandFailedError({
              command,
              code,
              signal: exitSignal,
              stderr: stderr.toString(),
            }),
          );
        }
      });
    });

    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== undefined && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => interrupt(new CommandTimeoutError(command, timeoutMs)), timeoutMs);
      timer.unref();
    }
  });
}

function withTeardownFailure(reason: unknown, failure: unknown): unknown {
  if (reason instanceof Error && failure instanceof Error) {
    return new Error(`${reason.message} (${failure.message})`, { cause: reason });
  }
  return reason;
}
