// FILE: useKanbanTaskScratchDraft.ts
// Purpose: Owns the throwaway composer-draft thread used by the kanban new-task dialog.
// Layer: Kanban UI hook
// Exports: useKanbanTaskScratchDraft

import type { ModelSlug, ProviderKind } from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  filterPromptProviderMentionReferences,
  filterPromptSkillReferences,
  providerMentionReferencesEqual,
  providerSkillReferencesEqual,
} from "~/lib/composerMentions";
import { buildComposerImageAttachmentsFromFiles } from "~/lib/composerSend";
import { newThreadId } from "~/lib/utils";
import { useComposerDraftStore, useComposerThreadDraft } from "../../composerDraftStore";
import { buildModelSelection } from "../../providerModelOptions";
import { toastManager } from "../ui/toast";

export function useKanbanTaskScratchDraft(input: { readonly defaultProvider: ProviderKind }) {
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
  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(scratchDraft.nonPersistedImageIds),
    [scratchDraft.nonPersistedImageIds],
  );

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      useComposerDraftStore.getState().setPrompt(scratchThreadId, nextPrompt);
    },
    [scratchThreadId],
  );

  const stickyActiveProvider = useComposerDraftStore((state) => state.stickyActiveProvider);
  const stickyModelSelectionByProvider = useComposerDraftStore(
    (state) => state.stickyModelSelectionByProvider,
  );
  const selectedProvider: ProviderKind =
    scratchDraft.activeProvider ?? stickyActiveProvider ?? input.defaultProvider;
  const draftModelSelection =
    scratchDraft.modelSelectionByProvider[selectedProvider] ??
    stickyModelSelectionByProvider[selectedProvider];
  const selectedModel: ModelSlug | null =
    draftModelSelection?.model ?? getDefaultModel(selectedProvider);
  const selectedProviderModelOptions = draftModelSelection?.options;

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
    (provider: ProviderKind, model: ModelSlug) => {
      const store = useComposerDraftStore.getState();
      const nextSelection = buildModelSelection(provider, model);
      // Mirrors the composer: update the scratch draft and persist the sticky selection.
      store.setModelSelection(scratchThreadId, nextSelection);
      store.setStickyModelSelection(nextSelection);
    },
    [scratchThreadId],
  );

  const addComposerImages = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      const { images, error } = buildComposerImageAttachmentsFromFiles({
        files,
        existingAttachmentCount: composerImages.length + composerAssistantSelections.length,
      });
      if (images.length > 0) {
        useComposerDraftStore.getState().addImages(scratchThreadId, images);
      }
      if (error) {
        toastManager.add({ type: "warning", title: error });
      }
    },
    [composerAssistantSelections.length, composerImages.length, scratchThreadId],
  );

  const removeComposerImage = useCallback(
    (imageId: string) => {
      useComposerDraftStore.getState().removeImage(scratchThreadId, imageId);
    },
    [scratchThreadId],
  );

  const clearComposerAssistantSelections = useCallback(() => {
    useComposerDraftStore.getState().clearAssistantSelections(scratchThreadId);
  }, [scratchThreadId]);

  const clearComposerFileComments = useCallback(() => {
    useComposerDraftStore.getState().clearFileComments(scratchThreadId);
  }, [scratchThreadId]);

  const removeComposerTerminalContext = useCallback(
    (contextId: string) => {
      useComposerDraftStore.getState().removeTerminalContext(scratchThreadId, contextId);
    },
    [scratchThreadId],
  );

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
    selectedProvider,
    selectedModel,
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
