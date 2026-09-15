import type { WebContents } from "electron";
import type { BetterWrightOptions } from "betterwright";
import { openBetterwrightConnection } from "./betterwrightConnection";
import { getBetterwrightNetworkGuard } from "./betterwrightNetworkGuard";
import type { BrowserAutomationVisibleRuntime } from "../browserManager";

type HostTarget = NonNullable<BetterWrightOptions["hostTarget"]>;

type OpenedConnection = Awaited<ReturnType<typeof openBetterwrightConnection>>;

export interface SynaraHostTarget extends HostTarget {
  run: NonNullable<HostTarget["run"]>;
  /** Immediately revoke every transport this adapter vended; callers race worker shutdown. */
  revokeAll(cancel?: boolean): Promise<void>;
}

/**
 * Synara's HostTarget adapter. Browser tabs share a persistent Electron
 * session, so the guard proxy is installed on the session for the duration of
 * each lease. This covers navigations, subresources, WebSockets, and workers;
 * the proxy resolves and dials the validated address itself.
 */
export function synaraHostTarget(
  contents: WebContents,
  options: {
    uploadFiles?: readonly string[] | undefined;
    cookieImport?: boolean | undefined;
    expectAgentInput?: BrowserAutomationVisibleRuntime["expectAgentInput"] | undefined;
    signal?: AbortSignal | undefined;
  } = {},
): SynaraHostTarget {
  const connections = new Set<OpenedConnection>();
  const pending = new Set<Promise<OpenedConnection>>();
  const networkGuard = getBetterwrightNetworkGuard(contents.session);
  let networkGuardLease: Awaited<ReturnType<typeof networkGuard.attach>> | undefined;
  // Bumped synchronously by every revokeAll: lets a connect() that resolves
  // after a revoke refuse to vend its lease deterministically.
  let generation = 0;
  return {
    async connect({ proxyUrl }) {
      if (!proxyUrl) throw new Error("Browser network guard is unavailable.");
      if (options.signal?.aborted) throw new Error("Browser control was interrupted.");
      if (contents.isDestroyed()) throw new Error("Browser target is unavailable.");
      const seen = generation;
      networkGuardLease ??= await networkGuard.attach(proxyUrl);
      if (seen !== generation) {
        await networkGuardLease.release();
        networkGuardLease = undefined;
        throw new Error("Browser control was interrupted.");
      }
      const opening = openBetterwrightConnection(
        contents,
        undefined,
        options.uploadFiles ?? [],
        options.cookieImport ?? false,
        options.expectAgentInput,
      );
      pending.add(opening);
      try {
        const connection = await opening;
        // A revokeAll that raced this lease already cancelled the transport;
        // never vend a dead lease — the client replaces closed workers.
        if (connection.closed || seen !== generation) {
          await connection.close(true).catch(() => {});
          throw new Error("Browser control was interrupted.");
        }
        connections.add(connection);
        return {
          provider: connection.provider,
          get closed() {
            return connection.closed;
          },
          // Graceful drain: the worker behind a rotated lease may still be
          // finishing a successful op. Abort paths cancel via revokeAll(true).
          close: async () => {
            connections.delete(connection);
            await connection.close(false);
          },
        };
      } finally {
        pending.delete(opening);
      }
    },
    async run(operation) {
      if (contents.isDestroyed()) throw new Error("Browser target is unavailable.");
      const throttled = contents.getBackgroundThrottling();
      contents.setBackgroundThrottling(false);
      try {
        return await operation(options.signal);
      } finally {
        if (!contents.isDestroyed()) contents.setBackgroundThrottling(throttled);
      }
    },
    revokeAll(cancel = true) {
      generation += 1;
      // Cancel in-flight leases without waiting for them: a never-settling
      // open must not stall teardown. connect() refuses to vend once its
      // opening settles (see generation check above).
      for (const opening of pending) {
        void opening.then(
          (connection) => connection.close(true).catch(() => {}),
          () => {},
        );
      }
      return Promise.all([...connections].map((connection) => connection.close(cancel))).then(
        async () => {
          await networkGuardLease?.release();
          networkGuardLease = undefined;
        },
      );
    },
  };
}
