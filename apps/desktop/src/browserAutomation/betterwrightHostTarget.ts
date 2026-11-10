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
 * session, whose persistent guard covers navigations, subresources, WebSockets,
 * and workers. Worker rotation revokes control without closing page requests.
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
  let networkGuardLease: Awaited<ReturnType<typeof networkGuard.attach>> | undefined;
  let workerProxyUrl: string | undefined;
  let revoked = false;
  let connecting = Promise.resolve();
  let changingLease = Promise.resolve();

  const assertAvailable = () => {
    if (revoked || options.signal?.aborted) throw new Error("Browser control was interrupted.");
    if (contents.isDestroyed() || networkGuardLease?.closed)
      throw new Error("Browser target is unavailable.");
  };
  const changeLease = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = changingLease.then(operation);
    changingLease = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const releaseLease = async () => {
    await networkGuardLease?.release();
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
      // ownership. Revocation uses the separate lease queue so a stalled CDP
      // open cannot prevent teardown.
      const result = connecting.then(async () => {
        if (!proxyUrl) throw new Error("Browser network guard is unavailable.");
        assertAvailable();
        let opening: Promise<OpenedConnection> | undefined;
        try {
          await changeLease(async () => {
            assertAvailable();
            if (workerProxyUrl && workerProxyUrl !== proxyUrl) await drainConnections(false);
            workerProxyUrl = proxyUrl;
            if (!networkGuardLease) {
              networkGuardLease = await networkGuard.attach(leaseSignal);
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
          // Failed setup or open must not strand the session's turn.
          await changeLease(async () => {
            if (connections.size === 0) await releaseLease();
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
      return changeLease(async () => {
        await draining;
        await releaseLease();
      });
    },
  };
}
