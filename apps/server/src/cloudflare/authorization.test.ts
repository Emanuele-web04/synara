import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountApiError, createAccountClient } from "@synara/shared/account";
import type { AccountErrorCode, HostAuthorizationSnapshot } from "@synara/contracts";
import {
  REMOTE_AUTHORIZATION_LEASE_MS,
  REMOTE_PERMANENT_DENIAL_MS,
  requestAuthorizationSnapshot,
  startRemoteAuthorization,
} from "./authorization";

const snapshot: HostAuthorizationSnapshot = {
  ownerUserId: "owner",
  orgId: "workspace",
  ownerInOrg: true,
  discoverable: false,
  revokedDeviceJkts: [],
  pendingRevocationDeviceJkts: [],
};
afterEach(() => vi.useRealTimers());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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
  it("pauses unpaid remote access immediately and recovers without retiring device trust", async () => {
    let subscribed = true;
    let clock = 10_000;
    const abort = new AbortController();
    const unavailable = vi.fn(async () => {});
    const apply = vi.fn(async () => {});
    const refresh = vi.fn(async () => {
      if (!subscribed)
        throw new AccountApiError({
          status: 403,
          code: "subscription_required",
          message: "The host owner's remote subscription is required",
        });
      return snapshot;
    });
    const poll = startRemoteAuthorization({
      refresh,
      apply,
      unavailable,
      signal: abort.signal,
      now: () => clock,
      pollIntervalMs: 1,
      // Keeps refusals polling quickly; the backoff itself is covered below.
      refusedPollMaxMs: 1,
    });
    try {
      await vi.waitFor(() => expect(poll.available()).toBe(true));
      subscribed = false;
      await vi.waitFor(() => expect(unavailable).toHaveBeenCalledWith(false));
      // The prior authorization lease has not aged at all; the paid refusal closes it.
      expect(poll.available()).toBe(false);
      const pollsAtRefusal = refresh.mock.calls.length;
      clock += REMOTE_PERMANENT_DENIAL_MS + 1;
      await vi.waitFor(() => expect(refresh.mock.calls.length).toBeGreaterThan(pollsAtRefusal + 4));
      expect(unavailable).not.toHaveBeenCalledWith(true);

      subscribed = true;
      await vi.waitFor(() => expect(poll.available()).toBe(true));
      expect(apply.mock.calls.length).toBeGreaterThan(1);
      expect(unavailable).not.toHaveBeenCalledWith(true);
    } finally {
      abort.abort();
      await poll.done;
    }
  });
  describe("without open remote connections", () => {
    /** A poll whose snapshots revoke whatever `revoked` lists, applied as host tombstones. */
    function revocationFixture(options: { pollIntervalMs: number; idlePollIntervalMs: number }) {
      const abort = new AbortController();
      const revoked: string[] = [];
      const tombstones = new Set<string>();
      let open = false;
      const refresh = vi.fn(async () => ({ ...snapshot, revokedDeviceJkts: [...revoked] }));
      const log = vi.fn();
      const poll = startRemoteAuthorization({
        refresh,
        apply: async (applied) => {
          for (const jkt of applied.revokedDeviceJkts) tombstones.add(jkt);
        },
        unavailable: async () => {},
        signal: abort.signal,
        active: () => open,
        log,
        ...options,
      });
      // The host's device admission: a fresh snapshot first, then durable trust.
      const admit = async (deviceJkt: string) => {
        await poll.ensureFresh();
        return poll.available() && !tombstones.has(deviceJkt);
      };
      return {
        poll,
        refresh,
        revoked,
        tombstones,
        admit,
        log,
        setOpen: (value: boolean) => {
          open = value;
        },
        stop: async () => {
          abort.abort();
          await poll.done;
        },
      };
    }

    it("checks on demand before admitting and refuses a device revoked since the last check", async () => {
      const f = revocationFixture({ pollIntervalMs: 20, idlePollIntervalMs: 3_600_000 });
      try {
        await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
        await sleep(200);
        // Idle: no lease renewal between admissions.
        expect(f.refresh).toHaveBeenCalledOnce();
        expect(await f.admit("phone")).toBe(true);
        expect(f.refresh).toHaveBeenCalledTimes(2);
        // A second admission within one poll interval decides on that answer.
        expect(await f.admit("tablet")).toBe(true);
        expect(f.refresh).toHaveBeenCalledTimes(2);
        f.revoked.push("phone");
        await sleep(30);
        expect(await f.admit("phone")).toBe(false);
        expect(f.refresh).toHaveBeenCalledTimes(3);
      } finally {
        await f.stop();
      }
    });

    it("renews on the normal cadence as soon as a connection opens, so connected revocation is not slower", async () => {
      const f = revocationFixture({ pollIntervalMs: 50, idlePollIntervalMs: 3_600_000 });
      try {
        await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
        await sleep(100);
        f.setOpen(true);
        f.poll.wake();
        await vi.waitFor(() => expect(f.refresh.mock.calls.length).toBeGreaterThanOrEqual(3), {
          timeout: 500,
        });
        f.revoked.push("phone");
        // Reaches the connected device within about one poll, without any admission.
        await vi.waitFor(() => expect(f.tombstones.has("phone")).toBe(true), { timeout: 300 });
        f.setOpen(false);
        await sleep(100);
        const idle = f.refresh.mock.calls.length;
        await sleep(300);
        expect(f.refresh).toHaveBeenCalledTimes(idle);
      } finally {
        await f.stop();
      }
    });

    it("checks at once when this app revoked a device", async () => {
      const f = revocationFixture({ pollIntervalMs: 20, idlePollIntervalMs: 3_600_000 });
      try {
        await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledOnce());
        f.revoked.push("phone");
        f.poll.checkSoon();
        await vi.waitFor(() => expect(f.tombstones.has("phone")).toBe(true), { timeout: 300 });
      } finally {
        await f.stop();
      }
    });

    it("lets an idle lease lapse without logging a pause", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      let clock = 10_000;
      const abort = new AbortController();
      const log = vi.fn();
      const unavailable = vi.fn(async () => {});
      const poll = startRemoteAuthorization({
        refresh: async () => snapshot,
        apply: async () => {},
        unavailable,
        signal: abort.signal,
        now: () => clock,
        active: () => false,
        idlePollIntervalMs: 3_600_000,
        log,
      });
      try {
        await vi.waitFor(() => expect(poll.available()).toBe(true));
        clock += REMOTE_AUTHORIZATION_LEASE_MS;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(poll.available()).toBe(false);
        expect(unavailable).toHaveBeenCalledWith(false);
        expect(log).not.toHaveBeenCalled();
      } finally {
        abort.abort();
        await poll.done;
      }
    });
  });
  it("backs off repeated refusals and returns to the normal cadence once access is back", async () => {
    const abort = new AbortController();
    const polledAt: number[] = [];
    let refusals = 5;
    const poll = startRemoteAuthorization({
      refresh: async () => {
        polledAt.push(performance.now());
        if (refusals-- > 0)
          throw new AccountApiError({
            status: 403,
            code: "subscription_required",
            message: "The host owner's remote subscription is required",
          });
        return snapshot;
      },
      apply: async () => {},
      unavailable: async () => {},
      signal: abort.signal,
      pollIntervalMs: 10,
      refusedPollMaxMs: 400,
    });
    try {
      await vi.waitFor(() => expect(polledAt.length).toBeGreaterThanOrEqual(7), {
        timeout: 5_000,
      });
      expect(poll.available()).toBe(true);
      const gaps = polledAt.slice(1).map((at, index) => at - polledAt[index]!);
      // Five refusals wait 10, 20, 40, 80 and 160 ms (each with -10% jitter at most).
      [10, 20, 40, 80, 160].forEach((interval, index) =>
        expect(gaps[index]).toBeGreaterThanOrEqual(interval * 0.9 - 1),
      );
      // The first lease restores the 10 ms cadence.
      expect(gaps[5]).toBeLessThan(144);
    } finally {
      abort.abort();
      await poll.done;
    }
  });
  it("lets billing outages expire the existing lease without renewing or retiring trust", async () => {
    // Polling uses node:timers/promises; control only the separate expiry interval.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let billingAvailable = true;
    let clock = 10_000;
    const abort = new AbortController();
    const unavailable = vi.fn(async () => {});
    const refresh = vi.fn(async () => {
      if (!billingAvailable)
        throw new AccountApiError({
          status: 503,
          code: "billing_unavailable",
          message: "Subscription verification is temporarily unavailable",
        });
      return { ...snapshot, remoteBillingEnforced: true };
    });
    const poll = startRemoteAuthorization({
      refresh,
      apply: async () => {},
      unavailable,
      signal: abort.signal,
      now: () => clock,
      pollIntervalMs: 1,
    });
    try {
      await vi.waitFor(() => expect(poll.available()).toBe(true));
      billingAvailable = false;
      const pollsBeforeOutage = refresh.mock.calls.length;
      await vi.waitFor(() =>
        expect(refresh.mock.calls.length).toBeGreaterThan(pollsBeforeOutage + 1),
      );
      expect(poll.available()).toBe(true);
      expect(unavailable).not.toHaveBeenCalled();

      clock += REMOTE_AUTHORIZATION_LEASE_MS;
      await vi.advanceTimersByTimeAsync(1000);
      expect(poll.available()).toBe(false);
      expect(unavailable).toHaveBeenCalledExactlyOnceWith(false);
      expect(unavailable).not.toHaveBeenCalledWith(true);

      billingAvailable = true;
      await vi.waitFor(() => expect(poll.available()).toBe(true));
      expect(unavailable).not.toHaveBeenCalledWith(true);
    } finally {
      abort.abort();
      await poll.done;
    }
  });
  it("expires a paid lease during an outage even when the wall clock moves backwards", async () => {
    // Polls retain real promise timers; only lease expiry and monotonic time are controlled.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    let clock = 10_000;
    let billingAvailable = true;
    const abort = new AbortController();
    const unavailable = vi.fn(async () => {});
    const refresh = vi.fn(async () => {
      if (!billingAvailable) throw new Error("Account API temporarily unavailable");
      return { ...snapshot, remoteBillingEnforced: true };
    });
    const poll = startRemoteAuthorization({
      refresh,
      apply: async () => {},
      unavailable,
      signal: abort.signal,
      now: () => clock,
      pollIntervalMs: 1,
    });
    try {
      await vi.waitFor(() => expect(poll.paidAvailable()).toBe(true));
      billingAvailable = false;
      const beforeOutage = refresh.mock.calls.length;
      await vi.waitFor(() => expect(refresh.mock.calls.length).toBeGreaterThan(beforeOutage + 1));
      clock -= 60 * 60_000;
      await vi.advanceTimersByTimeAsync(REMOTE_AUTHORIZATION_LEASE_MS - 1_000);
      expect(poll.paidAvailable()).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(poll.available()).toBe(false);
      expect(poll.paidAvailable()).toBe(false);
      // Existing sockets close on the next one-second expiry sweep.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(unavailable).toHaveBeenCalledExactlyOnceWith(false);
      expect(unavailable).not.toHaveBeenCalledWith(true);
      billingAvailable = true;
      await vi.waitFor(() => expect(poll.paidAvailable()).toBe(true));
      expect(unavailable).not.toHaveBeenCalledWith(true);
    } finally {
      abort.abort();
      await poll.done;
    }
  });
  it.each([false, undefined] as const)(
    "does not carry a %s billing-policy lease through an unverified paid cutover",
    async (previousPolicy) => {
      let billingUnavailable = false;
      let confirmedPaid = false;
      const abort = new AbortController();
      const unavailable = vi.fn(async () => {});
      const poll = startRemoteAuthorization({
        refresh: async () => {
          if (billingUnavailable)
            throw new AccountApiError({
              status: 503,
              code: "billing_unavailable",
              message: "Subscription verification is temporarily unavailable",
            });
          return {
            ...snapshot,
            ...(confirmedPaid
              ? { remoteBillingEnforced: true }
              : previousPolicy === undefined
                ? {}
                : { remoteBillingEnforced: previousPolicy }),
          };
        },
        apply: async () => {},
        unavailable,
        signal: abort.signal,
        now: () => 10_000,
        pollIntervalMs: 1,
      });
      try {
        await vi.waitFor(() => expect(poll.available()).toBe(true));
        billingUnavailable = true;
        await vi.waitFor(() => expect(unavailable).toHaveBeenCalledWith(false));
        // The clock did not advance: a former free-policy lease cannot grant paid access.
        expect(poll.available()).toBe(false);
        expect(unavailable).not.toHaveBeenCalledWith(true);

        confirmedPaid = true;
        billingUnavailable = false;
        await vi.waitFor(() => expect(poll.available()).toBe(true));
      } finally {
        abort.abort();
        await poll.done;
      }
    },
  );
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

describe("authorization snapshot request", () => {
  /** A real account client whose responses come from `answers`, in order; "stall" hangs until aborted. */
  function clientAnswering(answers: Array<"stall" | "reset" | Response>) {
    const fetch = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const answer = answers.shift() ?? "stall";
          if (answer === "reset") return reject(new TypeError("fetch failed"));
          if (answer !== "stall") return resolve(answer);
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), {
            once: true,
          });
        }),
    );
    const client = createAccountClient({
      baseUrl: "https://account.example.test",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const request = (signal: AbortSignal) =>
      client.getHostAuthorization("fixture-host-proof", "fixture-host", signal);
    return { fetch, request };
  }

  it("gives up on a stalled request after the attempt timeout and retries it once at once", async () => {
    const { fetch, request } = clientAnswering(["stall", Response.json(snapshot)]);
    const startedAt = performance.now();
    await expect(
      requestAuthorizationSnapshot(request, {
        signal: new AbortController().signal,
        attemptTimeoutMs: 50,
      }),
    ).resolves.toEqual(snapshot);
    expect(fetch).toHaveBeenCalledTimes(2);
    // One attempt timeout, not the client's general 15 s bound.
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("retries a dropped connection once", async () => {
    const { fetch, request } = clientAnswering(["reset", Response.json(snapshot)]);
    await expect(
      requestAuthorizationSnapshot(request, { signal: new AbortController().signal }),
    ).resolves.toEqual(snapshot);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails as a timeout after two stalled attempts", async () => {
    const { fetch, request } = clientAnswering(["stall", "stall"]);
    await expect(
      requestAuthorizationSnapshot(request, {
        signal: new AbortController().signal,
        attemptTimeoutMs: 20,
      }),
    ).rejects.toMatchObject({ status: 408 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // Denial confirmation and refusal backoff count answers; a retry must not add any.
  it.each([
    [403, "not_host_owner"],
    [403, "subscription_required"],
    [404, "host_not_found"],
    [503, "internal_error"],
  ])("returns a %i %s answer without retrying", async (status, error) => {
    const { fetch, request } = clientAnswering([
      Response.json({ error, message: "Refused" }, { status }),
      Response.json(snapshot),
    ]);
    await expect(
      requestAuthorizationSnapshot(request, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ status, code: error });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("passes on an answer that lands as the attempt bound elapses", async () => {
    const attempt = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      throw new AccountApiError({
        status: 403,
        code: "subscription_required",
        message: "Refused",
      });
    });
    await expect(
      requestAuthorizationSnapshot(attempt, {
        signal: new AbortController().signal,
        attemptTimeoutMs: 10,
      }),
    ).rejects.toMatchObject({ status: 403, code: "subscription_required" });
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("does not retry once its owner has stopped", async () => {
    const { fetch, request } = clientAnswering(["stall", Response.json(snapshot)]);
    const stop = new AbortController();
    const pending = requestAuthorizationSnapshot(request, { signal: stop.signal });
    stop.abort();
    await expect(pending).rejects.toMatchObject({ status: 408 });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
