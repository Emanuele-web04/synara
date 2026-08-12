// FILE: providerModelPrefetch.ts
// Purpose: Warm provider model discovery and composer capabilities into the
//          React Query cache before a new thread mounts ChatView, so the
//          composer can skip the "Loading models" skeleton and capability
//          round-trips on the common new-thread path.
// Layer: Web lib
// Exports: resolve + prefetch helpers that mirror ChatView's listModels query keys.

import type { ProviderKind, ServerSettings } from "@synara/contracts";
import type { QueryClient } from "@tanstack/react-query";

import type { AppSettings } from "../appSettings";
import { resolveProviderDiscoveryCwd } from "./providerDiscovery";
import {
  providerAgentsQueryOptions,
  providerComposerCapabilitiesQueryOptions,
  providerModelsQueryOptions,
} from "./providerDiscoveryReactQuery";

export type ProviderModelPrefetchSettings = Pick<
  AppSettings,
  | "defaultProvider"
  | "claudeBinaryPath"
  | "cursorBinaryPath"
  | "cursorApiEndpoint"
  | "antigravityBinaryPath"
  | "grokBinaryPath"
  | "droidBinaryPath"
  | "kiloBinaryPath"
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
  "kilo",
  "opencode",
  "pi",
];

/** Warm results stay fresh for 30 minutes instead of the interactive 60s. */
export const NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS = 30 * 60_000;

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
  draftWorktreePath?: string | null | undefined;
  projectCwd?: string | null | undefined;
  serverCwd?: string | null | undefined;
}): string | null {
  return resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: input.draftWorktreePath ?? null,
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
}) {
  const { provider, settings } = input;
  const cwd = input.cwd ?? null;

  switch (provider) {
    case "claudeAgent":
      return providerModelsQueryOptions({
        provider: "claudeAgent",
        binaryPath: settings.claudeBinaryPath || null,
      });
    case "codex":
      return providerModelsQueryOptions({ provider: "codex" });
    case "cursor":
      return providerModelsQueryOptions({
        provider: "cursor",
        binaryPath: settings.cursorBinaryPath || null,
        apiEndpoint: settings.cursorApiEndpoint || null,
      });
    case "antigravity":
      return providerModelsQueryOptions({
        provider: "antigravity",
        binaryPath: settings.antigravityBinaryPath || null,
        cwd,
      });
    case "grok":
      return providerModelsQueryOptions({
        provider: "grok",
        binaryPath: settings.grokBinaryPath || null,
      });
    case "droid":
      return providerModelsQueryOptions({
        provider: "droid",
        binaryPath: settings.droidBinaryPath || null,
        cwd,
      });
    case "kilo":
      return providerModelsQueryOptions({
        provider: "kilo",
        binaryPath: settings.kiloBinaryPath || null,
        cwd,
      });
    case "opencode":
      return providerModelsQueryOptions({
        provider: "opencode",
        binaryPath: settings.openCodeBinaryPath || null,
        cwd,
      });
    case "pi":
      return providerModelsQueryOptions({
        provider: "pi",
        binaryPath: settings.piBinaryPath || null,
        agentDir: settings.piAgentDir || null,
        cwd,
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
    case "kilo":
      return providerAgentsQueryOptions({
        provider: "kilo",
        binaryPath: settings.kiloBinaryPath || null,
        cwd,
      });
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
    });
    void queryClient.prefetchQuery({
      ...modelsOptions,
      retry: 0,
      staleTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
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

    // Composer capabilities gate composer affordances on ChatView mount; the query
    // has staleTime Infinity, so this costs one IPC per provider per session.
    void queryClient.prefetchQuery({
      ...providerComposerCapabilitiesQueryOptions(provider),
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
    }),
    retry: 0,
    staleTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
    gcTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
  });
  void queryClient.prefetchQuery({
    ...providerComposerCapabilitiesQueryOptions("droid"),
    gcTime: NEW_THREAD_MODEL_PREFETCH_STALE_TIME_MS,
  });
}

/**
 * Warm every visible provider for the next new thread: the selected provider
 * first, hidden/disabled providers skipped, Droid only on explicit intent.
 */
export function prefetchModelsForNewThread(
  queryClient: QueryClient,
  input: {
    settings: ProviderModelPrefetchSettings;
    serverSettings?: ServerSettings | null;
    hiddenProviders?: ReadonlyArray<ProviderKind>;
    providerOverride?: ProviderKind | null;
    draftActiveProvider?: ProviderKind | null;
    stickyActiveProvider?: ProviderKind | null;
    projectDefaultProvider?: ProviderKind | null;
    projectCwd?: string | null;
    draftWorktreePath?: string | null;
    serverCwd?: string | null;
    includeDroid?: boolean;
  },
): void {
  const selectedProvider = resolveNewThreadModelPrefetchProvider({
    providerOverride: input.providerOverride,
    draftActiveProvider: input.draftActiveProvider,
    stickyActiveProvider: input.stickyActiveProvider,
    projectDefaultProvider: input.projectDefaultProvider,
    defaultProvider: input.settings.defaultProvider,
  });
  const cwd = resolveNewThreadModelPrefetchCwd({
    draftWorktreePath: input.draftWorktreePath,
    projectCwd: input.projectCwd,
    serverCwd: input.serverCwd,
  });
  const hiddenProviderSet = new Set(input.hiddenProviders ?? []);
  const isProviderWarmable = (provider: ProviderKind): boolean =>
    !hiddenProviderSet.has(provider) &&
    input.serverSettings?.providers[provider]?.enabled !== false;
  const providers = NEW_THREAD_MODEL_PREFETCH_PROVIDERS.filter(isProviderWarmable);
  const orderedProviders =
    selectedProvider === "droid" || !isProviderWarmable(selectedProvider)
      ? providers
      : [selectedProvider, ...providers.filter((provider) => provider !== selectedProvider)];

  prefetchProviderModelsForNewThread(queryClient, {
    settings: input.settings,
    cwd,
    providers: orderedProviders,
  });

  if (input.includeDroid === true && selectedProvider === "droid" && isProviderWarmable("droid")) {
    prefetchDroidModelsForNewThread(queryClient, { settings: input.settings, cwd });
  }
}
