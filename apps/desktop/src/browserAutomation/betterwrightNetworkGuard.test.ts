// Covers session network lifetime and call-scoped FIFO ownership independently of Electron.
// Real proxy policy, sockets, and worker teardown are covered by browser-lifecycle-smoke.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "electron";
import {
  getBetterwrightNetworkGuard,
  NETWORK_GUARD_CALL_ATTEMPTS,
  NETWORK_GUARD_CALL_TIMEOUT_MS,
} from "./betterwrightNetworkGuard";

const proxy = vi.hoisted(() => ({ ensure: vi.fn(), close: vi.fn() }));
vi.mock("betterwright/guard-proxy", () => ({ createGuardProxy: () => proxy }));

// A session call that is in flight when the network service restarts.
const never = () => new Promise<void>(() => undefined);

function fixture() {
  const session = { setProxy: vi.fn(async () => {}), closeAllConnections: vi.fn(async () => {}) };
  return { session, guard: getBetterwrightNetworkGuard(session as unknown as Session) };
}

beforeEach(() => {
  vi.resetAllMocks();
  proxy.ensure.mockResolvedValue(4321);
  proxy.close.mockResolvedValue(undefined);
});

describe("BetterwrightNetworkGuard", () => {
  it("keeps guarded networking alive across sequential CDP leases", async () => {
    const { session, guard } = fixture();
    await guard.initialize();
    for (let i = 0; i < 6; i++) await (await guard.attach()).release();
    expect(session.setProxy).toHaveBeenCalledExactlyOnceWith({
      mode: "fixed_servers",
      proxyRules: "socks5://127.0.0.1:4321",
      proxyBypassRules: "<-loopback>",
    });
    expect(session.closeAllConnections).toHaveBeenCalledOnce();
    expect(proxy.close).not.toHaveBeenCalled();
    await guard.dispose();
    expect(proxy.close).toHaveBeenCalledOnce();
    await expect(guard.attach()).rejects.toThrow("closed");
  });

  it("queues concurrent leases and cancels a waiter without releasing its predecessor", async () => {
    const { guard } = fixture();
    const first = await guard.attach();
    const controller = new AbortController();
    const cancelled = guard.attach(controller.signal);
    const rejection = expect(cancelled).rejects.toThrow("cancel queued");
    let connected = false;
    const next = guard.attach().then((lease) => {
      connected = true;
      return lease;
    });
    controller.abort(new Error("cancel queued"));
    await rejection;
    expect(first.closed).toBe(false);
    expect(connected).toBe(false);
    await first.release();
    await (await next).release();
    expect(connected).toBe(true);
  });

  it("does not let stale releases surrender a later lease", async () => {
    const { guard } = fixture();
    const first = await guard.attach();
    await first.release();
    const second = await guard.attach();
    await first.release();
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    await second.release();
  });

  describe("when the network service restarts during setup", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("issues a dropped connection drain again instead of hanging startup", async () => {
      const { session, guard } = fixture();
      // The first drain is in flight when the service restarts: it never settles.
      session.closeAllConnections.mockImplementationOnce(never);
      let ready = false;
      const initialized = guard.initialize().then(() => {
        ready = true;
      });
      await vi.advanceTimersByTimeAsync(NETWORK_GUARD_CALL_TIMEOUT_MS - 1);
      expect(ready).toBe(false);
      expect(session.closeAllConnections).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await initialized;
      expect(session.closeAllConnections).toHaveBeenCalledTimes(2);
      expect(session.setProxy).toHaveBeenCalledOnce();
      expect(console.warn).toHaveBeenCalledOnce();
    });

    it("issues a dropped proxy install again and drains only after it is answered", async () => {
      const { session, guard } = fixture();
      session.setProxy.mockImplementationOnce(never);
      const initialized = guard.initialize();
      await vi.advanceTimersByTimeAsync(NETWORK_GUARD_CALL_TIMEOUT_MS - 1);
      // Pages must not be admitted, and nothing drained, before the proxy is in.
      expect(session.closeAllConnections).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await initialized;
      expect(session.setProxy).toHaveBeenCalledTimes(2);
      expect(session.setProxy.mock.calls[1]).toEqual(session.setProxy.mock.calls[0]);
      expect(session.closeAllConnections).toHaveBeenCalledOnce();
    });

    it("fails setup, and every later lease, when the session never answers", async () => {
      const { session, guard } = fixture();
      session.closeAllConnections.mockImplementation(never);
      const failure = expect(guard.initialize()).rejects.toThrow(
        "could not close existing connections: the browser session never answered",
      );
      await vi.advanceTimersByTimeAsync(
        NETWORK_GUARD_CALL_TIMEOUT_MS * NETWORK_GUARD_CALL_ATTEMPTS,
      );
      await failure;
      expect(session.closeAllConnections).toHaveBeenCalledTimes(NETWORK_GUARD_CALL_ATTEMPTS);
      // Fail closed: no later run is admitted on an unguarded session.
      await expect(guard.attach()).rejects.toThrow("never answered");
      expect(session.closeAllConnections).toHaveBeenCalledTimes(NETWORK_GUARD_CALL_ATTEMPTS);
    });

    it("does not issue a call again once the session rejected it", async () => {
      const { session, guard } = fixture();
      session.setProxy.mockRejectedValueOnce(new Error("proxy rejected"));
      await expect(guard.initialize()).rejects.toThrow("proxy rejected");
      await vi.advanceTimersByTimeAsync(
        NETWORK_GUARD_CALL_TIMEOUT_MS * NETWORK_GUARD_CALL_ATTEMPTS,
      );
      expect(session.setProxy).toHaveBeenCalledOnce();
      expect(session.closeAllConnections).not.toHaveBeenCalled();
    });

    it("leaves no timer behind after a normal setup", async () => {
      const { guard } = fixture();
      await guard.initialize();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("fails closed after setup failure without admitting another run", async () => {
    const { session, guard } = fixture();
    session.closeAllConnections.mockRejectedValueOnce(new Error("drain failed"));
    await expect(guard.attach()).rejects.toThrow("drain failed");
    await expect(guard.attach()).rejects.toThrow("drain failed");
    expect(session.setProxy).toHaveBeenCalledOnce();
    await guard.dispose();
    expect(proxy.close).toHaveBeenCalledOnce();
  });

  it("refuses a lease if shutdown wins pending setup", async () => {
    const { guard } = fixture();
    let opened!: (port: number) => void;
    const opening = new Promise<number>((resolve) => {
      opened = resolve;
    });
    proxy.ensure.mockReturnValueOnce(opening);
    const attaching = guard.attach();
    const rejected = expect(attaching).rejects.toThrow("closed");
    await vi.waitFor(() => expect(proxy.ensure).toHaveBeenCalledOnce());
    const closing = guard.dispose();
    opened(4321);
    await rejected;
    await closing;
    expect(proxy.close).toHaveBeenCalledOnce();
  });
});
