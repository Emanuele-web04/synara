import fs from "node:fs";
import path from "node:path";
import { accountApiIssuer, accountCredentialsPath, readAccountCredentials } from "../accountAuth";
import type { HostConnectionRegistry } from "./registry";

/** A local account change immediately invalidates every stream in the old
 * account scope, including idle HTTP transports owned by that relationship. */
export function observeControllerAccount(
  registry: HostConnectionRegistry,
  baseDir: string,
): () => void {
  let stopped = false;
  let reading = false;
  let pending = false;
  const check = async () => {
    if (reading) {
      pending = true;
      return;
    }
    reading = true;
    try {
      do {
        pending = false;
        const credentials = await readAccountCredentials(baseDir).catch(() => undefined);
        if (stopped) return;
        registry.invalidateAccount(
          credentials?.userId
            ? {
                accountAuthority: accountApiIssuer(credentials.accountUrl),
                userId: credentials.userId,
                organizationId: credentials.organizationId,
              }
            : undefined,
        );
      } while (pending);
    } finally {
      reading = false;
    }
  };
  let watcher: fs.FSWatcher | undefined;
  try {
    const file = path.basename(accountCredentialsPath(baseDir));
    watcher = fs.watch(baseDir, { persistent: false }, (_event, name) => {
      if (!name || name.toString() === file) void check();
    });
    watcher.on("error", () => {
      watcher?.close();
      watcher = undefined;
    });
  } catch {
    /* Atomic writes are still observed by the bounded poll. */
  }
  const poll = setInterval(() => void check(), 5_000);
  poll.unref();
  void check();
  return () => {
    stopped = true;
    watcher?.close();
    clearInterval(poll);
  };
}
