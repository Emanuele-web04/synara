// FILE: useKanbanTaskScratchDraft.ts
// Purpose: The kanban new-task dialog's scratch composer draft — the shared scratch
//          draft plus image intake and skill/mention upkeep.
// Layer: Kanban UI hook
// Exports: useKanbanTaskScratchDraft

import type { ProviderKind } from "@synara/contracts";
import type { AppSettings } from "../../appSettings";
import { useCallback, useEffect, useRef } from "react";

import {
  filterPromptProviderMentionReferences,
  filterPromptSkillReferences,
  providerMentionReferencesEqual,
  providerSkillReferencesEqual,
} from "~/lib/composerMentions";
import { effectiveComposerAttachmentCount } from "~/lib/composerSend";
import { useComposerImageIntake } from "~/hooks/useComposerImageIntake";
import { useScratchComposerDraft } from "~/hooks/useScratchComposerDraft";
import { type ComposerImageAttachment, useComposerDraftStore } from "../../composerDraftStore";
import { toastManager } from "../ui/toast";

export function useKanbanTaskScratchDraft(input: {
  readonly defaultProvider: AppSettings["defaultProvider"];
  readonly settings: Pick<
    AppSettings,
    "codexAccounts" | "codexHomePath" | "providerInstances" | "selectedCodexAccountId"
  >;
}) {
  // Scratch composer draft backing the dialog: model/effort/speed state lives in
  // the composer draft store under this throwaway thread id, exactly like chat.
  const {
    scratchThreadId,
    scratchDraft,
    prompt,
    setPrompt,
    selectedProvider,
    selectedProviderInstanceId,
    selectedModel,
    selectedProviderModelOptions,
    selectedModelSupportsAutoMode,
    handleProviderModelChange,
  } = useScratchComposerDraft(input);
  const composerImages = scratchDraft.images;
  const composerAssistantSelections = scratchDraft.assistantSelections;
  const composerFileComments = scratchDraft.fileComments;
  const composerTerminalContexts = scratchDraft.terminalContexts;
  const composerSkills = scratchDraft.skills;
  const composerMentions = scratchDraft.mentions;
  const nonPersistedComposerImageIdSet = new Set(scratchDraft.nonPersistedImageIds);

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
    selectedProviderInstanceId,
    selectedModel,
    selectedModelSupportsAutoMode,
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
