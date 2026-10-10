import { spawn } from "node:child_process";
import { parseFixtureState, type FixtureState } from "./packaged-evidence.ts";

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitUntil<T>(
  read: () => Promise<T | null> | T | null,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  do {
    const result = await read();
    if (result !== null) return result;
    await delay(100);
  } while (performance.now() < deadline);
  throw new Error(`${label} timed out.`);
}

/** The child is a test target only. It reports its own AppKit state, providing
 * proof independent of the agent's prose and of Computer audit records. */
export async function startNativeTarget(binary: string) {
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
  const states = new Map<string, FixtureState>();
  const counterChanges: { clicks: number; receivedAtMs: number }[] = [];
  let lastCounterObservationMs: number | null = null;
  let buffer = "";
  let sequence = 0;
  let failed = false;
  child.once("error", () => {
    failed = true;
  });
  child.stdin.on("error", () => {
    failed = true;
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  child.stdout.on("data", (bytes: Buffer) => {
    buffer += bytes.toString("utf8");
    if (buffer.length > 65_536) {
      failed = true;
      child.kill("SIGTERM");
      return;
    }
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const state = parseFixtureState(JSON.parse(line));
        if (state && state.pid === child.pid) {
          if (state.label === "A") {
            lastCounterObservationMs = performance.now();
            const previous = states.get("A");
            if (previous && previous.clicks !== state.clicks) {
              counterChanges.push({ clicks: state.clicks, receivedAtMs: lastCounterObservationMs });
              if (counterChanges.length > 256) counterChanges.shift();
            }
          }
          states.set(state.label, state);
          sequence++;
        }
      } catch {
        failed = true;
      }
    }
  });
  const close = async () => {
    child.stdin.end("quit\n");
    const timer = setTimeout(() => child.kill("SIGTERM"), 2_000);
    const code = await exited;
    clearTimeout(timer);
    return code === 0;
  };
  const snapshot = async () => {
    const before = sequence;
    child.stdin.write("state\n");
    return waitUntil(
      () => {
        if (failed || child.exitCode !== null) throw new Error("Native fixture exited.");
        const a = states.get("A");
        const b = states.get("B");
        return sequence >= before + 2 && a && b ? { a, b } : null;
      },
      3_000,
      "Fixture state",
    );
  };
  try {
    await waitUntil(
      () => {
        if (failed || child.exitCode !== null) throw new Error("Native fixture failed to start.");
        return states.size === 2 ? true : null;
      },
      5_000,
      "Native fixture start",
    );
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  return {
    snapshot,
    current: () => states.get("A")!,
    counterChanges,
    lastCounterObservation: () => lastCounterObservationMs,
    activateHuman: () => child.stdin.write("focus-a\n"),
    close,
  };
}
