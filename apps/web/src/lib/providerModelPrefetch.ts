import type { ProviderKind, ServerProviderStatus, ServerSettings } from "@synara/contracts";
import type { QueryClient } from "@tanstack/react-query";

import type { AppSettings } from "../appSettings";
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
];

/** Warm results stay fresh for 30 minutes instead of the interactive 60s. */
export const NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS = 30 * 60_000;

const EMPTY_PROVIDER_STATUSES: readonly ServerProviderStatus[] = [];

export function resolveNewThreadModelPrefetchProvider(input: {
  providerOverride?: ProviderKind | null | undefined;
  draftActiveProvider?: ProviderKind | null | undefined;
  stickyActiveProvider?: ProviderKind | null | undefined;
  projectDefaultProvider?: ProviderKind | null | undefined;
  defaultProvider: ProviderKind;
}): ProviderKind {
  return (
    input.providerOverride ??
    input.draftActiveProvider ??
    input.stickyActiveProvider ??
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
  settings: ProviderModelPrefetchSettings;
  cwd?: string | null;
  priority?: "background" | "prefetch" | undefined;
}) {
  const { priority, provider, settings } = input;
  const cwd = input.cwd ?? null;

  switch (provider) {
    case "claudeAgent":
      return providerModelsQueryOptions({
        provider: "claudeAgent",
        binaryPath: settings.claudeBinaryPath || null,
        priority,
      });
    case "codex":
      return providerModelsQueryOptions({ provider: "codex", priority });
    case "cursor":
      return providerModelsQueryOptions({
        provider: "cursor",
        binaryPath: settings.cursorBinaryPath || null,
        apiEndpoint: settings.cursorApiEndpoint || null,
        priority,
      });
    case "devin":
      return providerModelsQueryOptions({
        provider: "devin",
        binaryPath: settings.devinBinaryPath || null,
        cwd,
        priority,
      });
    case "antigravity":
      return providerModelsQueryOptions({
        provider: "antigravity",
        binaryPath: settings.antigravityBinaryPath || null,
        cwd,
        priority,
      });
    case "grok":
      return providerModelsQueryOptions({
        provider: "grok",
        binaryPath: settings.grokBinaryPath || null,
        priority,
      });
    case "droid":
      return providerModelsQueryOptions({
        provider: "droid",
        binaryPath: settings.droidBinaryPath || null,
        cwd,
        priority,
      });
    case "opencode":
      return providerModelsQueryOptions({
        provider: "opencode",
        binaryPath: settings.openCodeBinaryPath || null,
        cwd,
        priority,
      });
    case "pi":
      return providerModelsQueryOptions({
        provider: "pi",
        binaryPath: settings.piBinaryPath || null,
        agentDir: settings.piAgentDir || null,
        cwd,
        priority,
      });
  }
}

function providerAgentsPrefetchQueryOptions(input: {
  provider: ProviderKind;
  settings: ProviderModelPrefetchSettings;
  cwd?: string | null;
}) {
  const { provider, settings } = input;
  const cwd = input.cwd ?? null;

  switch (provider) {
    case "claudeAgent":
      return providerAgentsQueryOptions({ provider: "claudeAgent" });
    case "codex":
      return providerAgentsQueryOptions({ provider: "codex" });
    case "opencode":
      return providerAgentsQueryOptions({
        provider: "opencode",
        binaryPath: settings.openCodeBinaryPath || null,
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
  },
): void {
  const cwd = input.cwd ?? null;
  const providers = (input.providers ?? NEW_THREAD_MODEL_PREFETCH_PROVIDERS).filter(
    (provider) => provider !== "droid",
  );

  for (const provider of providers) {
    const modelsOptions = providerModelsPrefetchQueryOptions({
      provider,
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
      gcTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
    });

    // Agent/mode lists ride along for providers that surface them next to models.
    const agentsOptions = providerAgentsPrefetchQueryOptions({
      provider,
      settings: input.settings,
      cwd,
    });
    if (agentsOptions) {
      void queryClient.prefetchQuery({
        ...agentsOptions,
        retry: 0,
        staleTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
        gcTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
      });
    }

    // capabilities query has staleTime Infinity — one IPC per provider per session
    // retry:0 keeps a failing probe from multiplying per hover — ChatView's mount query still retries by its defaults
    void queryClient.prefetchQuery({
      ...providerComposerCapabilitiesQueryOptions(provider),
      retry: 0,
      gcTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
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
  },
): void {
  const cwd = input.cwd ?? null;
  void queryClient.prefetchQuery({
    ...providerModelsPrefetchQueryOptions({
      provider: "droid",
      settings: input.settings,
      cwd,
      priority: "prefetch",
    }),
    staleTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
    gcTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
  });
  void queryClient.prefetchQuery({
    ...providerComposerCapabilitiesQueryOptions("droid"),
    retry: 0,
    gcTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
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
    draftActiveProvider?: ProviderKind | null;
    stickyActiveProvider?: ProviderKind | null;
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
  const resolvedProvider = resolveNewThreadModelPrefetchProvider({
    providerOverride: input.providerOverride,
    draftActiveProvider: input.draftActiveProvider,
    stickyActiveProvider: input.stickyActiveProvider,
    projectDefaultProvider: input.projectDefaultProvider,
    defaultProvider: input.settings.defaultProvider,
  });
  const selectedProvider =
    input.statusesReconciled === true
      ? resolveAvailableProviderPreference({
          preferredProvider: resolvedProvider,
          statuses: input.providerStatuses ?? EMPTY_PROVIDER_STATUSES,
          providerOrder: input.providerOrder ?? [],
          hiddenProviders: input.hiddenProviders ?? [],
        })
      : resolvedProvider;
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
      const status = findProviderStatus(providerStatuses, provider);
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
        settings: input.settings,
        cwd,
      }).queryKey,
  );
  if (shouldWarmSelectedDroid) {
    desiredModelQueryKeys.push(
      providerModelsPrefetchQueryOptions({
        provider: "droid",
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
    prefetchDroidModelsForNewThread(queryClient, { settings: input.settings, cwd });
  }
  prefetchProviderModelsForNewThread(queryClient, {
    settings: input.settings,
    cwd,
    providers: orderedProviders,
    foregroundProvider: selectedProvider,
  });
}
