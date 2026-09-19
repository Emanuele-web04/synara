import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Test seam: fires once the lock-holding child exists, before it has the lock. */
export interface ProvisioningFileLockHooks {
  readonly onLockRequested?: () => void;
}

/**
 * Kernel-owned lock, automatically released if either process exits.
 *
 * A caller's abort while waiting rejects with the caller's own reason: the
 * flock child is killed to stop the wait, and its exit is a consequence of the
 * abort rather than a second, competing failure.
 */
export async function withProvisioningFileLock<A>(
  path: string,
  action: (signal: AbortSignal) => Promise<A>,
  signal?: AbortSignal,
  hooks: ProvisioningFileLockHooks = {},
): Promise<A> {
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  signal?.throwIfAborted();
  const controller = new AbortController();
  const child = spawn(
    "flock",
    [
      "--no-fork",
      "--exclusive",
      "--timeout",
      "900",
      path,
      process.execPath,
      "-e",
      "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));",
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  let acquired = false;
  const abort = () => {
    controller.abort(signal?.reason);
    if (!acquired) child.kill("SIGKILL");
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  child.stdin.on("error", () => undefined);
  const exited = new Promise<void>((resolve) =>
    child.once("close", () => {
      controller.abort(new Error("Provisioning lock holder exited."));
      resolve();
    }),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => hooks.onLockRequested?.());
      child.once("exit", (code) =>
        reject(
          signal?.aborted
            ? signal.reason
            : new Error(`Provisioning lock was not acquired (exit ${code}).`),
        ),
      );
      child.stdout.once("data", () => resolve());
    });
    acquired = true;
    controller.signal.throwIfAborted();
    const result = await action(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    child.stdin.end();
    if (!acquired) child.kill("SIGKILL");
    await exited;
  }
}
