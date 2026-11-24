/**
 * Per-key promise mutex for OAuth token refresh attempts within a process, so
 * concurrent usage fetches cannot redeem the same single-use refresh token twice.
 * Evicts settled entries once no newer work is queued behind them.
 */
export interface RefreshLock {
  <T>(key: string, fn: () => Promise<T>): Promise<T>;
  readonly activeCount: () => number;
}

export function createRefreshLock(): RefreshLock {
  const locks = new Map<string, Promise<unknown>>();
  const withRefreshLock = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, settled);
    void settled.finally(() => {
      if (locks.get(key) === settled) {
        locks.delete(key);
      }
    });
    return run;
  };
  return Object.assign(withRefreshLock, {
    activeCount: () => locks.size,
  });
}
