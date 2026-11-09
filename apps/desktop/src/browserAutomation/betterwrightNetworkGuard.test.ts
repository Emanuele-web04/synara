// Covers session network lifetime and call-scoped FIFO ownership independently of Electron.
// Real proxy policy, sockets, and worker teardown are covered by browser-lifecycle-smoke.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "electron";
import { getBetterwrightNetworkGuard } from "./betterwrightNetworkGuard";

const proxy = vi.hoisted(() => ({ ensure: vi.fn(), close: vi.fn() }));
vi.mock("betterwright/guard-proxy", () => ({ createGuardProxy: () => proxy }));

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
