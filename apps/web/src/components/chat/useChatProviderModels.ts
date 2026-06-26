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
import { resolveAvailableProviderPreference } from "~/lib/providerAvailability";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import {
  hasReconciledServerProviderStatuses,
  serverConfigQueryOptions,
} from "~/lib/serverReactQuery";
import type { AppSettings } from "../../appSettings";
import {
  getProviderInstanceOptions,
  getProviderStartOptions,
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
  isModelPickerOpen: boolean;
  resolvedThreadWorktreePath: string | null;
}

export function useChatProviderModels({
  threadId,
  activeThread,
  activeProject,
  composerDraft,
  settings,
  isModelPickerOpen,
  resolvedThreadWorktreePath,
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
  const lockedProvider: ProviderKind | null = hasProviderLockingActivity
    ? (sessionProvider ?? threadProvider ?? selectedProviderByThreadId ?? null)
    : null;
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const localProviderStatuses = useProviderStatusesForLocalConfig();
  const preferredDraftProvider =
    selectedProviderByThreadId ?? threadProvider ?? settings.defaultProvider;
  const providerStatusesReconciled = hasReconciledServerProviderStatuses(queryClient);
  const selectedProvider = useMemo<ProviderKind>(
    () =>
      lockedProvider ??
      // Keep an unstarted draft pinned to its explicit provider; availability is validated at send time.
      selectedProviderByThreadId ??
      resolveAvailableProviderPreference({
        preferredProvider: preferredDraftProvider,
        statuses: providerStatusesReconciled ? localProviderStatuses : EMPTY_PROVIDER_STATUSES,
        providerOrder: settings.providerOrder,
        hiddenProviders: settings.hiddenProviders,
      }),
    [
      localProviderStatuses,
      lockedProvider,
      preferredDraftProvider,
      providerStatusesReconciled,
      selectedProviderByThreadId,
      settings.hiddenProviders,
      settings.providerOrder,
    ],
  );
  const selectedProviderInstanceId = useMemo<ProviderInstanceId>(() => {
    const sessionInstanceId =
      activeThread?.session?.provider === selectedProvider
        ? activeThread.session.providerInstanceId
        : undefined;
    if (sessionInstanceId) return sessionInstanceId;

    let candidateInstanceId: ProviderInstanceId | undefined =
      selectedProviderByThreadId === selectedProvider
        ? (selectedProviderInstanceIdByThreadId ?? undefined)
        : undefined;
    const draftSelection = candidateInstanceId
      ? composerDraft.modelSelectionByProvider[candidateInstanceId]
      : Object.values(composerDraft.modelSelectionByProvider).find(
          (selection) => selection?.provider === selectedProvider,
        );
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
    return resolveSelectableProviderInstanceId(settings, selectedProvider, candidateInstanceId);
  }, [
    activeProject?.defaultModelSelection,
    activeThread?.modelSelection,
    activeThread?.session?.provider,
    activeThread?.session?.providerInstanceId,
    composerDraft.modelSelectionByProvider,
    selectedProvider,
    selectedProviderByThreadId,
    selectedProviderInstanceIdByThreadId,
    settings,
  ]);

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
    discoveryErrorsByProvider,
    runtimeModelsByProvider,
    selectedRuntimeAgents: dynamicAgents,
    selectedProviderModelsLoading,
    selectedProviderRuntimeModelDiscoveryPending,
  } = useProviderModelCatalog({
    selectedProvider,
    selectedProviderInstanceId,
    discoveryEnabled: isModelPickerOpen,
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
    if (selectedProvider === "pi" && draftModelSelectionForSelectedProvider?.provider === "pi") {
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
    draftModelSelectionForSelectedProvider,
    selectedModel,
    selectedModelOptionsForDispatch,
    selectedProvider,
    selectedProviderInstanceId,
    selectedRuntimeModel,
  ]);
  const providerOptionsForDispatch = useMemo(
    () => getProviderStartOptions(settings, selectedProviderInstanceId),
    [selectedProviderInstanceId, settings],
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
      : (activeThread?.modelSelection ?? activeProject?.defaultModelSelection ?? null);
  const providerModelsLoading = selectedProviderModelsLoading;
  const selectedProviderRequiresRuntimeModels =
    selectedProvider === "cursor" ||
    selectedProvider === "antigravity" ||
    selectedProvider === "droid" ||
    selectedProvider === "opencode" ||
    selectedProvider === "pi" ||
    selectedProvider === "devin";
  const showComposerModelBootstrapSkeleton = shouldShowComposerModelBootstrapSkeleton({
    selectedProvider,
    providerInstances,
    selectedProviderInstanceId,
    selectedModel,
    persistedModelSelection: persistedComposerModelSelection,
    draftModelSelection: draftModelSelectionForSelectedProvider,
    providerModelsLoading,
    requiresDiscoveredModels: selectedProviderRequiresRuntimeModels,
  });
  const searchableModelOptions = useMemo(
    () =>
      buildSearchableModelOptions({
        providerOptions: providerInstances.map((instance) => ({
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
      lockedProvider,
      modelOptionsByProvider,
      modelOptionsByProviderInstance,
      providerInstances,
      selectedProvider,
      settings.hiddenProviders,
      settings.providerOrder,
    ],
  );
  return {
    hasThreadStarted,
    lockedProvider,
    serverConfigQuery,
    selectedProvider,
    providerInstances,
    selectedProviderInstanceId,
    providerModelDiscoveryCwd,
    customModelsByProvider,
    modelOptionsByProvider,
    modelOptionsByProviderInstance,
    loadingModelProviders,
    discoveryErrorsByProvider,
    runtimeModelsByProvider,
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
