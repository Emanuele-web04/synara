import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withProvisioningFileLock } from "./fileLock";

it("serializes installers and reaps a cancelled competing waiter without entering its action", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synara-lock-test-"));
  const path = join(directory, "install.lock");
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withProvisioningFileLock(path, async () => {
    entered();
    await held;
  });
  try {
    await ready;
    const abort = new AbortController();
    let ran = false;
    const cancelled = withProvisioningFileLock(
      path,
      async () => {
        ran = true;
      },
      abort.signal,
    );
    const rejected = expect(cancelled).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    abort.abort();
    await rejected;
    expect(ran).toBe(false);
    let nextRan = false;
    const next = withProvisioningFileLock(path, async () => {
      nextRan = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(nextRan).toBe(false);
    release();
    await first;
    await next;
    expect(nextRan).toBe(true);
  } finally {
    release();
    await first;
    await rm(directory, { recursive: true, force: true });
  }
});
