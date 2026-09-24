import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withProvisioningFileLock } from "./fileLock";

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

it("serializes installers and reaps a cancelled competing waiter without entering its action", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synara-lock-test-"));
  const path = join(directory, "install.lock");
  const entered = gate();
  const held = gate();
  const first = withProvisioningFileLock(path, async () => {
    entered.open();
    await held.wait;
  });
  try {
    await entered.wait;
    const abort = new AbortController();
    const reason = new Error("the user cancelled setup");
    let ran = false;
    const requested = gate();
    const cancelled = withProvisioningFileLock(
      path,
      async () => {
        ran = true;
      },
      abort.signal,
      { onLockRequested: requested.open },
    );
    // The waiter exists and is blocked on the lock the first holder owns.
    await requested.wait;
    abort.abort(reason);
    // The caller's reason, not the flock child's exit code: the child dying is
    // a consequence of the abort, and reporting it instead hid the cause.
    await expect(cancelled).rejects.toBe(reason);
    expect(ran).toBe(false);

    let nextRan = false;
    const nextRequested = gate();
    const next = withProvisioningFileLock(
      path,
      async () => {
        nextRan = true;
      },
      undefined,
      { onLockRequested: nextRequested.open },
    );
    await nextRequested.wait;
    // Deterministic: the kernel lock is still owned by the first holder, whose
    // action has not been released, so the second action cannot have started.
    expect(nextRan).toBe(false);
    held.open();
    await first;
    await next;
    expect(nextRan).toBe(true);
  } finally {
    held.open();
    await first;
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects an already-aborted request with its own reason and touches nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synara-lock-test-"));
  try {
    const abort = new AbortController();
    const reason = new Error("gone before it started");
    abort.abort(reason);
    let ran = false;
    await expect(
      withProvisioningFileLock(
        join(directory, "install.lock"),
        async () => {
          ran = true;
        },
        abort.signal,
      ),
    ).rejects.toBe(reason);
    expect(ran).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("hands the action a signal that fires with the caller's reason mid-action", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synara-lock-test-"));
  try {
    const abort = new AbortController();
    const reason = new Error("cancelled while installing");
    const started = gate();
    const result = withProvisioningFileLock(
      join(directory, "install.lock"),
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          started.open();
        }),
      abort.signal,
    );
    await started.wait;
    abort.abort(reason);
    await expect(result).rejects.toBe(reason);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
