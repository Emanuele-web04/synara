import { reconcileWorkspaceAccount } from "./hosts/workspaceSessions";
import {
  controlAccountScope,
  accountStatusScope,
  adoptControlAccountScope,
} from "./hosts/controlQueryScope";
import { remoteHostQueryKeys } from "./hosts/queries";
import { readExecutionContext } from "./hosts/executionContext";
import { deactivateHost } from "./hosts/activeHost";
// FILE: accountReactQuery.ts
// Purpose: React Query options and invalidation for the Synara account session.
// Layer: Web data-fetching (see serverReactQuery.ts for the conventions).

import type { AccountStatus, UsageSummary } from "@synara/contracts";
import { hashKey, queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const accountQueryKeys = {
  all: ["account"] as const,
  status: () => ["account", "status"] as const,
  /** Prefix of every usageSummary key, whatever the owner or UTC offset. */
  usageSummaryAll: () => ["account", "usageSummary"] as const,
  /**
   * Keyed by the authenticated user id so one identity's cached usage can
   * never render for another: a sign-in switch that this client only observes
   * through a status refetch (another renderer signed out A and in B against
   * the shared server) lands on a DIFFERENT key than the stale entry.
   */
  usageSummary: (userId: string, utcOffsetMinutes: number) =>
    ["account", "usageSummary", userId, utcOffsetMinutes, controlAccountScope()] as const,
};

/**
 * The account session for this machine. The server refreshes tokens as part of
 * answering, so the result is authoritative; it changes only through the
 * mutations in useAccount (which invalidate) or a sign-in finishing in another
 * client, which `refetchOnReconnect`/window focus picks up.
 */
export function accountStatusQueryOptions() {
  return queryOptions({
    queryKey: accountQueryKeys.status(),
    queryFn: async (): Promise<AccountStatus> => {
      const api = ensureNativeApi();
      return api.account.status();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: 60_000,
    retry: 1,
  });
}

/**
 * The account-wide usage summary — the "Account" side of the profile panel's
 * device/account toggle. Keyed by the owning user id (see accountQueryKeys)
 * and disabled while signed out (`userId: null`). The client passes its own
 * fixed UTC offset so the service buckets days/hours to the caller's LOCAL
 * day, exactly like the local profile-stats RPCs (see
 * serverProfileStatsQueryOptions).
 */
export function accountUsageSummaryQueryOptions(input: {
  userId: string | null;
  enabled?: boolean;
}) {
  const utcOffsetMinutes = -new Date().getTimezoneOffset();
  return queryOptions({
    queryKey: accountQueryKeys.usageSummary(input.userId ?? "", utcOffsetMinutes),
    enabled: input.userId !== null && (input.enabled ?? true),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async (): Promise<UsageSummary> => {
      const api = ensureNativeApi();
      return api.account.usageSummary({ utcOffsetMinutes });
    },
  });
}

/**
 * Re-reads the session after anything that could have changed it: a finished
 * sign-in/out, an onboarding write, or a WebSocket reopen (a completeSso cut
 * off by a dropped socket still persisted credentials server-side, and this is
 * how the UI recovers that result).
 */
export async function invalidateAccountStatus(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: accountQueryKeys.status() });
}

/**
 * Removes every cached account-scoped answer (the usage summary today). A
 * fresh sign-in (or the signed-out state after sign-out) must never show the
 * previous user's usage, which includes private skill names — the per-user
 * cache key already keeps identities apart at render time, and this removal
 * frees the departed identity's data instead of leaving it resident. Removal,
 * not invalidation: invalidation keeps the stale data renderable and merely
 * refetches, and while signed out there is nothing to refetch at all.
 */
export function removeAccountScopedQueries(queryClient: QueryClient): void {
  const filter = {
    predicate: (query: { queryKey: readonly unknown[] }) =>
      (query.queryKey[0] === "account" && query.queryKey[1] !== "status") ||
      query.queryKey[0] === remoteHostQueryKeys.all[0],
  };
  void queryClient.cancelQueries(filter);
  queryClient.removeQueries(filter);
}

/**
 * Watches the status cache for identity changes this client did NOT initiate.
 * The mutation paths (sign-in/sign-out in useAccount) already evict
 * account-scoped queries, but an account switch can also arrive through a
 * plain status refetch: another renderer signs out A and signs in B against
 * the shared server, and this client's reconnect/window-focus refetch simply
 * writes the new identity into the cache. Whenever the authenticated user id
 * in `account.status` changes — by any writer — the previous identity's
 * account-scoped data is removed. Returns the unsubscribe function; the app
 * keeps one watcher alive for the QueryClient's lifetime (see router.ts).
 */
export function watchAccountIdentityChanges(queryClient: QueryClient): () => void {
  const statusHash = hashKey(accountQueryKeys.status());
  const initialStatus = queryClient.getQueryData<AccountStatus>(accountQueryKeys.status()) ?? {
    state: "signed-out" as const,
  };
  adoptControlAccountScope(initialStatus);
  let knownScope = accountStatusScope(initialStatus);
  return queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type !== "updated" ||
      event.action.type !== "success" ||
      hashKey(event.query.queryKey) !== statusHash
    )
      return;
    const status = event.query.state.data as AccountStatus | undefined;
    if (!status) return;
    const nextScope = accountStatusScope(status);
    adoptControlAccountScope(status);
    reconcileWorkspaceAccount(status);
    if (nextScope === knownScope) return;
    knownScope = nextScope;
    removeAccountScopedQueries(queryClient);
    const remote = readExecutionContext()?.remote;
    if (
      remote &&
      (status.state !== "signed-in" ||
        status.me.id !== remote.userId ||
        status.me.organization.id !== remote.organizationId ||
        status.accountAuthority !== remote.accountAuthority)
    ) {
      try {
        deactivateHost();
      } catch {
        // Never leave the previous account's transcript visible to the new one
        // if browser storage prevents draft recovery and the reload guard fails.
        const message = document.createElement("main");
        message.textContent =
          "Account changed. Editor recovery could not be saved because browser storage is unavailable. Restore storage access, then reload to return to this computer.";
        document.body.replaceChildren(message);
      }
    }
  });
}

/**
 * Fences a status-changing account mutation against the status query. An
 * `account.status` fetch already in flight when the mutation starts would
 * otherwise resolve afterwards and overwrite the mutation's newer cache write
 * with pre-mutation state — so the in-flight query is cancelled up front
 * (its late result is discarded), and after settlement the status is
 * invalidated so the next active read refetches the authoritative answer.
 */
export async function cancelAccountStatusFetches(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries({ queryKey: accountQueryKeys.status() });
}
