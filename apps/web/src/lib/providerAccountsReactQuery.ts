// FILE: providerAccountsReactQuery.ts
// Purpose: React Query hooks and presentation helpers for the providerAccounts RPC surface.
// Layer: Web data access
// Exports: query options, mutation hooks, and shared account label helpers.

import type {
  AccountBindingState,
  AccountOrdinal,
  AccountSupportLevel,
  ProviderAccountsBeginConnectInput,
  ProviderAccountsDisconnectBindingInput,
  ProviderAccountsHideInput,
  ProviderAccountsLaunchInput,
  ProviderAccountsSetActiveInput,
  ProviderAccountsSnapshot,
  SupportedAccountProvider,
  ThreadId,
} from "@synara/contracts";
import {
  PROVIDER_DISPLAY_NAMES,
  SupportedAccountProvider as SupportedAccountProviderSchema,
} from "@synara/contracts";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const providerAccountsQueryKeys = {
  all: ["provider-accounts"] as const,
  snapshot: () => ["provider-accounts", "snapshot"] as const,
  connectStatus: (operationId: string) =>
    ["provider-accounts", "connect-status", operationId] as const,
  integrationStatus: () => ["provider-accounts", "integration-status"] as const,
  doctorReport: () => ["provider-accounts", "doctor-report"] as const,
  threadBinding: (threadId: ThreadId) => ["provider-accounts", "thread-binding", threadId] as const,
};

export function providerAccountsSnapshotQueryOptions(input?: { enabled?: boolean }) {
  return queryOptions({
    queryKey: providerAccountsQueryKeys.snapshot(),
    queryFn: async () => ensureNativeApi().providerAccounts.getSnapshot(),
    enabled: input?.enabled ?? true,
    staleTime: 15_000,
    placeholderData: (previous) => previous,
  });
}

export function providerAccountsConnectStatusQueryOptions(input: {
  operationId: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerAccountsQueryKeys.connectStatus(input.operationId ?? "none"),
    queryFn: async () => {
      if (!input.operationId) {
        throw new Error("No connect operation in progress.");
      }
      return ensureNativeApi().providerAccounts.getConnectStatus({
        operationId: input.operationId,
      });
    },
    enabled: (input.enabled ?? true) && input.operationId !== null,
    // Poll while the operation is unresolved; stop once it reaches a terminal state.
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "pending" || state === "waiting-for-user" ? 2_000 : false;
    },
  });
}

export function providerAccountsIntegrationStatusQueryOptions(input?: { enabled?: boolean }) {
  return queryOptions({
    queryKey: providerAccountsQueryKeys.integrationStatus(),
    queryFn: async () => ensureNativeApi().providerAccounts.getIntegrationStatus(),
    enabled: input?.enabled ?? true,
    staleTime: 30_000,
  });
}

export function providerAccountsDoctorReportQueryOptions(input?: { enabled?: boolean }) {
  return queryOptions({
    queryKey: providerAccountsQueryKeys.doctorReport(),
    queryFn: async () => ensureNativeApi().providerAccounts.getDoctorReport(),
    enabled: input?.enabled ?? true,
    staleTime: 30_000,
  });
}

export function providerAccountsThreadBindingQueryOptions(input: {
  threadId: ThreadId | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: providerAccountsQueryKeys.threadBinding(input.threadId ?? ("" as ThreadId)),
    queryFn: async () => {
      if (!input.threadId) {
        throw new Error("Thread binding lookup requires a thread.");
      }
      return ensureNativeApi().providerAccounts.getThreadBinding({ threadId: input.threadId });
    },
    enabled: (input.enabled ?? true) && input.threadId !== null,
    staleTime: 30_000,
  });
}

function useInvalidateProviderAccounts() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: providerAccountsQueryKeys.all });
}

export function useProviderAccountsBeginConnect() {
  const invalidate = useInvalidateProviderAccounts();
  return useMutation({
    mutationFn: (input: ProviderAccountsBeginConnectInput) =>
      ensureNativeApi().providerAccounts.beginConnect(input),
    onSuccess: () => void invalidate(),
  });
}

export function useProviderAccountsCancelConnect() {
  const invalidate = useInvalidateProviderAccounts();
  return useMutation({
    mutationFn: (input: { operationId: string }) =>
      ensureNativeApi().providerAccounts.cancelConnect(input),
    onSettled: () => void invalidate(),
  });
}

export function useProviderAccountsSetActive() {
  const invalidate = useInvalidateProviderAccounts();
  return useMutation({
    mutationFn: (input: ProviderAccountsSetActiveInput) =>
      ensureNativeApi().providerAccounts.setActive(input),
    onSuccess: () => void invalidate(),
  });
}

export function useProviderAccountsDisconnectBinding() {
  const invalidate = useInvalidateProviderAccounts();
  return useMutation({
    mutationFn: (input: ProviderAccountsDisconnectBindingInput) =>
      ensureNativeApi().providerAccounts.disconnectBinding(input),
    onSuccess: () => void invalidate(),
  });
}

export function useProviderAccountsHide() {
  const invalidate = useInvalidateProviderAccounts();
  return useMutation({
    mutationFn: (input: ProviderAccountsHideInput) =>
      ensureNativeApi().providerAccounts.hide(input),
    onSuccess: () => void invalidate(),
  });
}

export function useProviderAccountsLaunch() {
  return useMutation({
    mutationFn: (input: ProviderAccountsLaunchInput) =>
      ensureNativeApi().providerAccounts.launch(input),
  });
}

export function useProviderAccountsUpdateCliIntegration() {
  const invalidate = useInvalidateProviderAccounts();
  return useMutation({
    mutationFn: (input: { enabled: boolean }) =>
      ensureNativeApi().providerAccounts.updateCliIntegration(input),
    onSuccess: () => void invalidate(),
  });
}

// ── Shared presentation helpers ─────────────────────────────────────────────

export const SUPPORTED_ACCOUNT_PROVIDERS: ReadonlyArray<SupportedAccountProvider> =
  SupportedAccountProviderSchema.literals;

export function accountProviderLabel(provider: SupportedAccountProvider): string {
  return PROVIDER_DISPLAY_NAMES[provider];
}

/** Numbered slot label, e.g. "Codex 3" (plan section 0). */
export function accountSlotLabel(
  provider: SupportedAccountProvider,
  ordinal: AccountOrdinal,
): string {
  return `${accountProviderLabel(provider)} ${ordinal}`;
}

export const ACCOUNT_BINDING_STATE_LABELS: Record<AccountBindingState, string> = {
  "not-configured": "Not configured",
  connecting: "Connecting…",
  connected: "Connected",
  "needs-auth": "Needs sign-in",
  "needs-reverification": "Needs reverification",
  unsupported: "Unsupported",
};

export const ACCOUNT_SUPPORT_LEVEL_LABELS: Record<AccountSupportLevel, string> = {
  supported: "Supported",
  beta: "Beta",
  experimental: "Experimental",
  unsupported: "Unsupported",
};

/** "k••••@example.com · ChatGPT Plus" style identity line (plan section 36.3). */
export function accountIdentityLabel(identity?: {
  readonly hint?: string | undefined;
  readonly plan?: string | undefined;
}): string | null {
  if (!identity) return null;
  const parts = [identity.hint, identity.plan].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function providerSnapshotEntry(
  snapshot: ProviderAccountsSnapshot | undefined,
  provider: SupportedAccountProvider,
) {
  return snapshot?.providers.find((entry) => entry.provider === provider) ?? null;
}
