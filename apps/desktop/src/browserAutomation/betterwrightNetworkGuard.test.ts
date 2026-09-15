import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkPolicy } from "betterwright";
import type { Session, WebContents } from "electron";
import { getBetterwrightNetworkGuard } from "./betterwrightNetworkGuard";

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));

function fixture(policy: NetworkPolicy) {
  const onBeforeRequest = vi.fn();
  const browserSession = {
    webRequest: { onBeforeRequest },
  } as unknown as Session;
  const contents = { id: 7 } as unknown as WebContents;
  const lease = getBetterwrightNetworkGuard(browserSession).attach(contents, policy);
  const listener = onBeforeRequest.mock.calls[0]![1] as (
    details: { webContentsId: number; url: string },
    callback: (response: { cancel?: boolean }) => void,
  ) => void;
  return { listener, lease };
}

function listenerFor(onBeforeRequest: ReturnType<typeof vi.fn>) {
  return onBeforeRequest.mock.calls[0]![1] as (
    details: { webContentsId?: number; url: string },
    callback: (response: { cancel?: boolean }) => void,
  ) => void;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BetterwrightNetworkGuard", () => {
  it("blocks metadata destinations before DNS resolution", async () => {
    const { listener, lease } = fixture(
      new (class {
        check(url: string) {
          return url.includes("169.254.169.254")
            ? { allowed: false, reason: "metadata" }
            : { allowed: true };
        }
        checkHost() {
          return { allowed: true };
        }
      })() as unknown as NetworkPolicy,
    );
    const callback = vi.fn();
    listener({ webContentsId: 7, url: "http://169.254.169.254/latest" }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ cancel: true }));
    expect(mocks.lookup).not.toHaveBeenCalled();
    lease.release();
  });

  it("blocks a hostname that resolves to a denied address", async () => {
    mocks.lookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const policy = {
      check: () => ({ allowed: true }),
      checkHost: () => ({ allowed: false, reason: "metadata" }),
    } as unknown as NetworkPolicy;
    const { listener, lease } = fixture(policy);
    const callback = vi.fn();
    listener({ webContentsId: 7, url: "https://public.example.test" }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ cancel: true }));
    lease.release();
  });

  it("allows a request when the URL and every resolved address pass", async () => {
    mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const policy = {
      check: () => ({ allowed: true }),
      checkHost: () => ({ allowed: true }),
    } as unknown as NetworkPolicy;
    const { listener, lease } = fixture(policy);
    const callback = vi.fn();
    listener({ webContentsId: 7, url: "https://example.test" }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ cancel: false }));
    lease.release();
  });

  it("does not restrict unrelated WebContents", async () => {
    const { listener, lease } = fixture({
      check: () => ({ allowed: false, reason: "blocked" }),
      checkHost: () => ({ allowed: false, reason: "blocked" }),
    } as unknown as NetworkPolicy);
    const callback = vi.fn();
    listener({ webContentsId: 8, url: "http://169.254.169.254/latest" }, callback);
    expect(callback).toHaveBeenCalledWith({});
    expect(mocks.lookup).not.toHaveBeenCalled();
    lease.release();
  });

  it("fails closed when hostname resolution fails", async () => {
    mocks.lookup.mockRejectedValue(new Error("resolver unavailable"));
    const { listener, lease } = fixture({
      check: () => ({ allowed: true }),
      checkHost: () => ({ allowed: true }),
    } as unknown as NetworkPolicy);
    const callback = vi.fn();
    listener({ webContentsId: 7, url: "https://example.test" }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ cancel: true }));
    lease.release();
  });

  it("allows schemes without a host after URL policy validation", async () => {
    const policy = {
      check: () => ({ allowed: true }),
      checkHost: () => ({ allowed: false, reason: "blocked" }),
    } as unknown as NetworkPolicy;
    const { listener, lease } = fixture(policy);
    const callback = vi.fn();
    listener({ webContentsId: 7, url: "data:text/plain,ok" }, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ cancel: false }));
    expect(mocks.lookup).not.toHaveBeenCalled();
    lease.release();
  });

  it("uses one listener per session and removes released policies", async () => {
    const onBeforeRequest = vi.fn();
    const browserSession = { webRequest: { onBeforeRequest } } as unknown as Session;
    const first = { id: 11 } as unknown as WebContents;
    const second = { id: 12 } as unknown as WebContents;
    const guard = getBetterwrightNetworkGuard(browserSession);
    const firstLease = guard.attach(first, {
      check: () => ({ allowed: false, reason: "first" }),
      checkHost: () => ({ allowed: true }),
    } as unknown as NetworkPolicy);
    const secondLease = guard.attach(second, {
      check: () => ({ allowed: true }),
      checkHost: () => ({ allowed: true }),
    } as unknown as NetworkPolicy);
    expect(onBeforeRequest).toHaveBeenCalledTimes(1);
    const listener = listenerFor(onBeforeRequest);
    const firstCallback = vi.fn();
    listener({ webContentsId: 11, url: "https://first.test" }, firstCallback);
    await vi.waitFor(() => expect(firstCallback).toHaveBeenCalledWith({ cancel: true }));
    const secondCallback = vi.fn();
    listener({ webContentsId: 12, url: "data:text/plain,ok" }, secondCallback);
    await vi.waitFor(() => expect(secondCallback).toHaveBeenCalledWith({ cancel: false }));
    firstLease.release();
    const releasedCallback = vi.fn();
    listener({ webContentsId: 11, url: "https://first.test" }, releasedCallback);
    expect(releasedCallback).toHaveBeenCalledWith({});
    secondLease.release();
  });
});
