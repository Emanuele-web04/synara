import {
  ThreadId,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { normalizeModelSlug } from "@synara/shared/model";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { resolveUnsentComposerProvider } from "~/lib/providerAvailability";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import {
  hasReconciledServerProviderStatuses,
  serverConfigQueryOptions,
} from "~/lib/serverReactQuery";
import type { AppSettings } from "../../appSettings";
import {
  getProviderInstanceOptions,
  getProviderStartOptions,
  mergeProviderStartOptions,
  resolveSelectableProviderInstanceId,
} from "../../appSettings";
import {
  providerInstanceModelSelectionKey,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";
import { buildSearchableModelOptions } from "../../hooks/useComposerCommandMenuItems";
import { useProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import { buildModelSelection } from "../../providerModelOptions";
import type { Project } from "../../types";
import { type Thread } from "../../types";
import {
  shouldShowComposerModelBootstrapSkeleton,
  threadHasProviderLockingActivity,
} from "../ChatView.logic";
import { getComposerProviderState } from "./composerProviderRegistry";
import { resolveRuntimeModelDescriptor } from "./runtimeModelCapabilities";
const EMPTY_PROVIDER_STATUSES: ServerProviderStatus[] = [];
interface ChatProviderModelsInput {
  threadId: ThreadId;
  activeThread: Thread | undefined;
  activeProject: Project | undefined;
  composerDraft: ReturnType<typeof useComposerThreadDraft>;
  settings: AppSettings;
  resolvedThreadWorktreePath: string | null;
  // The picker may leave the thread's provider: picking another one hands the
  // thread off to it in place when the next message is sent.
  allowProviderHandoff?: boolean;
}

export function useChatProviderModels({
  threadId,
  activeThread,
  activeProject,
  composerDraft,
  settings,
  resolvedThreadWorktreePath,
  allowProviderHandoff,
}: ChatProviderModelsInput) {
  const queryClient = useQueryClient();
  const prompt = composerDraft.prompt;
  const sessionProvider = activeThread?.session?.provider ?? null;
  const providerInstances = useMemo(() => getProviderInstanceOptions(settings), [settings]);
  const selectedProviderInstanceIdByThreadId = composerDraft.activeProvider ?? null;
  const selectedProviderByThreadId = selectedProviderInstanceIdByThreadId
    ? (composerDraft.modelSelectionByProvider[selectedProviderInstanceIdByThreadId]?.provider ??
      providerInstances.find(
        (instance) => instance.instanceId === selectedProviderInstanceIdByThreadId,
      )?.provider ??
      null)
    : null;
  const threadProvider =
    activeThread?.modelSelection.provider ?? activeProject?.defaultModelSelection?.provider ?? null;
  const hasThreadStarted = Boolean(
    activeThread &&
    (activeThread.latestTurn !== null ||
      activeThread.messages.length > 0 ||
      activeThread.session !== null),
  );
  // Side chats import source history as fork-import rows. Those imports must not lock the
  // provider picker before the Side produces its first native turn (#810).
  const hasProviderLockingActivity = Boolean(
    activeThread && threadHasProviderLockingActivity(activeThread),
  );
  // The provider the thread's conversation runs on.
  const boundProvider: ProviderKind | null = hasProviderLockingActivity
    ? (sessionProvider ?? threadProvider ?? selectedProviderByThreadId ?? null)
    : null;
  const boundProviderInstanceId: ProviderInstanceId | null =
    boundProvider === null
      ? null
      : ((activeThread?.session?.provider === boundProvider
          ? activeThread.session.providerInstanceId
          : undefined) ??
        (activeThread?.modelSelection.provider === boundProvider
          ? activeThread.modelSelection.instanceId
          : undefined) ??
        boundProvider);
  // A provider explicitly picked over the bound one is a pending handoff.
  const handoffProvider: ProviderKind | null =
    allowProviderHandoff === true &&
    boundProvider !== null &&
    selectedProviderByThreadId !== null &&
    selectedProviderByThreadId !== boundProvider
      ? selectedProviderByThreadId
      : null;
  const lockedProvider: ProviderKind | null = allowProviderHandoff === true ? null : boundProvider;
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const localProviderStatuses = useProviderStatusesForLocalConfig();
  const providerStatusesReconciled = hasReconciledServerProviderStatuses(queryClient);
  const selectedProvider = useMemo<ProviderKind>(
    () =>
      handoffProvider ??
      boundProvider ??
      resolveUnsentComposerProvider({
        explicitProvider: selectedProviderByThreadId,
        threadProvider,
        defaultProvider: settings.defaultProvider,
        statuses: providerStatusesReconciled ? localProviderStatuses : EMPTY_PROVIDER_STATUSES,
        providerOrder: settings.providerOrder,
        hiddenProviders: settings.hiddenProviders,
      }),
    [
      boundProvider,
      handoffProvider,
      localProviderStatuses,
      providerStatusesReconciled,
      selectedProviderByThreadId,
      settings.defaultProvider,
      settings.hiddenProviders,
      settings.providerOrder,
      threadProvider,
    ],
  );
  const sessionInstanceId =
    activeThread?.session?.provider === selectedProvider
      ? activeThread.session.providerInstanceId
      : undefined;
  let candidateInstanceId: ProviderInstanceId | undefined =
    selectedProviderByThreadId === selectedProvider
      ? (selectedProviderInstanceIdByThreadId ?? undefined)
      : undefined;
  const draftSelection = candidateInstanceId
    ? composerDraft.modelSelectionByProvider[candidateInstanceId]
    : undefined;
  if (draftSelection?.provider === selectedProvider && draftSelection.instanceId) {
    candidateInstanceId = draftSelection.instanceId;
  }
  if (
    !candidateInstanceId &&
    activeThread?.modelSelection.provider === selectedProvider &&
    activeThread.modelSelection.instanceId
  ) {
    candidateInstanceId = activeThread.modelSelection.instanceId;
  }
  if (
    !candidateInstanceId &&
    activeProject?.defaultModelSelection?.provider === selectedProvider &&
    activeProject.defaultModelSelection.instanceId
  ) {
    candidateInstanceId = activeProject.defaultModelSelection.instanceId;
  }
  const selectedProviderInstanceId =
    sessionInstanceId ??
    resolveSelectableProviderInstanceId(settings, selectedProvider, candidateInstanceId);

  const composerModelHintByProvider = useMemo<Record<ProviderKind, string | null>>(() => {
    const threadModelSelection = activeThread?.modelSelection ?? null;
    const projectModelSelection = activeProject?.defaultModelSelection ?? null;
    const draftSelections = composerDraft.modelSelectionByProvider;

    const resolveHint = (provider: ProviderKind): string | null => {
      const draftSelection =
        draftSelections[
          providerInstanceModelSelectionKey(
            provider,
            provider === selectedProvider ? selectedProviderInstanceId : provider,
          )
        ] ??
        (provider === selectedProvider
          ? undefined
          : Object.values(draftSelections).find((selection) => selection?.provider === provider));
      return (
        draftSelection?.model ??
        (threadModelSelection?.provider === provider ? threadModelSelection.model : null) ??
        (projectModelSelection?.provider === provider ? projectModelSelection.model : null)
      );
    };

    return {
      codex: resolveHint("codex"),
      claudeAgent: resolveHint("claudeAgent"),
      cursor: resolveHint("cursor"),
      antigravity: resolveHint("antigravity"),
      grok: resolveHint("grok"),
      droid: resolveHint("droid"),
      opencode: resolveHint("opencode"),
      pi: resolveHint("pi"),
      devin: resolveHint("devin"),
      omp: resolveHint("omp"),
      external: resolveHint("external"),
    };
  }, [
    activeProject?.defaultModelSelection,
    activeThread?.modelSelection,
    composerDraft.modelSelectionByProvider,
    selectedProvider,
    selectedProviderInstanceId,
  ]);
  const providerModelDiscoveryCwd = resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: resolvedThreadWorktreePath,
    activeProjectCwd: activeProject?.cwd ?? null,
    serverCwd: serverConfigQuery.data?.cwd ?? null,
  });
  const {
    customModelsByProvider,
    modelOptionsByProvider,
    modelOptionsByProviderInstance,
    loadingModelProviders,
    refreshModels,
    discoveryErrorsByProvider,
    runtimeModelsByProvider,
    runtimeModelsByProviderInstance,
    selectedRuntimeAgents: dynamicAgents,
    selectedProviderModelsLoading,
    selectedProviderRuntimeModelDiscoveryPending,
  } = useProviderModelCatalog({
    selectedProvider,
    selectedProviderInstanceId,
    // Browsing a provider tab requests just that account through refreshModels.
    discoveryEnabled: false,
    cwd: providerModelDiscoveryCwd,
    modelHintByProvider: composerModelHintByProvider,
    agentDiscoveryPolicy: "eager-core",
  });
  const selectedInstanceModelOptionsByProvider = useMemo(
    () => ({
      ...modelOptionsByProvider,
      [selectedProvider]:
        modelOptionsByProviderInstance[selectedProviderInstanceId] ??
        modelOptionsByProvider[selectedProvider],
    }),
    [
      modelOptionsByProvider,
      modelOptionsByProviderInstance,
      selectedProvider,
      selectedProviderInstanceId,
    ],
  );
  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId,
    selectedProvider,
    selectedProviderInstanceId,
    threadModelSelection: activeThread?.modelSelection,
    projectModelSelection: activeProject?.defaultModelSelection,
    customModelsByProvider,
    availableModelOptionsByProvider: selectedInstanceModelOptionsByProvider,
  });
  const draftModelSelectionForSelectedProvider =
    composerDraft.modelSelectionByProvider[
      providerInstanceModelSelectionKey(selectedProvider, selectedProviderInstanceId)
    ] ?? null;
  const persistedClaudeSupportsAutoMode =
    selectedProvider === "claudeAgent"
      ? draftModelSelectionForSelectedProvider?.provider === "claudeAgent" &&
        draftModelSelectionForSelectedProvider.model === selectedModel
        ? draftModelSelectionForSelectedProvider.supportsAutoMode
        : activeThread?.modelSelection.provider === "claudeAgent" &&
            activeThread.modelSelection.model === selectedModel
          ? activeThread.modelSelection.supportsAutoMode
          : undefined
      : undefined;
  const selectedRuntimeModel = useMemo(() => {
    const discovered = resolveRuntimeModelDescriptor({
      provider: selectedProvider,
      model: selectedModel,
      runtimeModels: runtimeModelsByProvider[selectedProvider],
    });
    if (discovered) {
      return discovered;
    }
    return selectedProvider === "claudeAgent" &&
      typeof persistedClaudeSupportsAutoMode === "boolean"
      ? {
          slug: selectedModel,
          name: selectedModel,
          supportsAutoMode: persistedClaudeSupportsAutoMode,
        }
      : undefined;
  }, [persistedClaudeSupportsAutoMode, runtimeModelsByProvider, selectedModel, selectedProvider]);
  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        runtimeModel: selectedRuntimeModel,
        prompt,
        modelOptions: composerModelOptions,
      }),
    [composerModelOptions, prompt, selectedModel, selectedProvider, selectedRuntimeModel],
  );
  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const selectedModelSelection = useMemo<ModelSelection>(() => {
    if (selectedProvider === "external") {
      const pinned = [
        draftModelSelectionForSelectedProvider,
        activeThread?.modelSelection,
        activeProject?.defaultModelSelection,
      ].find((selection) => selection?.provider === "external");
      if (!pinned)
        throw new Error("This external agent selection is missing its profile revision.");
      return pinned;
    }
    if (
      (selectedProvider === "pi" || selectedProvider === "omp") &&
      draftModelSelectionForSelectedProvider?.provider === selectedProvider
    ) {
      return buildModelSelection(
        selectedProvider,
        draftModelSelectionForSelectedProvider.model,
        selectedModelOptionsForDispatch ?? draftModelSelectionForSelectedProvider.options,
        { instanceId: selectedProviderInstanceId },
      );
    }
    return buildModelSelection(
      selectedProvider,
      selectedModel,
      selectedModelOptionsForDispatch,
      selectedProvider === "claudeAgent" ? selectedRuntimeModel?.supportsAutoMode : undefined,
      { instanceId: selectedProviderInstanceId },
    );
  }, [
    activeThread?.modelSelection,
    activeProject?.defaultModelSelection,
    draftModelSelectionForSelectedProvider,
    selectedModel,
    selectedModelOptionsForDispatch,
    selectedProvider,
    selectedProviderInstanceId,
    selectedRuntimeModel,
  ]);
  const providerOptionsForDispatch = useMemo(
    // A seeded overlay (group worker routing) sits on top of the user's own
    // start options instead of replacing them wholesale, so a send on any
    // provider the user picks still dispatches their configured options.
    () =>
      mergeProviderStartOptions(
        getProviderStartOptions(settings, selectedProviderInstanceId),
        composerDraft.providerOptionsForDispatch,
      ),
    [composerDraft.providerOptionsForDispatch, selectedProviderInstanceId, settings],
  );
  const selectedModelForPicker =
    selectedModelSelection.provider === selectedProvider
      ? selectedModelSelection.model
      : selectedModel;
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions =
      modelOptionsByProviderInstance[selectedProviderInstanceId] ??
      modelOptionsByProvider[selectedProvider];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [
    modelOptionsByProvider,
    modelOptionsByProviderInstance,
    selectedModelForPicker,
    selectedProvider,
    selectedProviderInstanceId,
  ]);
  const persistedComposerModelSelection =
    sessionProvider && activeThread?.modelSelection.provider !== sessionProvider
      ? activeProject?.defaultModelSelection?.provider === selectedProvider
        ? activeProject.defaultModelSelection
        : null
      : activeThread?.modelSelection.provider === selectedProvider
        ? activeThread.modelSelection
        : activeProject?.defaultModelSelection?.provider === selectedProvider
          ? activeProject.defaultModelSelection
          : null;
  const providerModelsLoading = selectedProviderModelsLoading;
  const selectedProviderRequiresRuntimeModels =
    selectedProvider === "cursor" ||
    selectedProvider === "antigravity" ||
    selectedProvider === "droid" ||
    selectedProvider === "opencode" ||
    selectedProvider === "pi" ||
    selectedProvider === "devin" ||
    selectedProvider === "omp";
  const showComposerModelBootstrapSkeleton = shouldShowComposerModelBootstrapSkeleton({
    selectedProvider,
    selectedModel,
    persistedModelSelection: persistedComposerModelSelection,
    draftModelSelection: draftModelSelectionForSelectedProvider,
    providerModelsLoading,
    requiresDiscoveredModels: selectedProviderRequiresRuntimeModels,
  });
  const searchableModelOptions = useMemo(
    () =>
      buildSearchableModelOptions({
        providerOptions: providerInstances
          // Search mirrors the picker: disabled instances are not actionable,
          // and a started thread is locked to its exact provider instance.
          .filter(
            (instance) =>
              instance.enabled &&
              (lockedProvider === null || instance.instanceId === selectedProviderInstanceId) &&
              // A handoff can change the provider, not the bound provider's account.
              (boundProvider === null ||
                instance.provider !== boundProvider ||
                instance.instanceId === boundProviderInstanceId),
          )
          .map((instance) => ({
            value: instance.provider,
            label: instance.label,
            instanceId: instance.instanceId,
          })),
        modelOptionsByProvider,
        modelOptionsByProviderInstance,
        providerOrder: settings.providerOrder,
        hiddenProviders: settings.hiddenProviders,
        protectedProviders: [selectedProvider],
        lockedProvider,
      }),
    [
      boundProvider,
      boundProviderInstanceId,
      lockedProvider,
      modelOptionsByProvider,
      modelOptionsByProviderInstance,
      providerInstances,
      selectedProvider,
      selectedProviderInstanceId,
      settings.hiddenProviders,
      settings.providerOrder,
    ],
  );
  return {
    hasThreadStarted,
    lockedProvider,
    boundProvider,
    boundProviderInstanceId,
    serverConfigQuery,
    selectedProvider,
    providerInstances,
    selectedProviderInstanceId,
    providerModelDiscoveryCwd,
    customModelsByProvider,
    modelOptionsByProvider,
    modelOptionsByProviderInstance,
    loadingModelProviders,
    refreshModels,
    discoveryErrorsByProvider,
    runtimeModelsByProvider,
    runtimeModelsByProviderInstance,
    dynamicAgents,
    selectedProviderRuntimeModelDiscoveryPending,
    composerModelOptions,
    selectedModel,
    selectedRuntimeModel,
    composerProviderState,
    selectedPromptEffort,
    selectedModelSelection,
    providerOptionsForDispatch,
    selectedModelForPickerWithCustomFallback,
    showComposerModelBootstrapSkeleton,
    searchableModelOptions,
  };
}
