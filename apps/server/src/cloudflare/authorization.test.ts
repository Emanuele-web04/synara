import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountApiError, createAccountClient } from "@synara/shared/account";
import type { AccountErrorCode, HostAuthorizationSnapshot } from "@synara/contracts";
import { REMOTE_PERMANENT_DENIAL_MS, startRemoteAuthorization } from "./authorization";

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
    [401, "bad_proof", "Host proof is invalid"],
    [401, "unauthorized", "Host proof required"],
    [403, "unauthorized", "denied"],
    [404, "internal_error", "Request failed with status 404"],
    [502, "internal_error", "Identity provider is unavailable"],
  ])("keeps device trust when a check returns %s %s", async (status, code, message) => {
    let clock = 0;
    const abort = new AbortController();
    const unavailable = vi.fn(async () => {});
    const refresh = vi.fn(async (): Promise<HostAuthorizationSnapshot> => {
      clock += 60_000;
      throw new AccountApiError({ status, code, message });
    });
    const poll = startRemoteAuthorization({
      refresh,
      apply: async () => {},
      unavailable,
      signal: abort.signal,
      now: () => clock,
      pollIntervalMs: 1,
    });
    await vi.waitFor(() => expect(refresh.mock.calls.length).toBeGreaterThan(10));
    expect(poll.available()).toBe(false);
    expect(unavailable).not.toHaveBeenCalledWith(true);
    abort.abort();
    await poll.done;
  });
  it.each<[number, AccountErrorCode, string]>([
    [401, "host_not_linked", "Host is not linked"],
    [403, "not_host_owner", "Only the host owner may do that"],
    [404, "host_not_found", "Host not found"],
  ])(
    "retires trust only after %s %s persists past the confirmation window",
    async (status, code, message) => {
      let clock = 0;
      const unavailable = vi.fn(async () => {});
      const log = vi.fn();
      const poll = startRemoteAuthorization({
        refresh: async () => {
          clock += 120_000;
          throw new AccountApiError({ status, code, message });
        },
        apply: async () => {},
        unavailable,
        signal: new AbortController().signal,
        now: () => clock,
        pollIntervalMs: 1,
        log,
      });
      await poll.done;
      expect(poll.available()).toBe(false);
      expect(unavailable.mock.calls).toEqual([[false], [false], [false], [true]]);
      expect(log).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenLastCalledWith(expect.stringContaining("must pair again"));
    },
  );
  it("forgets a denial streak once the account service answers again", async () => {
    let clock = 0;
    let polls = 0;
    const abort = new AbortController();
    const unavailable = vi.fn(async () => {});
    const burst = REMOTE_PERMANENT_DENIAL_MS / 10_000 - 5;
    const poll = startRemoteAuthorization({
      refresh: async () => {
        clock += 10_000;
        polls += 1;
        const recovered = polls === burst + 1 || polls > 2 * burst + 1;
        if (recovered) return snapshot;
        throw new AccountApiError({
          status: 404,
          code: "host_not_found",
          message: "Host not found",
        });
      },
      apply: async () => {},
      unavailable,
      signal: abort.signal,
      now: () => clock,
      pollIntervalMs: 1,
    });
    await vi.waitFor(() => expect(polls).toBeGreaterThan(2 * burst + 2));
    expect(poll.available()).toBe(true);
    expect(unavailable).not.toHaveBeenCalledWith(true);
    abort.abort();
    await poll.done;
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
      pollIntervalMs: 5,
    });
    try {
      await vi.waitFor(() => expect(unavailable).toHaveBeenCalledWith(false));
      expect(poll.available()).toBe(false);

      enrolled = true;
      await vi.waitFor(() => expect(poll.available()).toBe(true));
      expect(apply).toHaveBeenCalledWith(snapshot);

      enrolled = false;
      await vi.waitFor(() => expect(poll.available()).toBe(false));

      enrolled = true;
      await vi.waitFor(() => expect(poll.available()).toBe(true));
      expect(unavailable).not.toHaveBeenCalledWith(true);
    } finally {
      abort.abort();
      await poll.done;
    }
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
  it("owner removal closes admission at once and invalidates the scope once confirmed", async () => {
    let clock = 0;
    const calls: string[] = [];
    const poll = startRemoteAuthorization({
      refresh: async () => {
        clock += 120_000;
        return { ...snapshot, ownerInOrg: false };
      },
      apply: async () => {
        calls.push("apply");
      },
      unavailable: async (permanent) => {
        calls.push(permanent ? "retire" : "close");
      },
      signal: new AbortController().signal,
      now: () => clock,
      pollIntervalMs: 1,
    });
    await poll.done;
    expect(calls).toEqual([
      "apply",
      "close",
      "apply",
      "close",
      "apply",
      "close",
      "apply",
      "retire",
    ]);
    expect(poll.available()).toBe(false);
  });
});
