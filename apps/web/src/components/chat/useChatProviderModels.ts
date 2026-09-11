import {
  ThreadId,
  type ModelSelection,
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
import { getProviderStartOptions } from "../../appSettings";
import { useComposerThreadDraft, useEffectiveComposerModelState } from "../../composerDraftStore";
import { buildSearchableModelOptions } from "../../hooks/useComposerCommandMenuItems";
import { useProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import { buildModelSelection } from "../../providerModelOptions";
import type { Project } from "../../types";
import { type Thread } from "../../types";
import {
  shouldShowComposerModelBootstrapSkeleton,
  threadHasProviderLockingActivity,
} from "../ChatView.logic";
import { AVAILABLE_PROVIDER_OPTIONS } from "./ProviderModelPicker";
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
  const selectedProviderByThreadId = composerDraft.activeProvider ?? null;
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

  const composerModelHintByProvider = useMemo<Record<ProviderKind, string | null>>(() => {
    const threadModelSelection = activeThread?.modelSelection ?? null;
    const projectModelSelection = activeProject?.defaultModelSelection ?? null;
    const draftSelections = composerDraft.modelSelectionByProvider;

    const resolveHint = (provider: ProviderKind): string | null =>
      draftSelections[provider]?.model ??
      (threadModelSelection?.provider === provider ? threadModelSelection.model : null) ??
      (projectModelSelection?.provider === provider ? projectModelSelection.model : null);

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
  ]);
  const providerModelDiscoveryCwd = resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: resolvedThreadWorktreePath,
    activeProjectCwd: activeProject?.cwd ?? null,
    serverCwd: serverConfigQuery.data?.cwd ?? null,
  });
  const {
    customModelsByProvider,
    modelOptionsByProvider,
    loadingModelProviders,
    discoveryErrorsByProvider,
    runtimeModelsByProvider,
    selectedRuntimeAgents: dynamicAgents,
    selectedProviderModelsLoading,
    selectedProviderRuntimeModelDiscoveryPending,
  } = useProviderModelCatalog({
    selectedProvider,
    discoveryEnabled: isModelPickerOpen,
    cwd: providerModelDiscoveryCwd,
    modelHintByProvider: composerModelHintByProvider,
    agentDiscoveryPolicy: "eager-core",
  });
  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId,
    selectedProvider,
    threadModelSelection: activeThread?.modelSelection,
    projectModelSelection: activeProject?.defaultModelSelection,
    customModelsByProvider,
    availableModelOptionsByProvider: modelOptionsByProvider,
  });
  const draftModelSelectionForSelectedProvider =
    composerDraft.modelSelectionByProvider[selectedProvider] ?? null;
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
      );
    }
    return buildModelSelection(
      selectedProvider,
      selectedModel,
      selectedModelOptionsForDispatch,
      selectedProvider === "claudeAgent" ? selectedRuntimeModel?.supportsAutoMode : undefined,
    );
  }, [
    draftModelSelectionForSelectedProvider,
    selectedModel,
    selectedModelOptionsForDispatch,
    selectedProvider,
    selectedRuntimeModel,
  ]);
  const providerOptionsForDispatch = useMemo(() => getProviderStartOptions(settings), [settings]);
  const selectedModelForPicker =
    selectedModelSelection.provider === selectedProvider
      ? selectedModelSelection.model
      : selectedModel;
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByProvider[selectedProvider];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByProvider, selectedModelForPicker, selectedProvider]);
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
    selectedModel,
    persistedModelSelection: persistedComposerModelSelection,
    draftModelSelection: draftModelSelectionForSelectedProvider,
    providerModelsLoading,
    requiresDiscoveredModels: selectedProviderRequiresRuntimeModels,
  });
  const searchableModelOptions = useMemo(
    () =>
      buildSearchableModelOptions({
        providerOptions: AVAILABLE_PROVIDER_OPTIONS,
        modelOptionsByProvider,
        providerOrder: settings.providerOrder,
        hiddenProviders: settings.hiddenProviders,
        protectedProviders: [selectedProvider],
        lockedProvider,
      }),
    [
      lockedProvider,
      modelOptionsByProvider,
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
    providerModelDiscoveryCwd,
    customModelsByProvider,
    modelOptionsByProvider,
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
