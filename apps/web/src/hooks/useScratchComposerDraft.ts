// FILE: useScratchComposerDraft.ts
// Purpose: Owns a throwaway composer-draft thread for surfaces that start a chat without
//          the chat composer (Kanban's new-task dialog, the Tasks delegate form), so the
//          shared model and effort pickers read and write model state exactly like a
//          fresh chat composer. The draft is discarded on unmount.
// Layer: Web UI hook
// Exports: useScratchComposerDraft

import type { ModelSlug, ProviderKind, ThreadId } from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";
import { useCallback, useEffect, useState } from "react";

import { newThreadId } from "~/lib/utils";
import { useComposerDraftStore, useComposerThreadDraft } from "../composerDraftStore";
import { buildModelSelection, type ProviderOptions } from "../providerModelOptions";

export function useScratchComposerDraft(input: {
  readonly defaultProvider: ProviderKind;
  /** Seeds the prompt once, on mount. */
  readonly initialPrompt?: string;
}) {
  const [scratchThreadId] = useState<ThreadId>(() => newThreadId());
  const [initialPrompt] = useState(input.initialPrompt ?? "");
  useEffect(() => {
    const store = useComposerDraftStore.getState();
    store.applyStickyState(scratchThreadId);
    if (initialPrompt.length > 0) store.setPrompt(scratchThreadId, initialPrompt);
    return () => {
      useComposerDraftStore.getState().clearDraftThread(scratchThreadId);
    };
  }, [initialPrompt, scratchThreadId]);

  const scratchDraft = useComposerThreadDraft(scratchThreadId);
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

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      useComposerDraftStore.getState().setPrompt(scratchThreadId, nextPrompt);
    },
    [scratchThreadId],
  );

  const handleProviderModelChange = useCallback(
    (
      provider: ProviderKind,
      model: ModelSlug,
      supportsAutoMode?: boolean,
      options?: ProviderOptions,
    ) => {
      // Mirrors the composer: update the scratch draft and persist the sticky selection.
      useComposerDraftStore
        .getState()
        .setModelSelectionAndSticky(
          scratchThreadId,
          buildModelSelection(provider, model, options, supportsAutoMode),
        );
    },
    [scratchThreadId],
  );

  return {
    scratchThreadId,
    scratchDraft,
    prompt: scratchDraft.prompt,
    setPrompt,
    selectedProvider,
    selectedModel,
    selectedProviderModelOptions: draftModelSelection?.options,
    selectedModelSupportsAutoMode:
      draftModelSelection?.provider === "claudeAgent"
        ? draftModelSelection.supportsAutoMode
        : undefined,
    handleProviderModelChange,
  };
}
