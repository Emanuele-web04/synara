// FILE: useKanbanTaskScratchDraft.ts
// Purpose: Owns the throwaway composer-draft thread used by the kanban new-task dialog.
// Layer: Kanban UI hook
// Exports: useKanbanTaskScratchDraft

import type { ModelSlug, ProviderInstanceId, ProviderKind } from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  filterPromptProviderMentionReferences,
  filterPromptSkillReferences,
  providerMentionReferencesEqual,
  providerSkillReferencesEqual,
} from "~/lib/composerMentions";
import { effectiveComposerAttachmentCount } from "~/lib/composerSend";
import { useComposerImageIntake } from "~/hooks/useComposerImageIntake";
import { newThreadId } from "~/lib/utils";
import {
  getProviderInstanceOptions,
  resolveSelectableProviderInstanceId,
  type AppSettings,
} from "../../appSettings";
import {
  type ComposerImageAttachment,
  providerInstanceModelSelectionKey,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../../composerDraftStore";
import { buildModelSelection } from "../../providerModelOptions";
import { toastManager } from "../ui/toast";

export function useKanbanTaskScratchDraft(input: {
  readonly defaultProvider: ProviderKind;
  readonly settings: Pick<
    AppSettings,
    "codexAccounts" | "codexHomePath" | "providerInstances" | "selectedCodexAccountId"
  >;
}) {
  // Scratch composer draft backing the dialog: model/effort/speed state lives in
  // the composer draft store under this throwaway thread id, exactly like chat.
  const [scratchThreadId] = useState(() => newThreadId());
  useEffect(() => {
    useComposerDraftStore.getState().applyStickyState(scratchThreadId);
    return () => {
      useComposerDraftStore.getState().clearDraftThread(scratchThreadId);
    };
  }, [scratchThreadId]);

  const scratchDraft = useComposerThreadDraft(scratchThreadId);
  const prompt = scratchDraft.prompt;
  const composerImages = scratchDraft.images;
  const composerAssistantSelections = scratchDraft.assistantSelections;
  const composerFileComments = scratchDraft.fileComments;
  const composerTerminalContexts = scratchDraft.terminalContexts;
  const composerSkills = scratchDraft.skills;
  const composerMentions = scratchDraft.mentions;
  const nonPersistedComposerImageIdSet = new Set(scratchDraft.nonPersistedImageIds);

  const setPrompt = (nextPrompt: string) => {
    useComposerDraftStore.getState().setPrompt(scratchThreadId, nextPrompt);
  };

  const stickyActiveProvider = useComposerDraftStore((state) => state.stickyActiveProvider);
  const stickyModelSelectionByProvider = useComposerDraftStore(
    (state) => state.stickyModelSelectionByProvider,
  );
  const activeProviderInstanceId = scratchDraft.activeProvider ?? stickyActiveProvider;
  const providerInstances = useMemo(
    () => getProviderInstanceOptions(input.settings),
    [input.settings],
  );
  const selectedProvider: ProviderKind =
    (activeProviderInstanceId
      ? (scratchDraft.modelSelectionByProvider[activeProviderInstanceId]?.provider ??
        stickyModelSelectionByProvider[activeProviderInstanceId]?.provider ??
        providerInstances.find((instance) => instance.instanceId === activeProviderInstanceId)
          ?.provider)
      : null) ?? input.defaultProvider;
  const selectedProviderInstanceId: ProviderInstanceId = resolveSelectableProviderInstanceId(
    input.settings,
    selectedProvider,
    activeProviderInstanceId ??
      Object.values(scratchDraft.modelSelectionByProvider).find(
        (selection) => selection?.provider === selectedProvider,
      )?.instanceId ??
      Object.values(stickyModelSelectionByProvider).find(
        (selection) => selection?.provider === selectedProvider,
      )?.instanceId,
  );
  const selectionKey = providerInstanceModelSelectionKey(
    selectedProvider,
    selectedProviderInstanceId,
  );
  const draftModelSelection =
    scratchDraft.modelSelectionByProvider[selectionKey] ??
    stickyModelSelectionByProvider[selectionKey];
  const selectedModel: ModelSlug | null =
    draftModelSelection?.model ?? getDefaultModel(selectedProvider);
  const selectedProviderModelOptions = draftModelSelection?.options;
  const selectedModelSupportsAutoMode =
    draftModelSelection?.provider === "claudeAgent"
      ? draftModelSelection.supportsAutoMode
      : undefined;

  const previousSelectedProviderRef = useRef<{
    threadId: string;
    provider: ProviderKind;
  } | null>(null);

  useEffect(() => {
    const nextSkills = filterPromptSkillReferences(prompt, composerSkills, selectedProvider);
    if (!providerSkillReferencesEqual(composerSkills, nextSkills)) {
      useComposerDraftStore.getState().setSkills(scratchThreadId, nextSkills);
    }
  }, [composerSkills, prompt, scratchThreadId, selectedProvider]);

  useEffect(() => {
    const nextMentions = filterPromptProviderMentionReferences(prompt, composerMentions);
    if (!providerMentionReferencesEqual(composerMentions, nextMentions)) {
      useComposerDraftStore.getState().setMentions(scratchThreadId, nextMentions);
    }
  }, [composerMentions, prompt, scratchThreadId]);

  useEffect(() => {
    const previous = previousSelectedProviderRef.current;
    previousSelectedProviderRef.current = {
      threadId: scratchThreadId,
      provider: selectedProvider,
    };
    if (
      !previous ||
      previous.threadId !== scratchThreadId ||
      previous.provider === selectedProvider
    ) {
      return;
    }
    useComposerDraftStore.getState().setSkills(scratchThreadId, []);
    useComposerDraftStore.getState().setMentions(scratchThreadId, []);
  }, [scratchThreadId, selectedProvider]);

  const handleProviderModelChange = useCallback(
    (
      provider: ProviderKind,
      model: ModelSlug,
      instanceId?: ProviderInstanceId,
      supportsAutoMode?: boolean,
    ) => {
      const store = useComposerDraftStore.getState();
      const nextSelection = buildModelSelection(provider, model, undefined, supportsAutoMode, {
        instanceId: instanceId ?? provider,
      });
      // Mirrors the composer: update the scratch draft and persist the sticky selection.
      store.setModelSelectionAndSticky(scratchThreadId, nextSelection);
    },
    [scratchThreadId],
  );
  const existingAttachmentCount = useCallback(
    () =>
      effectiveComposerAttachmentCount(
        useComposerDraftStore.getState().draftsByThreadId[scratchThreadId],
      ),
    [scratchThreadId],
  );
  const commitImages = useCallback(
    (images: ComposerImageAttachment[]) =>
      useComposerDraftStore.getState().addImages(scratchThreadId, images),
    [scratchThreadId],
  );
  const handleImageError = useCallback((error: string | null) => {
    if (error) toastManager.add({ type: "warning", title: error });
  }, []);
  const {
    addImages: enqueueComposerImages,
    isPreparingImages,
    pendingImageCount,
    waitForPending: waitForPendingImages,
  } = useComposerImageIntake({
    threadId: scratchThreadId,
    existingAttachmentCount,
    commitImages,
    onError: handleImageError,
  });

  const addComposerImages = (files: readonly File[]) => {
    if (files.length === 0) return;
    enqueueComposerImages(files);
  };

  const removeComposerImage = (imageId: string) => {
    useComposerDraftStore.getState().removeImage(scratchThreadId, imageId);
  };

  const clearComposerAssistantSelections = () => {
    useComposerDraftStore.getState().clearAssistantSelections(scratchThreadId);
  };

  const clearComposerFileComments = () => {
    useComposerDraftStore.getState().clearFileComments(scratchThreadId);
  };

  const removeComposerTerminalContext = (contextId: string) => {
    useComposerDraftStore.getState().removeTerminalContext(scratchThreadId, contextId);
  };

  return {
    scratchThreadId,
    scratchDraft,
    prompt,
    composerImages,
    composerAssistantSelections,
    composerFileComments,
    composerTerminalContexts,
    composerSkills,
    composerMentions,
    nonPersistedComposerImageIdSet,
    isPreparingImages,
    pendingImageCount,
    waitForPendingImages,
    selectedProvider,
    selectedModel,
    selectedModelSupportsAutoMode,
    selectedProviderInstanceId,
    selectedProviderModelOptions,
    setPrompt,
    handleProviderModelChange,
    addComposerImages,
    removeComposerImage,
    clearComposerAssistantSelections,
    clearComposerFileComments,
    removeComposerTerminalContext,
  };
}
