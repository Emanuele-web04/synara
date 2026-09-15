import { describe, expect, it, vi } from "vitest";
import type { Session } from "electron";
import { getBetterwrightNetworkGuard } from "./betterwrightNetworkGuard";

function fixture() {
  const setProxy = vi.fn(async () => {});
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
    expect(closeAllConnections).not.toHaveBeenCalled();
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
      proxyRules: "socks5://127.0.0.1:4322",
      proxyBypassRules: "<-loopback>",
    });
  });
});
