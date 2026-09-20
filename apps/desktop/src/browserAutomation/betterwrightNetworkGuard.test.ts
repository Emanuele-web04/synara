import { describe, expect, it, vi } from "vitest";
import type { ProxyConfig, Session } from "electron";
import { getBetterwrightNetworkGuard } from "./betterwrightNetworkGuard";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const setProxy = vi.fn(async (_config: ProxyConfig) => {});
  const closeAllConnections = vi.fn(async () => {});
  const browserSession = {
    setProxy,
    closeAllConnections,
  } as unknown as Session;
  return { browserSession, setProxy, closeAllConnections };
}

describe("BetterwrightNetworkGuard", () => {
  it("routes the whole session through BetterWright's guard proxy", async () => {
    const { browserSession, setProxy, closeAllConnections } = fixture();
    const lease =
      await getBetterwrightNetworkGuard(browserSession).attach("socks5://127.0.0.1:4321");
    expect(setProxy).toHaveBeenCalledWith({
      mode: "fixed_servers",
      proxyRules: "socks5://127.0.0.1:4321",
      proxyBypassRules: "<-loopback>",
    });
    expect(closeAllConnections).toHaveBeenCalledOnce();
    await lease.release();
    expect(setProxy).toHaveBeenLastCalledWith({ mode: "system" });
    expect(closeAllConnections).toHaveBeenCalledTimes(2);
  });

  it("does not expose the session until proxy setup succeeds", async () => {
    const { browserSession, setProxy, closeAllConnections } = fixture();
    vi.mocked(setProxy).mockRejectedValueOnce(new Error("proxy setup failed"));
    await expect(
      getBetterwrightNetworkGuard(browserSession).attach("socks5://127.0.0.1:4321"),
    ).rejects.toThrow("proxy setup failed");
    expect(setProxy).toHaveBeenLastCalledWith({ mode: "system" });
    expect(closeAllConnections).toHaveBeenCalledOnce();
  });

  it("queues concurrent leases for the same shared session in order", async () => {
    const { browserSession, setProxy } = fixture();
    const guard = getBetterwrightNetworkGuard(browserSession);
    const first = await guard.attach("socks5://127.0.0.1:4321");
    const order: string[] = [];
    const second = guard.attach("socks5://127.0.0.1:4322").then((lease) => {
      order.push("second");
      return lease;
    });
    const third = guard.attach("socks5://127.0.0.1:4323").then((lease) => {
      order.push("third");
      return lease;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual([]);
    expect(setProxy).toHaveBeenCalledOnce();
    await first.release();
    const secondLease = await second;
    expect(order).toEqual(["second"]);
    await secondLease.release();
    await (await third).release();
    expect(order).toEqual(["second", "third"]);
  });

  it("can be reused after the first lease is released", async () => {
    const { browserSession, setProxy } = fixture();
    const guard = getBetterwrightNetworkGuard(browserSession);
    const first = await guard.attach("socks5://127.0.0.1:4321");
    await first.release();
    await guard.attach("socks5://127.0.0.1:4322");
    expect(setProxy).toHaveBeenLastCalledWith({
      mode: "fixed_servers",
      proxyRules: "socks5://127.0.0.1:4322",
      proxyBypassRules: "<-loopback>",
    });
  });

  it("rolls back and drains when setup fails after changing the proxy", async () => {
    const { browserSession, setProxy, closeAllConnections } = fixture();
    closeAllConnections.mockRejectedValueOnce(new Error("drain failed"));
    const guard = getBetterwrightNetworkGuard(browserSession);
    await expect(guard.attach("socks5://127.0.0.1:4321")).rejects.toThrow("drain failed");
    expect(setProxy).toHaveBeenLastCalledWith({ mode: "system" });
    expect(closeAllConnections).toHaveBeenCalledTimes(2);
    const next = await guard.attach("socks5://127.0.0.1:4322");
    await next.release();
  });

  it("reserves ownership until a failed rollback can be recovered", async () => {
    const { browserSession, setProxy, closeAllConnections } = fixture();
    closeAllConnections.mockRejectedValue(new Error("drain failed"));
    const guard = getBetterwrightNetworkGuard(browserSession);
    await expect(guard.attach("socks5://127.0.0.1:4321")).rejects.toThrow("recovery failed");
    await expect(guard.attach("socks5://127.0.0.1:4322")).rejects.toThrow("drain failed");
    expect(setProxy.mock.calls.filter(([config]) => config.mode === "fixed_servers")).toHaveLength(
      1,
    );
    closeAllConnections.mockResolvedValue(undefined);
    const next = await guard.attach("socks5://127.0.0.1:4322");
    await next.release();
  });

  it.each(["proxy", "drain"])("allows retry after failed %s restoration", async (failure) => {
    const { browserSession, setProxy, closeAllConnections } = fixture();
    const guard = getBetterwrightNetworkGuard(browserSession);
    const lease = await guard.attach("socks5://127.0.0.1:4321");
    (failure === "proxy" ? setProxy : closeAllConnections).mockRejectedValueOnce(
      new Error("restore failed"),
    );
    await expect(lease.release()).rejects.toThrow("restore failed");
    await lease.release();
    const next = await guard.attach("socks5://127.0.0.1:4322");
    await next.release();
  });

  it("all release callers await restoration and stale releases cannot affect a new owner", async () => {
    const { browserSession, setProxy, closeAllConnections } = fixture();
    const guard = getBetterwrightNetworkGuard(browserSession);
    const lease = await guard.attach("socks5://127.0.0.1:4321");
    const gate = deferred<void>();
    closeAllConnections.mockReturnValueOnce(gate.promise);
    const first = lease.release();
    const second = lease.release();
    expect(second).toBe(first);
    const queued = guard.attach("socks5://127.0.0.1:4321");
    gate.resolve();
    await Promise.all([first, second]);
    const next = await queued;
    const calls = setProxy.mock.calls.length;
    await lease.release();
    expect(setProxy).toHaveBeenCalledTimes(calls);
    expect(next.closed).toBe(false);
    await next.release();
  });

  it("cancels a queued lease without releasing the current owner or blocking later waiters", async () => {
    const { browserSession, setProxy } = fixture();
    const guard = getBetterwrightNetworkGuard(browserSession);
    const first = await guard.attach("socks5://127.0.0.1:4321");
    const controller = new AbortController();
    const cancelled = guard.attach("socks5://127.0.0.1:4322", controller.signal);
    const rejected = expect(cancelled).rejects.toThrow("cancel queued");
    const last = guard.attach("socks5://127.0.0.1:4323");
    controller.abort(new Error("cancel queued"));
    await rejected;
    expect(first.closed).toBe(false);
    expect(setProxy).toHaveBeenCalledOnce();
    await first.release();
    await (await last).release();
    expect(setProxy.mock.calls.some(([config]) => config.proxyRules?.endsWith(":4322"))).toBe(
      false,
    );
  });

  it("recovers failed restoration before handing the session to a queued run", async () => {
    const { browserSession, setProxy } = fixture();
    const guard = getBetterwrightNetworkGuard(browserSession);
    const first = await guard.attach("socks5://127.0.0.1:4321");
    const queued = guard.attach("socks5://127.0.0.1:4322");
    setProxy.mockRejectedValueOnce(new Error("restore failed"));
    await expect(first.release()).rejects.toThrow("restore failed");
    const next = await queued;
    expect(first.closed).toBe(true);
    expect(next.closed).toBe(false);
    expect(setProxy).toHaveBeenNthCalledWith(3, { mode: "system" });
    await next.release();
  });

  it("drains replacement before releasing its turn and refuses stale replacements", async () => {
    const { browserSession, setProxy, closeAllConnections } = fixture();
    const guard = getBetterwrightNetworkGuard(browserSession);
    const first = await guard.attach("socks5://127.0.0.1:4321");
    const gate = deferred<void>();
    closeAllConnections.mockReturnValueOnce(gate.promise);
    const replacing = first.replace("socks5://127.0.0.1:4322");
    await vi.waitFor(() => expect(setProxy).toHaveBeenCalledTimes(2));
    const releasing = first.release();
    expect(first.closed).toBe(true);
    const queued = guard.attach("socks5://127.0.0.1:4323");
    await expect(first.replace("socks5://127.0.0.1:4324")).rejects.toThrow("closed");
    expect(setProxy).toHaveBeenCalledTimes(2);
    gate.resolve();
    await replacing;
    await releasing;
    const next = await queued;
    expect(setProxy).toHaveBeenNthCalledWith(3, { mode: "system" });
    await expect(first.replace("socks5://127.0.0.1:4324")).rejects.toThrow("closed");
    expect(next.closed).toBe(false);
    await next.release();
  });
});
