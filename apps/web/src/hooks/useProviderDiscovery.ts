import type { ModelSelection, ProviderKind } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { getAppModelOptions, getCustomModelsByProvider, type AppSettings } from "../appSettings";
import { collapseCursorModelVariants } from "../cursorModelVariants";
import { resolveActiveHermesProfileName } from "../lib/hermesProfile";
import { mergeDynamicModelOptions } from "../lib/mergeDynamicModelOptions";
import {
  providerAgentsQueryOptions,
  providerModelsQueryOptions,
} from "../lib/providerDiscoveryReactQuery";
import type { ProviderModelOption } from "../providerModelOptions";

type DiscoveryThread = { readonly modelSelection?: ModelSelection } | null | undefined;

export type UseProviderDiscoveryInput = {
  readonly settings: AppSettings;
  readonly selectedProvider: ProviderKind;
  readonly lockedProvider: ProviderKind | null;
  readonly isModelPickerOpen: boolean;
  readonly activeThread: DiscoveryThread;
  readonly composerModelHintByProvider: Record<ProviderKind, string | null>;
  readonly showExpandedCursorModelVariants: boolean;
  readonly draftHermesSelection: ModelSelection | null | undefined;
};

export function useProviderDiscovery(input: UseProviderDiscoveryInput) {
  const {
    settings,
    selectedProvider,
    lockedProvider,
    isModelPickerOpen,
    activeThread,
    composerModelHintByProvider,
    showExpandedCursorModelVariants,
    draftHermesSelection,
  } = input;

  const customModelsByProvider = useMemo(() => getCustomModelsByProvider(settings), [settings]);

  const discoveryEnabled = (provider: ProviderKind) =>
    selectedProvider === provider || lockedProvider === provider || isModelPickerOpen;

  const claudeDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({ provider: "claudeAgent" }),
  );
  const codexDynamicModelsQuery = useQuery(providerModelsQueryOptions({ provider: "codex" }));
  const cursorDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "cursor",
      binaryPath: settings.cursorBinaryPath || null,
      apiEndpoint: settings.cursorApiEndpoint || null,
      enabled: discoveryEnabled("cursor"),
    }),
  );
  const geminiModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "gemini",
      binaryPath: settings.geminiBinaryPath || null,
      enabled: selectedProvider === "gemini" || lockedProvider === "gemini",
    }),
  );
  const openCodeDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "opencode",
      binaryPath: settings.openCodeBinaryPath || null,
    }),
  );
  const kiloDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "kilo",
      binaryPath: settings.kiloBinaryPath || null,
      enabled: discoveryEnabled("kilo"),
    }),
  );
  const piDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "pi",
      binaryPath: settings.piBinaryPath || null,
      agentDir: settings.piAgentDir || null,
      enabled: discoveryEnabled("pi"),
    }),
  );
  const hermesDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({
      provider: "hermes",
      binaryPath: settings.hermesBinaryPath || null,
      enabled: discoveryEnabled("hermes"),
    }),
  );
  const selectedHermesProfile = useMemo(() => {
    const threadSelection =
      activeThread?.modelSelection?.provider === "hermes" ? activeThread.modelSelection : null;
    const profile =
      (draftHermesSelection?.provider === "hermes"
        ? draftHermesSelection.options?.profile
        : undefined) ??
      (threadSelection?.provider === "hermes" ? threadSelection.options?.profile : undefined);
    if (profile) {
      return profile;
    }
    return resolveActiveHermesProfileName(hermesDynamicAgentsQuery.data?.agents);
  }, [activeThread?.modelSelection, draftHermesSelection, hermesDynamicAgentsQuery.data?.agents]);
  const hermesDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "hermes",
      binaryPath: settings.hermesBinaryPath || null,
      profile: selectedHermesProfile,
      enabled: discoveryEnabled("hermes"),
    }),
  );
  const claudeDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({ provider: "claudeAgent" }),
  );
  const codexDynamicAgentsQuery = useQuery(providerAgentsQueryOptions({ provider: "codex" }));
  const openCodeDynamicAgentsQuery = useQuery(providerAgentsQueryOptions({ provider: "opencode" }));
  const kiloDynamicAgentsQuery = useQuery(providerAgentsQueryOptions({ provider: "kilo" }));

  const cursorRuntimeModels = useMemo(
    () =>
      showExpandedCursorModelVariants
        ? (cursorDynamicModelsQuery.data?.models ?? [])
        : collapseCursorModelVariants(cursorDynamicModelsQuery.data?.models ?? []),
    [cursorDynamicModelsQuery.data?.models, showExpandedCursorModelVariants],
  );

  const cursorModelDiscoveryEnabled = discoveryEnabled("cursor");
  const hasResolvedCursorModelDiscovery =
    cursorDynamicModelsQuery.data?.source === "cursor.cli" &&
    (cursorDynamicModelsQuery.data.models.length ?? 0) > 0;
  const cursorModelDiscoveryPending =
    cursorModelDiscoveryEnabled &&
    !hasResolvedCursorModelDiscovery &&
    (cursorDynamicModelsQuery.isLoading || cursorDynamicModelsQuery.isFetching);

  const kiloModelDiscoveryEnabled = discoveryEnabled("kilo");
  const hasResolvedKiloModelDiscovery =
    (kiloDynamicModelsQuery.data?.source === "kilo-cli" ||
      kiloDynamicModelsQuery.data?.source === "kilo") &&
    (kiloDynamicModelsQuery.data.models.length ?? 0) > 0;
  const kiloModelDiscoveryPending =
    kiloModelDiscoveryEnabled &&
    !hasResolvedKiloModelDiscovery &&
    (kiloDynamicModelsQuery.isLoading || kiloDynamicModelsQuery.isFetching);

  const modelOptionsByProvider = useMemo(() => {
    const staticOptions: Record<ProviderKind, ReturnType<typeof getAppModelOptions>> = {
      codex: getAppModelOptions(
        "codex",
        customModelsByProvider.codex,
        composerModelHintByProvider.codex,
      ),
      claudeAgent: getAppModelOptions(
        "claudeAgent",
        customModelsByProvider.claudeAgent,
        composerModelHintByProvider.claudeAgent,
      ),
      cursor: getAppModelOptions(
        "cursor",
        customModelsByProvider.cursor,
        composerModelHintByProvider.cursor,
      ),
      gemini: getAppModelOptions(
        "gemini",
        customModelsByProvider.gemini,
        composerModelHintByProvider.gemini,
      ),
      hermes: getAppModelOptions(
        "hermes",
        customModelsByProvider.hermes,
        composerModelHintByProvider.hermes,
      ),
      kilo: getAppModelOptions(
        "kilo",
        customModelsByProvider.kilo,
        composerModelHintByProvider.kilo,
      ),
      opencode: getAppModelOptions(
        "opencode",
        customModelsByProvider.opencode,
        composerModelHintByProvider.opencode,
      ),
      pi: getAppModelOptions("pi", customModelsByProvider.pi, composerModelHintByProvider.pi),
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
      gemini: geminiModelsQuery.data,
      hermes: hermesDynamicModelsQuery.data,
      kilo: kiloDynamicModelsQuery.data,
      opencode: openCodeDynamicModelsQuery.data,
      pi: piDynamicModelsQuery.data,
    };

    for (const provider of [
      "claudeAgent",
      "codex",
      "cursor",
      "gemini",
      "hermes",
      "kilo",
      "opencode",
      "pi",
    ] as const) {
      const dynamicModels = dynamicSources[provider]?.models;
      if (dynamicModels && dynamicModels.length > 0) {
        result[provider] = mergeDynamicModelOptions({
          provider,
          staticOptions: staticOptions[provider],
          dynamicModels: dynamicModels.map((model) => ({
            slug: model.slug,
            ...(model.name !== undefined ? { name: model.name } : {}),
            ...(model.upstreamProviderId !== undefined
              ? { upstreamProviderId: model.upstreamProviderId }
              : {}),
            ...(model.upstreamProviderName !== undefined
              ? { upstreamProviderName: model.upstreamProviderName }
              : {}),
          })),
        });
      }
    }

    return result;
  }, [
    claudeDynamicModelsQuery.data,
    composerModelHintByProvider,
    codexDynamicModelsQuery.data,
    cursorDynamicModelsQuery.data,
    cursorRuntimeModels,
    customModelsByProvider,
    geminiModelsQuery.data,
    hermesDynamicModelsQuery.data,
    kiloDynamicModelsQuery.data,
    openCodeDynamicModelsQuery.data,
    piDynamicModelsQuery.data,
  ]);

  const runtimeModelsByProvider = useMemo(
    () => ({
      claudeAgent: claudeDynamicModelsQuery.data?.models ?? [],
      codex: codexDynamicModelsQuery.data?.models ?? [],
      cursor: cursorRuntimeModels,
      gemini: geminiModelsQuery.data?.models ?? [],
      hermes: hermesDynamicModelsQuery.data?.models ?? [],
      kilo: kiloDynamicModelsQuery.data?.models ?? [],
      opencode: openCodeDynamicModelsQuery.data?.models ?? [],
      pi: piDynamicModelsQuery.data?.models ?? [],
    }),
    [
      claudeDynamicModelsQuery.data?.models,
      codexDynamicModelsQuery.data?.models,
      cursorRuntimeModels,
      geminiModelsQuery.data?.models,
      hermesDynamicModelsQuery.data?.models,
      kiloDynamicModelsQuery.data?.models,
      openCodeDynamicModelsQuery.data?.models,
      piDynamicModelsQuery.data?.models,
    ],
  );

  const providerModelsQueryByProvider = {
    claudeAgent: claudeDynamicModelsQuery,
    codex: codexDynamicModelsQuery,
    cursor: cursorDynamicModelsQuery,
    gemini: geminiModelsQuery,
    hermes: hermesDynamicModelsQuery,
    kilo: kiloDynamicModelsQuery,
    opencode: openCodeDynamicModelsQuery,
    pi: piDynamicModelsQuery,
  } as const;

  return {
    customModelsByProvider,
    selectedHermesProfile,
    hermesDynamicAgentsQuery,
    claudeDynamicAgentsQuery,
    codexDynamicAgentsQuery,
    openCodeDynamicAgentsQuery,
    kiloDynamicAgentsQuery,
    modelOptionsByProvider,
    runtimeModelsByProvider,
    providerModelsQueryByProvider,
    cursorModelDiscoveryPending,
    kiloModelDiscoveryPending,
    cursorRuntimeModels,
  };
}
