import type { ProviderKind, ServerProviderStatus } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { getCustomBinaryPathForProvider, useAppSettings } from "~/appSettings";
import {
  findProviderStatus,
  normalizeProviderStatusForLocalConfig,
} from "~/lib/providerAvailability";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { isProviderKind } from "~/providerOrdering";
import { VISIBLE_PROVIDER_DESCRIPTORS } from "../betaFeatures";
import {
  classifyProviderSetup,
  summarizeProviderSetup,
  type ProviderSetupState,
  type ProviderSetupSummary,
} from "./logic";
import type { ProviderDetection } from "./useProviderDetection";

const EMPTY_STATUSES: readonly ServerProviderStatus[] = [];

export interface ProviderSetupRow {
  readonly descriptor: (typeof VISIBLE_PROVIDER_DESCRIPTORS)[number];
  readonly status: ServerProviderStatus | null;
  readonly state: ProviderSetupState;
}

export interface ProviderSetup {
  readonly rows: readonly ProviderSetupRow[];
  readonly summary: ProviderSetupSummary;
  readonly setProviderDisabled: (provider: ProviderKind, disabled: boolean) => void;
}

/**
 * Detection statuses with custom-binary overrides applied but *without* the disabled flag:
 * the server reports a disabled provider as unavailable, so its last enabled status stands
 * in. The agents step must keep showing "installed" for a provider the user just
 * unchecked, otherwise the card appears to lose its CLI.
 */
function useDetectedProviderStatuses(): readonly ServerProviderStatus[] {
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const providers = serverConfigQuery.data?.providers ?? EMPTY_STATUSES;
  const [lastEnabled, setLastEnabled] = useState<ReadonlyMap<string, ServerProviderStatus>>(
    () => new Map(),
  );
  useEffect(() => {
    const enabled = providers.filter((status) => status.enabled !== false);
    if (enabled.every((status) => lastEnabled.get(status.provider) === status)) return;
    setLastEnabled((previous) => {
      const next = new Map(previous);
      for (const status of enabled) next.set(status.provider, status);
      return next;
    });
  }, [providers, lastEnabled]);
  return useMemo(
    () =>
      providers.flatMap((reported) => {
        const status =
          reported.enabled === false ? (lastEnabled.get(reported.provider) ?? reported) : reported;
        const provider = status.driver ?? status.provider;
        if (!isProviderKind(provider) || (status.instanceId ?? status.provider) !== provider) {
          return [];
        }
        const normalized = normalizeProviderStatusForLocalConfig({
          provider,
          status,
          customBinaryPath: getCustomBinaryPathForProvider(settings, provider),
        });
        return normalized ? [normalized] : [];
      }),
    [providers, lastEnabled, settings],
  );
}

/**
 * Optimistic disabled-provider selection. `disabledProviders` is server-owned and is not
 * applied to local settings until the round-trip completes, so deriving each write from
 * `settings.disabledProviders` would let a second toggle rebuild the list without the
 * first change. Every write instead comes from this draft, and the draft only resyncs
 * from the server once no write is in flight (e.g. after a failed request is rolled back).
 */
function useDisabledProvidersDraft(): {
  readonly disabled: ReadonlySet<ProviderKind>;
  readonly setProviderDisabled: (provider: ProviderKind, disabled: boolean) => void;
} {
  const { settings, updateSettingsAndWait } = useAppSettings();
  const [draft, setDraft] = useState<ReadonlySet<ProviderKind>>(
    () => new Set(settings.disabledProviders),
  );
  const draftRef = useRef(draft);
  // State, not a ref: a rejected write refetches settings *before* the count drops, so the
  // resync must run again once the final write settles or the draft would stay rolled
  // forward on the rejected value.
  const [pendingWrites, setPendingWrites] = useState(0);
  const serverDisabledProviders = settings.disabledProviders;

  useEffect(() => {
    if (pendingWrites > 0) return;
    const next = new Set(serverDisabledProviders);
    draftRef.current = next;
    setDraft(next);
  }, [pendingWrites, serverDisabledProviders]);

  const setProviderDisabled = (provider: ProviderKind, disabled: boolean) => {
    const next = new Set(draftRef.current);
    if (disabled) {
      next.add(provider);
    } else {
      next.delete(provider);
    }
    draftRef.current = next;
    setDraft(next);
    setPendingWrites((count) => count + 1);
    void updateSettingsAndWait({ disabledProviders: [...next] }).finally(() => {
      setPendingWrites((count) => count - 1);
    });
  };

  return { disabled: draft, setProviderDisabled };
}

export function useProviderSetup(detection: ProviderDetection): ProviderSetup {
  const statuses = useDetectedProviderStatuses();
  const { disabled, setProviderDisabled } = useDisabledProvidersDraft();
  const rows = VISIBLE_PROVIDER_DESCRIPTORS.map((descriptor) => {
    const status = findProviderStatus(statuses, descriptor.kind);
    const state = classifyProviderSetup({
      status,
      disabled: disabled.has(descriptor.kind),
      detecting: detection.detecting,
      detectionFailed: detection.failed,
    });
    return { descriptor, status, state };
  });
  const summary = summarizeProviderSetup(
    rows.map((row) => ({ provider: row.descriptor.kind, state: row.state })),
  );
  return { rows, summary, setProviderDisabled };
}
