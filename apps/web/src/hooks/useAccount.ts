// FILE: useAccount.ts
// Purpose: The account session as the web app consumes it — status query plus
// sign-in/out and profile mutations, each of which settles the status cache.
// Layer: Web account feature hook.

import type {
  AccountAuthenticateOtpInput,
  AccountBeginSsoInput,
  AccountMe,
  AccountSendOtpInput,
  AccountStatus,
  AccountUpdateProfileInput,
  AccountUploadAvatarInput,
} from "@synara/contracts";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  accountQueryKeys,
  accountStatusQueryOptions,
  cancelAccountStatusFetches,
  invalidateAccountStatus,
  removeAccountScopedQueries,
} from "~/lib/accountReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { isBetaFeatureOn } from "~/betaFeatures";
import { readExecutionContext } from "~/lib/hosts/executionContext";

// Shared by every hook instance in this window, including dialogs and footer.
const mutationGenerations = new WeakMap<QueryClient, number>();
type StatusWriteFence = { generation: number; statusRevision: number };

export function useAccount() {
  const queryClient = useQueryClient();
  const statusQuery = useQuery(accountStatusQueryOptions());

  const setStatus = (status: AccountStatus) => {
    queryClient.setQueryData<AccountStatus>(accountQueryKeys.status(), (previous) => {
      if (
        status.state === "signed-in" &&
        previous?.state === "signed-in" &&
        status.me.id === previous.me.id &&
        status.me.organization.id === previous.me.organization.id &&
        !status.accountAuthority &&
        previous.accountAuthority
      ) {
        return { ...status, accountAuthority: previous.accountAuthority };
      }
      return status;
    });
  };

  /**
   * The fence every status-changing mutation wears. Without it, an
   * `account.status` fetch already in flight when the mutation starts can
   * resolve after the mutation's cache write and overwrite the newer state
   * with the pre-mutation answer (a sign-in flashing back to signed-out, or
   * a sign-out resurrecting the old identity). Cancel discards the stale
   * in-flight result before the RPC runs; invalidate-on-settled re-reads
   * the authoritative answer afterwards, success or failure.
   */
  const statusFence = {
    onMutate: async (): Promise<StatusWriteFence> => {
      const generation = (mutationGenerations.get(queryClient) ?? 0) + 1;
      mutationGenerations.set(queryClient, generation);
      await cancelAccountStatusFetches(queryClient);
      return {
        generation,
        statusRevision: queryClient.getQueryState(accountQueryKeys.status())?.dataUpdateCount ?? 0,
      };
    },
    onSettled: () => invalidateAccountStatus(queryClient),
  };

  const mayWriteStatus = (fence: StatusWriteFence | undefined) =>
    fence !== undefined &&
    mutationGenerations.get(queryClient) === fence.generation &&
    (queryClient.getQueryState(accountQueryKeys.status())?.dataUpdateCount ?? 0) ===
      fence.statusRevision;

  const sendOtp = useMutation({
    mutationFn: async (input: AccountSendOtpInput) => {
      const api = ensureNativeApi();
      return api.account.sendOtp(input);
    },
  });

  // The input carries the emailed code — a credential with the same handling
  // rules as a password: pass it straight through and keep it nowhere past
  // the call.
  const authenticateOtp = useMutation({
    ...statusFence,
    mutationFn: async (input: AccountAuthenticateOtpInput) => {
      const api = ensureNativeApi();
      return api.account.authenticateOtp(input);
    },
    onSuccess: (status: AccountStatus, _input, fence) => {
      if (!mayWriteStatus(fence)) return;
      // Drop account-scoped caches from any PREVIOUS identity before this
      // sign-in renders: the usage-summary key carries no user id, so a
      // stale entry would show the last user's usage to the new one.
      removeAccountScopedQueries(queryClient);
      setStatus(status);
    },
  });

  const beginSso = useMutation({
    mutationFn: async (input: AccountBeginSsoInput) => {
      const api = ensureNativeApi();
      return api.account.beginSso(input);
    },
  });

  // No RPC timeout: the server waits on the loopback callback for as long
  // as the attempt lives (the transport already binds `timeoutMs: null`).
  // If the socket drops mid-flight the credentials are persisted server-side
  // and the status query's refetch-on-reconnect recovers the signed-in state.
  const completeSso = useMutation({
    ...statusFence,
    mutationFn: async (input: { ssoId: string; signal?: AbortSignal }) => {
      const api = ensureNativeApi();
      return api.account.completeSso(
        { ssoId: input.ssoId },
        input.signal ? { signal: input.signal } : undefined,
      );
    },
    onSuccess: (status: AccountStatus, _input, fence) => {
      if (!mayWriteStatus(fence)) return;
      // Same identity fence as authenticateOtp: no stale account-scoped data
      // may survive into the session this sign-in establishes.
      removeAccountScopedQueries(queryClient);
      setStatus(status);
    },
  });

  // Referentially stable across renders: the sign-in dialog keys an effect on
  // this function whose CLEANUP cancels the live SSO attempt server-side. A
  // fresh identity per render would turn every ordinary rerender (mutation
  // state settling, the waiting spinner appearing) into a cancellation that
  // aborts the user's in-flight browser sign-in.
  const cancelSso = useCallback((ssoId: string) => {
    const api = ensureNativeApi();
    return api.account.cancelSso({ ssoId });
  }, []);

  const updateProfile = useMutation({
    ...statusFence,
    mutationFn: async (input: AccountUpdateProfileInput) => {
      const api = ensureNativeApi();
      return api.account.updateProfile(input);
    },
    onSuccess: (me: AccountMe, _input, fence) => {
      if (!mayWriteStatus(fence)) return;
      setStatus({ state: "signed-in", me });
    },
  });

  // The avatar mutations answer the refreshed `me` like updateProfile, so
  // every avatar render (footer, settings header, edit dialog) updates from
  // one cache write with no refetch round trip.
  const uploadAvatar = useMutation({
    ...statusFence,
    mutationFn: async (input: AccountUploadAvatarInput) => {
      const api = ensureNativeApi();
      return api.account.uploadAvatar(input);
    },
    onSuccess: (me: AccountMe, _input, fence) => {
      if (!mayWriteStatus(fence)) return;
      setStatus({ state: "signed-in", me });
    },
  });

  const deleteAvatar = useMutation({
    ...statusFence,
    mutationFn: async () => {
      const api = ensureNativeApi();
      return api.account.deleteAvatar();
    },
    onSuccess: (me: AccountMe, _input, fence) => {
      if (!mayWriteStatus(fence)) return;
      setStatus({ state: "signed-in", me });
    },
  });

  const signOut = useMutation({
    ...statusFence,
    mutationFn: async () => {
      const api = ensureNativeApi();
      await api.account.signOut();
    },
    onSuccess: (_result, _input, fence) => {
      if (!mayWriteStatus(fence)) return;
      setStatus({ state: "signed-out" });
      // Removal, not invalidation: the signed-out app must neither render
      // nor refetch the departed user's account-scoped data.
      removeAccountScopedQueries(queryClient);
    },
  });

  const openVerificationUrl = (url: string) => {
    const api = ensureNativeApi();
    return api.account.openVerificationUrl({ url });
  };

  const status = statusQuery.data ?? null;

  return {
    status,
    profileSyncEnabled:
      isBetaFeatureOn("accountProfileSync") &&
      readExecutionContext()?.controller.capabilities.accountProfileSync === true,
    me: status?.state === "signed-in" ? status.me : null,
    statusQuery,
    sendOtp,
    authenticateOtp,
    beginSso,
    completeSso,
    cancelSso,
    updateProfile,
    uploadAvatar,
    deleteAvatar,
    signOut,
    openVerificationUrl,
  } as const;
}
