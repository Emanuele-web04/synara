import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountApiError } from "@synara/shared/account";
import type { HostAuthorizationSnapshot } from "@synara/contracts";
import { startRemoteAuthorization } from "./authorization";

const snapshot: HostAuthorizationSnapshot = {
  ownerUserId: "owner",
  orgId: "workspace",
  ownerInOrg: true,
  discoverable: false,
  revokedDeviceJkts: [],
  pendingRevocationDeviceJkts: [],
};
afterEach(() => vi.useRealTimers());
describe("remote authorization lease", () => {
  it("admits only after durable application and closes existing streams once at expiry", async () => {
    vi.useFakeTimers();
    let now = 10_000;
    let applied!: () => void;
    const commit = new Promise<void>((resolve) => {
      applied = resolve;
    });
    const abort = new AbortController();
    const unavailable = vi.fn(async () => {});
    const poll = startRemoteAuthorization({
      refresh: async () => snapshot,
      apply: () => commit,
      unavailable,
      signal: abort.signal,
      now: () => now,
    });
    expect(poll.available()).toBe(false);
    applied();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll.available()).toBe(true);
    now += 60_001;
    expect(poll.available()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(unavailable).toHaveBeenCalledExactlyOnceWith(false);
    abort.abort();
    await poll.done;
  });
  it.each([401, 403, 404])("permanently fences a host whose proof returns %s", async (status) => {
    const unavailable = vi.fn(async () => {});
    const poll = startRemoteAuthorization({
      refresh: async () => {
        throw new AccountApiError({ status, code: "unauthorized", message: "denied" });
      },
      apply: async () => {},
      unavailable,
      signal: new AbortController().signal,
    });
    await poll.done;
    expect(poll.available()).toBe(false);
    expect(unavailable).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("does not turn an API outage or failed tombstone write into permanent revocation or fresh admission", async () => {
    const abort = new AbortController();
    const unavailable = vi.fn(async () => {});
    const apply = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const poll = startRemoteAuthorization({
      refresh: async () => snapshot,
      apply,
      unavailable,
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(poll.available()).toBe(false);
    expect(unavailable).not.toHaveBeenCalled();
    abort.abort();
    await poll.done;
  });
  it("owner removal invalidates the scope after selective revocations are applied", async () => {
    const calls: string[] = [];
    const poll = startRemoteAuthorization({
      refresh: async () => ({ ...snapshot, ownerInOrg: false }),
      apply: async () => {
        calls.push("apply");
      },
      unavailable: async () => {
        calls.push("deny");
      },
      signal: new AbortController().signal,
    });
    await poll.done;
    expect(calls).toEqual(["apply", "deny"]);
    expect(poll.available()).toBe(false);
  });
});
