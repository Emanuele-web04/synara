import type {
  ProviderAgentDescriptor,
  ProviderKind,
  ProviderModelDescriptor,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { getAppModelOptions, getCustomModelsByProvider, useAppSettings } from "../appSettings";
import { resolveRuntimeModelDescriptor } from "../components/chat/runtimeModelCapabilities";
import { collapseCursorModelVariants } from "../cursorModelVariants";
import {
  isInitialModelDiscoveryPending,
  prioritizeProviderModelDiscovery,
  providerAgentsQueryOptions,
  providerDiscoveryQueryKeys,
  providerModelsQueryOptions,
} from "../lib/providerDiscoveryReactQuery";
import { mergeDynamicModelOptions, type ProviderModelOption } from "../providerModelOptions";

export interface ProviderModelCatalog {
  customModelsByProvider: ReturnType<typeof getCustomModelsByProvider>;
  modelOptionsByProvider: Record<
    ProviderKind,
    ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>
  >;
  loadingModelProviders: Partial<Record<ProviderKind, boolean>>;
  // trait controls (effort, fast mode, thinking, context window) come from runtime descriptors for cursor/codex/etc — effort-picker surfaces must feed them through
  runtimeModelsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelDescriptor>>;
  selectedRuntimeModel: ProviderModelDescriptor | undefined;
  selectedRuntimeAgents: ReadonlyArray<ProviderAgentDescriptor>;
  selectedProviderModelsLoading: boolean;
  selectedProviderRuntimeModelDiscoveryPending: boolean;
  discoveryErrorsByProvider: Partial<Record<ProviderKind, string | undefined>>;
}

const EMPTY_PROVIDER_AGENTS: ReadonlyArray<ProviderAgentDescriptor> = [];

function modelDiscoveryError(
  resultError: string | undefined,
  queryError: unknown,
): string | undefined {
  if (resultError) {
    return resultError;
  }
  if (queryError instanceof Error) {
    return queryError.message;
  }
  return typeof queryError === "string" ? queryError : undefined;
}

export function useProviderModelCatalog(input: {
  selectedProvider: ProviderKind;
  // pass the picker's open state so on-demand providers' lists are warm before the user browses them
  discoveryEnabled: boolean;
  cwd?: string | null;
  modelHintByProvider?: Partial<Record<ProviderKind, string | null>>;
  // restrict background discovery to the providers a non-picker surface actually uses
  prefetchProviders?: ReadonlyArray<ProviderKind>;
  agentDiscoveryPolicy?: "selected" | "eager-core";
}): ProviderModelCatalog {
  const { selectedProvider, discoveryEnabled, modelHintByProvider } = input;
  const agentDiscoveryPolicy = input.agentDiscoveryPolicy ?? "selected";
  const discoveryCwd = input.cwd ?? null;
  const { settings, serverSettings } = useAppSettings();
  const customModelsByProvider = useMemo(() => getCustomModelsByProvider(settings), [settings]);
  const hiddenProviderSet = useMemo(
    () => new Set<ProviderKind>(settings.hiddenProviders),
    [settings.hiddenProviders],
  );
  const prefetchProviderSet = useMemo(
    () =>
      input.prefetchProviders === undefined ? null : new Set<ProviderKind>(input.prefetchProviders),
    [input.prefetchProviders],
  );
  const shouldDiscoverProvider = (
    provider: ProviderKind,
    prefetchRequested = discoveryEnabled,
  ): boolean => {
    // the enabled flag is a short-circuit, not a precondition: serverSettings stays undefined on failure and never refetches — treating that as disabled would silence all discovery ("my model disappeared"); mirrors the server-side fallback
    if (serverSettings?.providers[provider]?.enabled === false) {
      return false;
    }
    if (provider === selectedProvider) {
      return true;
    }
    if (!prefetchRequested) {
      return false;
    }
    return prefetchProviderSet?.has(provider) ?? !hiddenProviderSet.has(provider);
  };

  const claudeModelDiscoveryEnabled = shouldDiscoverProvider("claudeAgent");
  const codexModelDiscoveryEnabled = shouldDiscoverProvider("codex");
  const cursorModelDiscoveryEnabled = shouldDiscoverProvider("cursor");
  const antigravityModelDiscoveryEnabled = shouldDiscoverProvider("antigravity");
  const grokModelDiscoveryEnabled = shouldDiscoverProvider("grok");
  const droidPrefetchRequested = discoveryEnabled && (prefetchProviderSet?.has("droid") ?? false);
  const droidModelDiscoveryEnabled = shouldDiscoverProvider("droid", droidPrefetchRequested);
  const openCodeModelDiscoveryEnabled = shouldDiscoverProvider("opencode");
  const piModelDiscoveryEnabled = shouldDiscoverProvider("pi");
  const devinModelDiscoveryEnabled = shouldDiscoverProvider("devin");

  const modelQueryOptionsByProvider = {
    claudeAgent: providerModelsQueryOptions({
      provider: "claudeAgent",
      binaryPath: settings.claudeBinaryPath || null,
      enabled: claudeModelDiscoveryEnabled,
    }),
    codex: providerModelsQueryOptions({
      provider: "codex",
      enabled: codexModelDiscoveryEnabled,
    }),
    cursor: providerModelsQueryOptions({
      provider: "cursor",
      binaryPath: settings.cursorBinaryPath || null,
      apiEndpoint: settings.cursorApiEndpoint || null,
      enabled: cursorModelDiscoveryEnabled,
    }),
    antigravity: providerModelsQueryOptions({
      provider: "antigravity",
      binaryPath: settings.antigravityBinaryPath || null,
      cwd: discoveryCwd,
      enabled: antigravityModelDiscoveryEnabled,
    }),
    grok: providerModelsQueryOptions({
      provider: "grok",
      binaryPath: settings.grokBinaryPath || null,
      enabled: grokModelDiscoveryEnabled,
    }),
    droid: providerModelsQueryOptions({
      provider: "droid",
      binaryPath: settings.droidBinaryPath || null,
      cwd: discoveryCwd,
      // Droid probes every model through a disposable ACP session — keep it provider-scoped, never warm it from unrelated picker/settings UI
      enabled: droidModelDiscoveryEnabled,
    }),
    opencode: providerModelsQueryOptions({
      provider: "opencode",
      binaryPath: settings.openCodeBinaryPath || null,
      cwd: discoveryCwd,
      enabled: openCodeModelDiscoveryEnabled,
    }),
    pi: providerModelsQueryOptions({
      provider: "pi",
      binaryPath: settings.piBinaryPath || null,
      agentDir: settings.piAgentDir || null,
      cwd: discoveryCwd,
      enabled: piModelDiscoveryEnabled,
    }),
    devin: providerModelsQueryOptions({
      provider: "devin",
      binaryPath: settings.devinBinaryPath || null,
      cwd: discoveryCwd,
      enabled: devinModelDiscoveryEnabled,
    }),
  } as const;

  const claudeDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.claudeAgent);
  const codexDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.codex);
  const cursorDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.cursor);
  const antigravityModelsQuery = useQuery(modelQueryOptionsByProvider.antigravity);
  const grokDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.grok);
  const droidDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.droid);
  const openCodeDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.opencode);
  const piDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.pi);
  const devinDynamicModelsQuery = useQuery(modelQueryOptionsByProvider.devin);

  const [, , modelProvider, modelBinaryPath, modelApiEndpoint, modelAgentDir, modelCwd] =
    modelQueryOptionsByProvider[selectedProvider].queryKey;
  const selectedProviderModelsQueryKey = useMemo(
    () =>
      providerDiscoveryQueryKeys.models(
        modelProvider,
        modelBinaryPath,
        modelApiEndpoint,
        modelAgentDir,
        modelCwd,
      ),
    [modelProvider, modelBinaryPath, modelApiEndpoint, modelAgentDir, modelCwd],
  );

  const selectedProviderModelsEnabled = modelQueryOptionsByProvider[selectedProvider].enabled;

  // keep foreground ownership out of queryFn options — retries can outlive the selection that started them
  useEffect(() => {
    if (!selectedProviderModelsEnabled) return;
    return prioritizeProviderModelDiscovery(selectedProviderModelsQueryKey);
  }, [selectedProviderModelsQueryKey, selectedProviderModelsEnabled]);

  const claudeDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({
      provider: "claudeAgent",
      enabled: shouldDiscoverProvider("claudeAgent", agentDiscoveryPolicy === "eager-core"),
    }),
  );
  const codexDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({
      provider: "codex",
      enabled: shouldDiscoverProvider("codex", agentDiscoveryPolicy === "eager-core"),
    }),
  );
  const openCodeDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({
      provider: "opencode",
      binaryPath: settings.openCodeBinaryPath || null,
      cwd: discoveryCwd,
      enabled: openCodeModelDiscoveryEnabled,
    }),
  );

  const cursorRuntimeModels = useMemo(
    () => collapseCursorModelVariants(cursorDynamicModelsQuery.data?.models ?? []),
    [cursorDynamicModelsQuery.data?.models],
  );

  const hasResolvedCursorModelDiscovery =
    (cursorDynamicModelsQuery.data?.source === "cursor.cli" ||
      cursorDynamicModelsQuery.data?.source === "cursor.acp") &&
    (cursorDynamicModelsQuery.data.models.length ?? 0) > 0;
  const cursorModelDiscoveryPending =
    cursorModelDiscoveryEnabled &&
    !hasResolvedCursorModelDiscovery &&
    isInitialModelDiscoveryPending(cursorDynamicModelsQuery);
  const hasResolvedDroidModelDiscovery =
    droidDynamicModelsQuery.data?.source === "droid-acp" &&
    (droidDynamicModelsQuery.data.models.length ?? 0) > 0;
  const droidModelDiscoveryPending =
    droidModelDiscoveryEnabled &&
    !hasResolvedDroidModelDiscovery &&
    isInitialModelDiscoveryPending(droidDynamicModelsQuery);
  const hasResolvedOpenCodeModelDiscovery =
    (openCodeDynamicModelsQuery.data?.source === "opencode-cli" ||
      openCodeDynamicModelsQuery.data?.source === "opencode") &&
    (openCodeDynamicModelsQuery.data.models.length ?? 0) > 0;
  const openCodeModelDiscoveryPending =
    openCodeModelDiscoveryEnabled &&
    !hasResolvedOpenCodeModelDiscovery &&
    isInitialModelDiscoveryPending(openCodeDynamicModelsQuery);
  const hasResolvedPiModelDiscovery =
    piDynamicModelsQuery.data?.source?.startsWith("pi.sdk") === true &&
    (piDynamicModelsQuery.data.models.length ?? 0) > 0;
  const piModelDiscoveryPending =
    piModelDiscoveryEnabled &&
    !hasResolvedPiModelDiscovery &&
    isInitialModelDiscoveryPending(piDynamicModelsQuery);
  const hasResolvedDevinModelDiscovery =
    (devinDynamicModelsQuery.data?.source === "devin-cli" ||
      // static fallback descriptors are a valid resolved catalog — the adapter serves its built-in matrix when CLI discovery is unavailable, so render them instead of spinning forever
      devinDynamicModelsQuery.data?.source === "devin.static") &&
    (devinDynamicModelsQuery.data.models.length ?? 0) > 0;
  const devinModelDiscoveryPending =
    devinModelDiscoveryEnabled &&
    !hasResolvedDevinModelDiscovery &&
    isInitialModelDiscoveryPending(devinDynamicModelsQuery);
  const antigravityModelDiscoveryPending =
    antigravityModelDiscoveryEnabled &&
    !(
      antigravityModelsQuery.data?.source === "antigravity.cli" &&
      (antigravityModelsQuery.data.models.length ?? 0) > 0
    ) &&
    isInitialModelDiscoveryPending(antigravityModelsQuery);

  const modelOptionsByProvider = useMemo(() => {
    const staticOptions: Record<ProviderKind, ReturnType<typeof getAppModelOptions>> = {
      codex: getAppModelOptions("codex", customModelsByProvider.codex, modelHintByProvider?.codex),
      claudeAgent: getAppModelOptions(
        "claudeAgent",
        customModelsByProvider.claudeAgent,
        modelHintByProvider?.claudeAgent,
      ),
      cursor: getAppModelOptions(
        "cursor",
        customModelsByProvider.cursor,
        modelHintByProvider?.cursor,
      ),
      antigravity: getAppModelOptions(
        "antigravity",
        customModelsByProvider.antigravity,
        modelHintByProvider?.antigravity,
      ),
      grok: getAppModelOptions("grok", customModelsByProvider.grok, modelHintByProvider?.grok),
      droid: getAppModelOptions("droid", customModelsByProvider.droid, modelHintByProvider?.droid),
      opencode: getAppModelOptions(
        "opencode",
        customModelsByProvider.opencode,
        modelHintByProvider?.opencode,
      ),
      pi: getAppModelOptions("pi", customModelsByProvider.pi, modelHintByProvider?.pi),
      devin: getAppModelOptions("devin", customModelsByProvider.devin, modelHintByProvider?.devin),
    };
    const result: Record<
      ProviderKind,
      ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>
    > = { ...staticOptions };
    const dynamicSources: Record<ProviderKind, typeof claudeDynamicModelsQuery.data> = {
      claudeAgent: claudeDynamicModelsQuery.data,
      codex: codexDynamicModelsQuery.data,
      cursor:
        cursorDynamicModelsQuery.data === undefined
          ? undefined
          : { ...cursorDynamicModelsQuery.data, models: cursorRuntimeModels },
      antigravity: antigravityModelsQuery.data,
      grok: grokDynamicModelsQuery.data,
      droid: droidDynamicModelsQuery.data,
      opencode: openCodeDynamicModelsQuery.data,
      pi: piDynamicModelsQuery.data,
      devin: devinDynamicModelsQuery.data,
    };
    for (const provider of [
      "claudeAgent",
      "codex",
      "cursor",
      "antigravity",
      "grok",
      "droid",
      "opencode",
      "pi",
      "devin",
    ] as const) {
      const discovery = dynamicSources[provider];
      const dynamicModels = discovery?.models;
      const hasCodexCatalog =
        provider === "codex" &&
        discovery?.source === "codex-app-server" &&
        discovery.error === undefined;
      if (dynamicModels && (dynamicModels.length > 0 || hasCodexCatalog)) {
        result[provider] = mergeDynamicModelOptions({
          provider,
          staticOptions: staticOptions[provider],
          dynamicModels,
        });
      }
    }
    return result;
  }, [
    antigravityModelsQuery.data,
    claudeDynamicModelsQuery.data,
    codexDynamicModelsQuery.data,
    cursorDynamicModelsQuery.data,
    cursorRuntimeModels,
    customModelsByProvider,
    droidDynamicModelsQuery.data,
    grokDynamicModelsQuery.data,
    modelHintByProvider,
    openCodeDynamicModelsQuery.data,
    piDynamicModelsQuery.data,
    devinDynamicModelsQuery.data,
  ]);

  const loadingModelProviders = useMemo<Partial<Record<ProviderKind, boolean>>>(
    () => ({
      antigravity: antigravityModelDiscoveryPending,
      cursor: cursorModelDiscoveryPending,
      droid: droidModelDiscoveryPending,
      opencode: openCodeModelDiscoveryPending,
      pi: piModelDiscoveryPending,
      devin: devinModelDiscoveryPending,
    }),
    [
      antigravityModelDiscoveryPending,
      cursorModelDiscoveryPending,
      droidModelDiscoveryPending,
      openCodeModelDiscoveryPending,
      piModelDiscoveryPending,
      devinModelDiscoveryPending,
    ],
  );

  const runtimeModelsByProvider = useMemo<
    Record<ProviderKind, ReadonlyArray<ProviderModelDescriptor>>
  >(
    () => ({
      claudeAgent: claudeDynamicModelsQuery.data?.models ?? [],
      codex: codexDynamicModelsQuery.data?.models ?? [],
      cursor: cursorRuntimeModels,
      antigravity: antigravityModelsQuery.data?.models ?? [],
      grok: grokDynamicModelsQuery.data?.models ?? [],
      droid: droidDynamicModelsQuery.data?.models ?? [],
      opencode: openCodeDynamicModelsQuery.data?.models ?? [],
      pi: piDynamicModelsQuery.data?.models ?? [],
      devin: devinDynamicModelsQuery.data?.models ?? [],
    }),
    [
      antigravityModelsQuery.data?.models,
      claudeDynamicModelsQuery.data?.models,
      codexDynamicModelsQuery.data?.models,
      cursorRuntimeModels,
      droidDynamicModelsQuery.data?.models,
      grokDynamicModelsQuery.data?.models,
      openCodeDynamicModelsQuery.data?.models,
      piDynamicModelsQuery.data?.models,
      devinDynamicModelsQuery.data?.models,
    ],
  );

  const selectedRuntimeModel = useMemo(
    () =>
      resolveRuntimeModelDescriptor({
        provider: selectedProvider,
        model: modelHintByProvider?.[selectedProvider] ?? null,
        runtimeModels: runtimeModelsByProvider[selectedProvider],
      }),
    [modelHintByProvider, runtimeModelsByProvider, selectedProvider],
  );

  const selectedDynamicAgents =
    selectedProvider === "claudeAgent"
      ? (claudeDynamicAgentsQuery.data?.agents ?? EMPTY_PROVIDER_AGENTS)
      : selectedProvider === "opencode"
        ? (openCodeDynamicAgentsQuery.data?.agents ?? EMPTY_PROVIDER_AGENTS)
        : (codexDynamicAgentsQuery.data?.agents ?? EMPTY_PROVIDER_AGENTS);
  const selectedRuntimeAgents = useMemo<ReadonlyArray<ProviderAgentDescriptor>>(
    () =>
      selectedDynamicAgents.map((agent) =>
        agent.description
          ? { name: agent.name, displayName: agent.displayName, description: agent.description }
          : { name: agent.name, displayName: agent.displayName },
      ),
    [selectedDynamicAgents],
  );

  const discoveryErrorsByProvider = useMemo(
    () => ({
      claudeAgent: claudeDynamicModelsQuery.data?.error,
      codex: codexDynamicModelsQuery.data?.error,
      cursor: modelDiscoveryError(
        cursorDynamicModelsQuery.data?.error,
        cursorDynamicModelsQuery.error,
      ),
      devin: modelDiscoveryError(
        devinDynamicModelsQuery.data?.error,
        devinDynamicModelsQuery.error,
      ),
      antigravity: modelDiscoveryError(
        antigravityModelsQuery.data?.error,
        antigravityModelsQuery.error,
      ),
      grok: modelDiscoveryError(grokDynamicModelsQuery.data?.error, grokDynamicModelsQuery.error),
      droid: modelDiscoveryError(
        droidDynamicModelsQuery.data?.error,
        droidDynamicModelsQuery.error,
      ),
      opencode: modelDiscoveryError(
        openCodeDynamicModelsQuery.data?.error,
        openCodeDynamicModelsQuery.error,
      ),
      pi: modelDiscoveryError(piDynamicModelsQuery.data?.error, piDynamicModelsQuery.error),
    }),
    [
      antigravityModelsQuery.data?.error,
      antigravityModelsQuery.error,
      claudeDynamicModelsQuery.data?.error,
      codexDynamicModelsQuery.data?.error,
      cursorDynamicModelsQuery.data?.error,
      cursorDynamicModelsQuery.error,
      devinDynamicModelsQuery.data?.error,
      devinDynamicModelsQuery.error,
      droidDynamicModelsQuery.data?.error,
      droidDynamicModelsQuery.error,
      grokDynamicModelsQuery.data?.error,
      grokDynamicModelsQuery.error,
      openCodeDynamicModelsQuery.data?.error,
      openCodeDynamicModelsQuery.error,
      piDynamicModelsQuery.data?.error,
      piDynamicModelsQuery.error,
    ],
  );

  const selectedProviderRuntimeModelDiscoveryPending =
    loadingModelProviders[selectedProvider] ?? false;
  const selectedProviderModelsQuery =
    selectedProvider === "claudeAgent"
      ? claudeDynamicModelsQuery
      : selectedProvider === "codex"
        ? codexDynamicModelsQuery
        : selectedProvider === "cursor"
          ? cursorDynamicModelsQuery
          : selectedProvider === "antigravity"
            ? antigravityModelsQuery
            : selectedProvider === "grok"
              ? grokDynamicModelsQuery
              : selectedProvider === "droid"
                ? droidDynamicModelsQuery
                : selectedProvider === "opencode"
                  ? openCodeDynamicModelsQuery
                  : selectedProvider === "pi"
                    ? piDynamicModelsQuery
                    : devinDynamicModelsQuery;
  const selectedProviderModelsLoading =
    selectedProviderRuntimeModelDiscoveryPending ||
    (loadingModelProviders[selectedProvider] === undefined &&
      (selectedProviderModelsQuery.isLoading ||
        (selectedProviderModelsQuery.isFetching &&
          selectedProviderModelsQuery.data === undefined)));

  return useMemo(
    () => ({
      customModelsByProvider,
      modelOptionsByProvider,
      loadingModelProviders,
      runtimeModelsByProvider,
      selectedRuntimeModel,
      selectedRuntimeAgents,
      selectedProviderModelsLoading,
      selectedProviderRuntimeModelDiscoveryPending,
      discoveryErrorsByProvider,
    }),
    [
      customModelsByProvider,
      discoveryErrorsByProvider,
      loadingModelProviders,
      modelOptionsByProvider,
      runtimeModelsByProvider,
      selectedProviderModelsLoading,
      selectedProviderRuntimeModelDiscoveryPending,
      selectedRuntimeAgents,
      selectedRuntimeModel,
    ],
  );
}
