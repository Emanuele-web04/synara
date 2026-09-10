import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Kernel-owned lock, automatically released if either process exits. */
export async function withProvisioningFileLock<A>(
  path: string,
  action: (signal: AbortSignal) => Promise<A>,
  signal?: AbortSignal,
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
      child.once("exit", (code) =>
        reject(new Error(`Provisioning lock was not acquired (exit ${code}).`)),
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
