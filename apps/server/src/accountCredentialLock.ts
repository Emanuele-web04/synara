/** Credential refresh uses the same dead-owner/reaper protocol as database recovery. */
import fs from "node:fs/promises";
import { Effect } from "effect";
import {
  acquireDatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
  DatabaseLifecycleLockedError,
  type DatabaseLifecycleLock,
} from "./persistence/DatabaseLifecycleLock.ts";

const chains = new Map<string, Promise<unknown>>();
const ACQUIRE_TIMEOUT_MS = 180_000;

async function acquire(credentialsPath: string): Promise<DatabaseLifecycleLock> {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    // The old time-based protocol cannot prove abandonment. Never delete its
    // lock: an older binary may still be rotating a single-use refresh token.
    try {
      await fs.lstat(`${credentialsPath}.lock`);
      throw new Error(
        "Legacy credential lock present. Stop older Synara processes and recover the credential lock before retrying.",
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    const result = await Effect.runPromise(
      Effect.result(acquireDatabaseLifecycleLock(credentialsPath)),
    );
    if (result._tag === "Success") return result.success;
    if (!(result.failure instanceof DatabaseLifecycleLockedError) || Date.now() >= deadline)
      throw result.failure;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

export async function withCredentialFileLock<A>(
  credentialsPath: string,
  fn: () => Promise<A>,
): Promise<A> {
  const previous = chains.get(credentialsPath) ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(async () => {
      const lock = await acquire(credentialsPath);
      try {
        return await fn();
      } finally {
        await Effect.runPromise(releaseDatabaseLifecycleLock(lock));
      }
    });
  chains.set(credentialsPath, run);
  void run
    .catch(() => {})
    .then(() => {
      if (chains.get(credentialsPath) === run) chains.delete(credentialsPath);
    });
  return run;
}
