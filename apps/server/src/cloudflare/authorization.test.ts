import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountApiError, createAccountClient } from "@synara/shared/account";
import type { AccountErrorCode, HostAuthorizationSnapshot } from "@synara/contracts";
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
  it.each<[number, AccountErrorCode, string]>([
    [401, "unauthorized", "denied"],
    [403, "unauthorized", "denied"],
    [403, "not_host_owner", "Only the host owner may do that"],
    [404, "host_not_found", "denied"],
  ])("permanently fences a host whose proof returns %s %s", async (status, code, message) => {
    const unavailable = vi.fn(async () => {});
    const poll = startRemoteAuthorization({
      refresh: async () => {
        throw new AccountApiError({ status, code, message });
      },
      apply: async () => {},
      unavailable,
      signal: new AbortController().signal,
    });
    await poll.done;
    expect(poll.available()).toBe(false);
    expect(unavailable).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("recovers from enrollment refusal without revoking approved devices or retaining admission", async () => {
    let enrolled = false;
    const client = createAccountClient({
      baseUrl: "https://account.example.test",
      fetch: (async () =>
        Response.json(
          enrolled
            ? snapshot
            : {
                error: "not_host_owner",
                message: "Remote test access is not enabled for this account",
              },
          { status: enrolled ? 200 : 403 },
        )) as unknown as typeof fetch,
    });
    const abort = new AbortController();
    const unavailable = vi.fn(async () => {});
    const apply = vi.fn(async () => {});
    const poll = startRemoteAuthorization({
      refresh: () => client.getHostAuthorization("fixture-host-proof", "fixture-host"),
      apply,
      unavailable,
      signal: abort.signal,
    });
    try {
      await vi.waitFor(() => expect(unavailable).toHaveBeenCalledExactlyOnceWith(false));
      expect(poll.available()).toBe(false);

      enrolled = true;
      await vi.waitFor(() => expect(poll.available()).toBe(true), { timeout: 15_000 });
      expect(apply).toHaveBeenCalledExactlyOnceWith(snapshot);

      enrolled = false;
      await vi.waitFor(() => expect(unavailable).toHaveBeenCalledTimes(2), { timeout: 15_000 });
      expect(poll.available()).toBe(false);
      expect(unavailable.mock.calls).toEqual([[false], [false]]);

      enrolled = true;
      await vi.waitFor(() => expect(poll.available()).toBe(true), { timeout: 15_000 });
      expect(apply).toHaveBeenCalledTimes(2);
    } finally {
      abort.abort();
      await poll.done;
    }
  }, 45_000);
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
