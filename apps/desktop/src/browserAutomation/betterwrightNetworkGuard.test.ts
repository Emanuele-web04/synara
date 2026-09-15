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

  it("rejects concurrent leases for the same shared session", async () => {
    const { browserSession } = fixture();
    const guard = getBetterwrightNetworkGuard(browserSession);
    const first = await guard.attach("socks5://127.0.0.1:4321");
    await expect(guard.attach("socks5://127.0.0.1:4322")).rejects.toThrow("already leased");
    await first.release();
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
    await expect(guard.attach("socks5://127.0.0.1:4322")).rejects.toThrow("already leased");
    gate.resolve();
    await Promise.all([first, second]);
    const next = await guard.attach("socks5://127.0.0.1:4321");
    const calls = setProxy.mock.calls.length;
    await lease.release();
    expect(setProxy).toHaveBeenCalledTimes(calls);
    await expect(guard.attach("socks5://127.0.0.1:4322")).rejects.toThrow("already leased");
    await next.release();
  });
});
