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
  const lifetime = new AbortController();
  const leaseSignal = options.signal
    ? AbortSignal.any([options.signal, lifetime.signal])
    : lifetime.signal;
  let networkGuardLease:
    | { proxyUrl: string; lease: Awaited<ReturnType<typeof networkGuard.attach>> }
    | undefined;
  let revoked = false;
  let connecting = Promise.resolve();
  let changingProxy = Promise.resolve();

  const assertAvailable = () => {
    if (revoked || options.signal?.aborted) throw new Error("Browser control was interrupted.");
    if (contents.isDestroyed()) throw new Error("Browser target is unavailable.");
  };
  const changeProxy = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = changingProxy.then(operation);
    changingProxy = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const releaseProxy = async () => {
    await networkGuardLease?.lease.release();
    networkGuardLease = undefined;
  };
  const closeConnection = async (connection: OpenedConnection, cancel: boolean) => {
    await connection.close(cancel);
    connections.delete(connection);
  };
  const drainConnections = async (cancel: boolean) => {
    const results = await Promise.allSettled(
      [...connections].map((connection) => closeConnection(connection, cancel)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };

  return {
    connect({ proxyUrl }) {
      // Serializing connects prevents parallel opens from overwriting lease
      // ownership. Revocation uses the separate proxy queue so a stalled CDP
      // open cannot prevent teardown.
      const result = connecting.then(async () => {
        if (!proxyUrl) throw new Error("Browser network guard is unavailable.");
        assertAvailable();
        let opening: Promise<OpenedConnection> | undefined;
        try {
          await changeProxy(async () => {
            assertAvailable();
            if (networkGuardLease?.lease.closed) {
              await drainConnections(false);
              await releaseProxy();
            } else if (networkGuardLease && networkGuardLease.proxyUrl !== proxyUrl) {
              await drainConnections(false);
              assertAvailable();
              // Rotation belongs to the same run. Keep its session turn so a
              // queued sibling cannot take over between worker generations.
              await networkGuardLease.lease.replace(proxyUrl, leaseSignal);
              networkGuardLease.proxyUrl = proxyUrl;
            }
            assertAvailable();
            if (!networkGuardLease) {
              networkGuardLease = {
                proxyUrl,
                lease: await networkGuard.attach(proxyUrl, leaseSignal),
              };
            }
          });
          assertAvailable();
          opening = openBetterwrightConnection(
            contents,
            undefined,
            options.uploadFiles ?? [],
            options.cookieImport ?? false,
            options.expectAgentInput,
          );
          pending.add(opening);
          const connection = await opening;
          if (connection.closed || revoked || options.signal?.aborted || contents.isDestroyed()) {
            await connection.close(true);
            throw new Error("Browser control was interrupted.");
          }
          connections.add(connection);
          return {
            provider: connection.provider,
            get closed() {
              return connection.closed;
            },
            close: () => closeConnection(connection, false),
          };
        } catch (error) {
          // Failed setup, rotation, or open must not strand the session's turn.
          await changeProxy(async () => {
            if (connections.size === 0) await releaseProxy();
          });
          assertAvailable();
          throw error;
        } finally {
          if (opening) pending.delete(opening);
        }
      });
      connecting = result.then(
        () => {},
        () => {},
      );
      return result;
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
      revoked = true;
      lifetime.abort(new Error("Browser control was interrupted."));
      // Cancel in-flight leases without waiting for them: a never-settling
      // open must not stall teardown. connect() refuses to vend once its
      // opening settles. No later connect may revive this target.
      for (const opening of pending) {
        void opening.then(
          (connection) => connection.close(true).catch(() => {}),
          () => {},
        );
      }
      const draining = drainConnections(cancel);
      void draining.catch(() => {});
      return changeProxy(async () => {
        await draining;
        await releaseProxy();
      });
    },
  };
}
