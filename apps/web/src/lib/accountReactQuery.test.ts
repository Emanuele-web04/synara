// FILE: accountReactQuery.test.ts
// Purpose: Verifies the identity fences around account-scoped query caching —
// the per-user usage-summary key, and the status watcher that evicts
// account-scoped data when a status refetch reveals a different identity
// (an account switch performed by another client against the shared server).

import type { AccountStatus } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteHostQueryKeys } from "./hosts/queries";
import { readWorkspaceSessions } from "./hosts/workspaceSessions";

import {
  accountQueryKeys,
  accountStatusQueryOptions,
  accountUsageSummaryQueryOptions,
  watchAccountIdentityChanges,
} from "./accountReactQuery";

vi.mock("./hosts/workspaceSessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hosts/workspaceSessions")>()),
  readWorkspaceSessions: vi.fn(() => []),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => {
    throw new Error("no RPC expected in these tests");
  },
}));

const signedIn = (userId: string): AccountStatus => ({
  state: "signed-in",
  me: {
    id: userId,
    name: "Ada Lovelace",
    email: "ada@example.com",
    organization: { id: "org_1", name: "Ada's Workspace" },
    profile: null,
  },
});

describe("accountStatusQueryOptions polling", () => {
  afterEach(() => {
    vi.mocked(readWorkspaceSessions).mockReturnValue([]);
  });

  function refetchIntervalMs(): unknown {
    const { refetchInterval } = accountStatusQueryOptions();
    return typeof refetchInterval === "function"
      ? refetchInterval(undefined as never)
      : refetchInterval;
  }

  it("re-reads the account every 10 minutes, not every minute", () => {
    expect(refetchIntervalMs()).toBe(10 * 60_000);
  });

  // An account change elsewhere must still close remote workspace frames promptly.
  it("keeps the 1-minute read while a remote workspace is open", () => {
    vi.mocked(readWorkspaceSessions).mockReturnValue([
      {} as ReturnType<typeof readWorkspaceSessions>[number],
    ]);
    expect(refetchIntervalMs()).toBe(60_000);
  });

  it("keeps the focus and reconnect re-reads", () => {
    expect(accountStatusQueryOptions()).toMatchObject({
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    });
  });
});

describe("accountUsageSummaryQueryOptions", () => {
  it("keys the usage summary by the authenticated user id", () => {
    const forA = accountUsageSummaryQueryOptions({ userId: "user_a" });
    const forB = accountUsageSummaryQueryOptions({ userId: "user_b" });

    expect(forA.queryKey).not.toEqual(forB.queryKey);
    expect(forA.queryKey).toContain("user_a");
    expect(forB.queryKey).toContain("user_b");
  });

  it("disables the query while signed out", () => {
    expect(accountUsageSummaryQueryOptions({ userId: null }).enabled).toBe(false);
    expect(accountUsageSummaryQueryOptions({ userId: "user_a" }).enabled).toBe(true);
    expect(accountUsageSummaryQueryOptions({ userId: "user_a", enabled: false }).enabled).toBe(
      false,
    );
  });
});

describe("watchAccountIdentityChanges", () => {
  const utcOffsetMinutes = 120;

  it("cancels an old account's pending directory and does not resurrect it after an organization switch", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const a = signedIn("user_a");
    queryClient.setQueryData(accountQueryKeys.status(), a);
    const unsubscribe = watchAccountIdentityChanges(queryClient);
    const oldKey = remoteHostQueryKeys.hosts();
    let finish!: (hosts: string[]) => void;
    const pending = queryClient
      .fetchQuery({
        queryKey: oldKey,
        queryFn: () =>
          new Promise<string[]>((resolve) => {
            finish = resolve;
          }),
      })
      .catch(() => undefined);
    if (a.state !== "signed-in") throw new Error("fixture must be signed in");
    queryClient.setQueryData(accountQueryKeys.status(), {
      ...a,
      me: { ...a.me, organization: { id: "other-org", name: "Other workspace" } },
    });
    const newKey = remoteHostQueryKeys.hosts();
    expect(newKey).not.toEqual(oldKey);
    queryClient.setQueryData(newKey, ["new workspace host"]);
    finish(["private old workspace host"]);
    await pending;
    expect(queryClient.getQueryData(oldKey)).toBeUndefined();
    expect(queryClient.getQueryData(newKey)).toEqual(["new workspace host"]);
    unsubscribe();
    queryClient.clear();
  });

  it("evicts account-scoped queries when a status write reveals a new identity", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), signedIn("user_a"));
    const unsubscribe = watchAccountIdentityChanges(queryClient);
    queryClient.setQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes), {
      lifetimeTokens: 42,
    });

    // Another client signed out A and signed in B; this client only sees the
    // result of its own status refetch landing in the cache.
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), signedIn("user_b"));

    expect(
      queryClient.getQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes)),
    ).toBeUndefined();
    unsubscribe();
  });

  it("evicts account-scoped queries when a status refetch reveals a sign-out", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), signedIn("user_a"));
    const unsubscribe = watchAccountIdentityChanges(queryClient);
    queryClient.setQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes), {
      lifetimeTokens: 42,
    });

    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), { state: "signed-out" });

    expect(
      queryClient.getQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes)),
    ).toBeUndefined();
    unsubscribe();
  });

  it("keeps account-scoped queries across same-identity status refreshes", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), signedIn("user_a"));
    const unsubscribe = watchAccountIdentityChanges(queryClient);
    queryClient.setQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes), {
      lifetimeTokens: 42,
    });

    // Routine refetches (token refresh, window focus) answer the same user.
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), signedIn("user_a"));

    expect(
      queryClient.getQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes)),
    ).toEqual({ lifetimeTokens: 42 });
    unsubscribe();
  });

  it("ignores writes to unrelated query keys", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), signedIn("user_a"));
    const unsubscribe = watchAccountIdentityChanges(queryClient);
    queryClient.setQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes), {
      lifetimeTokens: 42,
    });

    queryClient.setQueryData(["something", "else"], { whatever: true });

    expect(
      queryClient.getQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes)),
    ).toEqual({ lifetimeTokens: 42 });
    unsubscribe();
  });

  it("seeds from the cached identity so an unchanged status does not evict", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), signedIn("user_a"));
    const unsubscribe = watchAccountIdentityChanges(queryClient);
    queryClient.setQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes), {
      lifetimeTokens: 42,
    });

    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), signedIn("user_a"));

    expect(
      queryClient.getQueryData(accountQueryKeys.usageSummary("user_a", utcOffsetMinutes)),
    ).toEqual({ lifetimeTokens: 42 });
    unsubscribe();
  });
});
