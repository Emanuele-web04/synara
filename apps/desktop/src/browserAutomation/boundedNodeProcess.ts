import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnProcess } from "@synara/shared/processRuntime";

export type BoundedNodeProcessFailure =
  | "cancelled"
  | "timed_out"
  | "input_too_large"
  | "output_too_large"
  | "process_failed";

export class BoundedNodeProcessError extends Error {
  constructor(readonly code: BoundedNodeProcessFailure) {
    super("Bounded browser data process failed.");
    this.name = "BoundedNodeProcessError";
  }
}

/** Runs one bounded Node script with private input on stdin and waits for child close. */
export async function runBoundedNodeProcess(
  script: string,
  payload: Buffer,
  options: {
    home: string;
    signal: AbortSignal;
    timeoutMs: number;
    maxInputBytes: number;
    maxOutputBytes: number;
    maxStderrBytes: number;
  },
): Promise<string> {
  const { home, signal } = options;
  if (signal.aborted) {
    payload.fill(0);
    throw signal.reason ?? new BoundedNodeProcessError("cancelled");
  }
  if (payload.byteLength > options.maxInputBytes) {
    payload.fill(0);
    throw new BoundedNodeProcessError("input_too_large");
  }

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abortFromCaller, { once: true });
  if (signal.aborted) abortFromCaller();
  let timedOut = false;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    Math.max(1, options.timeoutMs),
  );
  let tempWorkspace: string | undefined;
  try {
    tempWorkspace = await mkdtemp(join(tmpdir(), "synara-browser-process-"));
    const child = spawnProcess(process.execPath, ["--input-type=module", "-e", script], {
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        HOME: home,
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        TMPDIR: tempWorkspace,
        TEMP: tempWorkspace,
        TMP: tempWorkspace,
      },
      signal: controller.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const output: Buffer[] = [];
    let outputBytes = 0;
    let stderrBytes = 0;
    let outputTooLarge = false;
    let stderrTooLarge = false;
    let stdinError = false;
    let spawnError = false;
    child.stdout.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        outputTooLarge = true;
        controller.abort();
        return;
      }
      output.push(bytes);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > options.maxStderrBytes) {
        stderrTooLarge = true;
        controller.abort();
      }
    });
    child.stdin.on("error", () => {
      stdinError = true;
      controller.abort();
    });
    child.on("error", () => {
      spawnError = true;
      controller.abort();
    });
    const closed = new Promise<number | null>((resolve) => {
      child.once("close", (code: number | null) => resolve(code));
    });
    child.stdin.end(payload, () => payload.fill(0));

    const exitCode = await closed;
    if (signal.aborted) throw signal.reason ?? new BoundedNodeProcessError("cancelled");
    if (timedOut) throw new BoundedNodeProcessError("timed_out");
    if (outputTooLarge) throw new BoundedNodeProcessError("output_too_large");
    if (stderrTooLarge || stdinError || spawnError || exitCode !== 0)
      throw new BoundedNodeProcessError("process_failed");
    return Buffer.concat(output).toString("utf8");
  } catch (error) {
    payload.fill(0);
    if (signal.aborted) throw signal.reason ?? error;
    if (timedOut) throw new BoundedNodeProcessError("timed_out");
    if (error instanceof BoundedNodeProcessError) throw error;
    throw new BoundedNodeProcessError("process_failed");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortFromCaller);
    payload.fill(0);
    if (tempWorkspace) await rm(tempWorkspace, { recursive: true, force: true });
  }
}
