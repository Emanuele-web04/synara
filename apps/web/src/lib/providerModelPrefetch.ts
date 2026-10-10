// FILE: providerModelPrefetch.ts
// Purpose: Warm provider model discovery and composer capabilities into the
//          React Query cache before a new thread mounts ChatView, so the
//          composer can skip the "Loading models" skeleton and capability
//          round-trips on the common new-thread path.
// Layer: Web lib
// Exports: resolve + prefetch helpers that mirror ChatView's listModels query keys.

import type {
  ProviderInstanceId,
  ProviderKind,
  ServerProviderStatus,
  ServerSettings,
} from "@synara/contracts";
import type { QueryClient } from "@tanstack/react-query";

import {
  getProviderInstanceOptions,
  getProviderStartOptions,
  type AppSettings,
} from "../appSettings";
import { isProviderKind } from "../providerOrdering";
import type { DraftThreadEnvMode } from "../composerDraftDomain";
import { findProviderStatus, resolveAvailableProviderPreference } from "./providerAvailability";
import { resolveProviderDiscoveryCwd } from "./providerDiscovery";
import {
  prioritizeProviderModelDiscovery,
  providerAgentsQueryOptions,
  providerComposerCapabilitiesQueryOptions,
  providerDiscoveryQueryKeys,
  providerModelDiscoveryRetry,
  providerModelsQueryOptions,
} from "./providerDiscoveryReactQuery";

export type ProviderModelPrefetchSettings = Pick<
  AppSettings,
  | "defaultProvider"
  | "claudeBinaryPath"
  | "cursorBinaryPath"
  | "cursorApiEndpoint"
  | "devinBinaryPath"
  | "antigravityBinaryPath"
  | "grokBinaryPath"
  | "droidBinaryPath"
  | "openCodeBinaryPath"
  | "piBinaryPath"
  | "piAgentDir"
  | "ompBinaryPath"
  | "ompAgentDir"
> &
  Partial<
    Pick<
      AppSettings,
      | "claudeHomePath"
      | "codexAccounts"
      | "codexBinaryPath"
      | "codexHomePath"
      | "selectedCodexAccountId"
      | "openCodeExperimentalWebSockets"
      | "openCodeServerUrl"
      | "providerInstances"
    >
  >;

/**
 * Providers whose model catalogs are runtime-discovered (not static) and thus
 * need warming before the picker can show anything beyond the static fallback.
 * Droid is excluded: its discovery spins a disposable ACP session per model,
 * so it warms only on explicit new-thread intent.
 */
export const NEW_THREAD_MODEL_PREFETCH_PROVIDERS: ReadonlyArray<Exclude<ProviderKind, "droid">> = [
  "codex",
  "claudeAgent",
  "cursor",
  "antigravity",
  "grok",
  "opencode",
  "pi",
  "devin",
  // One global `omp models` spawn, not per-model sessions like Droid — safe to
  // keep warm across hover/mount prefetches.
  "omp",
];

/** Warm results stay fresh for 30 minutes; the interactive staleTime is 15min. */
export const NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS = 30 * 60_000;

/** Retain warmed catalogs as long as the server's stale-while-revalidate window. */
export const NEW_THREAD_MODEL_PREFETCH_GC_TIME_MS = 24 * 60 * 60_000;

const EMPTY_PROVIDER_STATUSES: readonly ServerProviderStatus[] = [];

function providerStartOptionsForInstance(
  settings: ProviderModelPrefetchSettings,
  instanceId: ProviderInstanceId,
) {
  return getProviderStartOptions(
    {
      ...settings,
      claudeHomePath: settings.claudeHomePath ?? "",
      codexAccounts: settings.codexAccounts ?? [],
      codexBinaryPath: settings.codexBinaryPath ?? "",
      codexHomePath: settings.codexHomePath ?? "",
      selectedCodexAccountId: settings.selectedCodexAccountId ?? "default",
      openCodeExperimentalWebSockets: settings.openCodeExperimentalWebSockets ?? false,
      openCodeServerUrl: settings.openCodeServerUrl ?? "",
      providerInstances: settings.providerInstances ?? {},
    },
    instanceId,
  );
}

function readProviderOptionString(options: unknown, key: string): string | null {
  if (!options || typeof options !== "object") return null;
  const value = (options as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export function resolveNewThreadModelPrefetchProvider(input: {
  providerOverride?: ProviderKind | null | undefined;
  draftActiveProvider?: ProviderInstanceId | null | undefined;
  stickyActiveProvider?: ProviderInstanceId | null | undefined;
  projectDefaultProvider?: ProviderKind | null | undefined;
  defaultProvider: ProviderKind;
  resolveProviderForInstanceId?: (
    instanceId: ProviderInstanceId,
  ) => ProviderKind | null | undefined;
}): ProviderKind {
  const resolveInstance = (instanceId: ProviderInstanceId | null | undefined) =>
    instanceId
      ? (input.resolveProviderForInstanceId?.(instanceId) ??
        (isProviderKind(instanceId) ? instanceId : null))
      : null;
  return (
    input.providerOverride ??
    resolveInstance(input.draftActiveProvider) ??
    resolveInstance(input.stickyActiveProvider) ??
    input.projectDefaultProvider ??
    input.defaultProvider
  );
}

export function resolveNewThreadModelPrefetchCwd(input: {
  worktreePath?: string | null | undefined;
  hasExplicitWorktreePath?: boolean;
  fresh?: boolean;
  envMode?: DraftThreadEnvMode | null;
  draftWorktreePath?: string | null | undefined;
  projectCwd?: string | null | undefined;
  serverCwd?: string | null | undefined;
}): string | null {
  // mirrors the new thread's real worktree resolution: explicit worktreePath wins, envMode local without an explicit worktree clears it, fresh seeds ignore the stored draft
  let worktreePath: string | null;
  if (input.hasExplicitWorktreePath === true) {
    worktreePath = input.worktreePath ?? null;
  } else if (input.fresh === true) {
    worktreePath = null;
  } else if (input.envMode === "local") {
    worktreePath = null;
  } else {
    worktreePath = input.draftWorktreePath ?? null;
  }
  return resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: worktreePath,
    activeProjectCwd: input.projectCwd ?? null,
    serverCwd: input.serverCwd ?? null,
  });
}

/**
 * Build the same listModels query options ChatView uses for a provider, so a
 * prefetch lands on the exact cache key the composer will read on mount.
 */
export function providerModelsPrefetchQueryOptions(input: {
  provider: ProviderKind;
  instanceId?: ProviderInstanceId;
  settings: ProviderModelPrefetchSettings;
  cwd?: string | null;
  priority?: "background" | "prefetch" | undefined;
}) {
  const { priority, provider, settings } = input;
  const cwd = input.cwd ?? null;
  const instanceId = input.instanceId ?? provider;
  const providerOptions = providerStartOptionsForInstance(settings, instanceId)?.[provider];
  const optionString = (key: string) => readProviderOptionString(providerOptions, key);

  switch (provider) {
    case "claudeAgent":
      return providerModelsQueryOptions({
        provider: "claudeAgent",
        instanceId,
        binaryPath: optionString("binaryPath"),
        homePath: optionString("homePath"),
        priority,
      });
    case "codex":
      return providerModelsQueryOptions({
        provider: "codex",
        instanceId,
        binaryPath: optionString("binaryPath"),
        homePath: optionString("homePath"),
        shadowHomePath: optionString("shadowHomePath"),
        accountId: optionString("accountId"),
        priority,
      });
    case "cursor":
      return providerModelsQueryOptions({
        provider: "cursor",
        instanceId,
        binaryPath: optionString("binaryPath"),
        apiEndpoint: optionString("apiEndpoint"),
        priority,
      });
    case "devin":
      return providerModelsQueryOptions({
        provider: "devin",
        instanceId,
        binaryPath: optionString("binaryPath"),
        cwd,
        priority,
      });
    case "antigravity":
      return providerModelsQueryOptions({
        provider: "antigravity",
        instanceId,
        binaryPath: optionString("binaryPath"),
        cwd,
        priority,
      });
    case "grok":
      return providerModelsQueryOptions({
        provider: "grok",
        instanceId,
        binaryPath: optionString("binaryPath"),
        priority,
      });
    case "droid":
      return providerModelsQueryOptions({
        provider: "droid",
        instanceId,
        binaryPath: optionString("binaryPath"),
        cwd,
        priority,
      });
    case "opencode":
      return providerModelsQueryOptions({
        provider: "opencode",
        instanceId,
        binaryPath: optionString("binaryPath"),
        cwd,
        priority,
      });
    case "pi":
      return providerModelsQueryOptions({
        provider: "pi",
        instanceId,
        binaryPath: optionString("binaryPath"),
        agentDir: optionString("agentDir"),
        cwd,
        priority,
      });
    case "omp":
      // OMP's catalog is global (`omp models` is not project-scoped), so the
      // prefetch lands on the cwd-agnostic key the startup warmer writes.
      return providerModelsQueryOptions({
        provider: "omp",
        instanceId,
        binaryPath: optionString("binaryPath"),
        agentDir: optionString("agentDir"),
        priority,
      });
  }
}

function providerAgentsPrefetchQueryOptions(input: {
  provider: ProviderKind;
  instanceId?: ProviderInstanceId;
  settings: ProviderModelPrefetchSettings;
  cwd?: string | null;
}) {
  const { provider, settings } = input;
  const cwd = input.cwd ?? null;
  const instanceId = input.instanceId ?? provider;
  const providerOptions = providerStartOptionsForInstance(settings, instanceId)?.[provider];

  switch (provider) {
    case "claudeAgent":
      return providerAgentsQueryOptions({ provider: "claudeAgent", instanceId });
    case "codex":
      return providerAgentsQueryOptions({ provider: "codex", instanceId });
    case "opencode":
      return providerAgentsQueryOptions({
        provider: "opencode",
        instanceId,
        binaryPath: readProviderOptionString(providerOptions, "binaryPath"),
        cwd,
      });
    default:
      return null;
  }
}

export function prefetchProviderModelsForNewThread(
  queryClient: QueryClient,
  input: {
    settings: ProviderModelPrefetchSettings;
    cwd?: string | null;
    providers?: ReadonlyArray<ProviderKind>;
    foregroundProvider?: ProviderKind;
    foregroundInstanceId?: ProviderInstanceId;
  },
): void {
  const cwd = input.cwd ?? null;
  const providers = (input.providers ?? NEW_THREAD_MODEL_PREFETCH_PROVIDERS).filter(
    (provider) => provider !== "droid",
  );

  for (const provider of providers) {
    const instanceId =
      provider === (input.foregroundProvider ?? providers[0])
        ? (input.foregroundInstanceId ?? provider)
        : provider;
    const modelsOptions = providerModelsPrefetchQueryOptions({
      provider,
      instanceId,
      settings: input.settings,
      cwd,
      priority: provider === (input.foregroundProvider ?? providers[0]) ? "prefetch" : "background",
    });
    void queryClient.prefetchQuery({
      ...modelsOptions,
      retry:
        provider === "codex" || provider === "claudeAgent"
          ? 0
          : providerModelDiscoveryRetry(provider),
      staleTime:
        provider === "devin"
          ? (query) => (query.state.data?.error ? 0 : NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS)
          : NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
      gcTime: NEW_THREAD_MODEL_PREFETCH_GC_TIME_MS,
    });

    // Agent/mode lists ride along for providers that surface them next to models.
    const agentsOptions = providerAgentsPrefetchQueryOptions({
      provider,
      instanceId,
      settings: input.settings,
      cwd,
    });
    if (agentsOptions) {
      void queryClient.prefetchQuery({
        ...agentsOptions,
        retry: 0,
        staleTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
        gcTime: NEW_THREAD_MODEL_PREFETCH_GC_TIME_MS,
      });
    }

    // capabilities query has staleTime Infinity — one IPC per provider per session
    // retry:0 keeps a failing probe from multiplying per hover — ChatView's mount query still retries by its defaults
    void queryClient.prefetchQuery({
      ...providerComposerCapabilitiesQueryOptions(provider, instanceId),
      retry: 0,
      gcTime: NEW_THREAD_MODEL_PREFETCH_GC_TIME_MS,
    });
  }
}

/**
 * Warm Droid's model catalog on explicit new-thread intent only. Droid
 * discovery spins a disposable ACP session per model (expensive), so it must
 * never run from idle project focus.
 */
export function prefetchDroidModelsForNewThread(
  queryClient: QueryClient,
  input: {
    settings: ProviderModelPrefetchSettings;
    cwd?: string | null;
    instanceId?: ProviderInstanceId;
  },
): void {
  const cwd = input.cwd ?? null;
  void queryClient.prefetchQuery({
    ...providerModelsPrefetchQueryOptions({
      provider: "droid",
      instanceId: input.instanceId ?? "droid",
      settings: input.settings,
      cwd,
      priority: "prefetch",
    }),
    staleTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
    gcTime: NEW_THREAD_MODEL_PREFETCH_GC_TIME_MS,
  });
  void queryClient.prefetchQuery({
    ...providerComposerCapabilitiesQueryOptions("droid", input.instanceId ?? "droid"),
    retry: 0,
    gcTime: NEW_THREAD_MODEL_PREFETCH_GC_TIME_MS,
  });
}

/**
 * Warm every visible provider for the next new thread: the selected provider
 * first, hidden/disabled/confirmed-uninstalled providers skipped, Droid only on
 * explicit intent. Provider availability mirrors the model picker on main
 * (#652): the picker lists only `status.available` providers, so warming a
 * provider that is confirmed absent would only produce failing spawns.
 */
export function prefetchModelsForNewThread(
  queryClient: QueryClient,
  input: {
    settings: ProviderModelPrefetchSettings;
    serverSettings?: ServerSettings | null;
    hiddenProviders?: ReadonlyArray<ProviderKind>;
    providerStatuses?: readonly ServerProviderStatus[] | null;
    statusesReconciled?: boolean;
    providerOrder?: readonly ProviderKind[];
    providerOverride?: ProviderKind | null;
    draftActiveProvider?: ProviderInstanceId | null;
    stickyActiveProvider?: ProviderInstanceId | null;
    projectDefaultProvider?: ProviderKind | null;
    projectCwd?: string | null;
    draftWorktreePath?: string | null;
    serverCwd?: string | null;
    worktreePath?: string | null;
    hasExplicitWorktreePath?: boolean;
    fresh?: boolean;
    envMode?: DraftThreadEnvMode | null;
    includeDroid?: boolean;
  },
): void {
  const configuredProviderInstances = getProviderInstanceOptions({
    codexAccounts: input.settings.codexAccounts ?? [],
    codexHomePath: input.settings.codexHomePath ?? "",
    selectedCodexAccountId: input.settings.selectedCodexAccountId ?? "default",
    providerInstances: input.settings.providerInstances ?? {},
  });
  const resolveProviderForInstanceId = (instanceId: ProviderInstanceId): ProviderKind | null =>
    configuredProviderInstances.find((instance) => instance.instanceId === instanceId)?.provider ??
    null;
  const resolvedProvider = resolveNewThreadModelPrefetchProvider({
    providerOverride: input.providerOverride,
    draftActiveProvider: input.draftActiveProvider,
    stickyActiveProvider: input.stickyActiveProvider,
    projectDefaultProvider: input.projectDefaultProvider,
    defaultProvider: input.settings.defaultProvider,
    resolveProviderForInstanceId,
  });
  const preferredInstanceId = (() => {
    if (input.providerOverride) return input.providerOverride;
    for (const instanceId of [input.draftActiveProvider, input.stickyActiveProvider]) {
      if (instanceId && resolveProviderForInstanceId(instanceId) === resolvedProvider) {
        return instanceId;
      }
    }
    return resolvedProvider;
  })();
  // ChatView resolves the new thread's provider with the same availability
  // preference (resolveAvailableProviderPreference) once statuses are reconciled,
  // so the warm-first provider is the one the composer will actually show.
  const selectedProvider =
    input.statusesReconciled === true
      ? resolveAvailableProviderPreference({
          preferredProvider: resolvedProvider,
          statuses: input.providerStatuses ?? EMPTY_PROVIDER_STATUSES,
          providerOrder: input.providerOrder ?? [],
          hiddenProviders: input.hiddenProviders ?? [],
        })
      : resolvedProvider;
  const selectedProviderInstanceId =
    selectedProvider === resolvedProvider ? preferredInstanceId : selectedProvider;
  const cwd = resolveNewThreadModelPrefetchCwd({
    worktreePath: input.worktreePath ?? null,
    hasExplicitWorktreePath: input.hasExplicitWorktreePath === true,
    fresh: input.fresh === true,
    envMode: input.envMode ?? null,
    draftWorktreePath: input.draftWorktreePath,
    projectCwd: input.projectCwd,
    serverCwd: input.serverCwd,
  });
  const hiddenProviderSet = new Set(input.hiddenProviders ?? []);
  const statusesReconciled = input.statusesReconciled === true;
  const providerStatuses = input.providerStatuses ?? EMPTY_PROVIDER_STATUSES;
  const isProviderWarmable = (provider: ProviderKind): boolean => {
    // mirrors shouldDiscoverProvider: enabled short-circuits even the selected provider, then selected wins, then hidden skipped
    if (input.serverSettings?.providers[provider]?.enabled === false) {
      return false;
    }
    // ChatView always discovers the selected provider (even hidden/unavailable — the picker preserves it as protected) so the warm must too or mount re-runs the loading state this exists to remove
    if (provider === selectedProvider) {
      return true;
    }
    if (hiddenProviderSet.has(provider)) {
      return false;
    }
    // the picker lists only installed providers once reconciled — a confirmed-unavailable provider only produces a failing spawn; unresolved statuses stay warmable
    if (statusesReconciled) {
      const status = findProviderStatus(
        providerStatuses,
        provider,
        provider === selectedProvider ? selectedProviderInstanceId : provider,
      );
      if (status !== null && status.available === false) {
        return false;
      }
    }
    return true;
  };
  const providers = NEW_THREAD_MODEL_PREFETCH_PROVIDERS.filter(isProviderWarmable);
  const orderedProviders =
    selectedProvider === "droid" || !isProviderWarmable(selectedProvider)
      ? providers
      : [selectedProvider, ...providers.filter((provider) => provider !== selectedProvider)];
  const shouldWarmSelectedDroid =
    input.includeDroid === true && selectedProvider === "droid" && isProviderWarmable("droid");
  const desiredModelQueryKeys = orderedProviders.map(
    (provider) =>
      providerModelsPrefetchQueryOptions({
        provider,
        instanceId: provider === selectedProvider ? selectedProviderInstanceId : provider,
        settings: input.settings,
        cwd,
      }).queryKey,
  );
  if (shouldWarmSelectedDroid) {
    desiredModelQueryKeys.push(
      providerModelsPrefetchQueryOptions({
        provider: "droid",
        instanceId: selectedProviderInstanceId,
        settings: input.settings,
        cwd,
      }).queryKey,
    );
  }
  const selectedModelQueryKey = desiredModelQueryKeys.find(
    (queryKey) => queryKey[2] === selectedProvider,
  );
  if (selectedModelQueryKey) {
    prioritizeProviderModelDiscovery(selectedModelQueryKey, "prefetch");
  }

  // hovering another project supersedes only inactive prefetches; include fetching+offline-paused queries so stale hover work can't revive on reconnect and consume admission
  void queryClient.cancelQueries({
    queryKey: providerDiscoveryQueryKeys.modelsAll,
    type: "inactive",
    predicate: (query) =>
      !desiredModelQueryKeys.some(
        (queryKey) =>
          query.queryKey.length === queryKey.length &&
          query.queryKey.every((value, index) => Object.is(value, queryKey[index])),
      ),
  });

  if (shouldWarmSelectedDroid) {
    prefetchDroidModelsForNewThread(queryClient, {
      settings: input.settings,
      cwd,
      instanceId: selectedProviderInstanceId,
    });
  }
  prefetchProviderModelsForNewThread(queryClient, {
    settings: input.settings,
    cwd,
    providers: orderedProviders,
    foregroundProvider: selectedProvider,
    foregroundInstanceId: selectedProviderInstanceId,
  });
}
