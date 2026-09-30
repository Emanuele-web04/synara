// FILE: useScratchComposerDraft.ts
// Purpose: Owns a throwaway composer-draft thread for surfaces that start a chat without
//          the chat composer (Kanban's new-task dialog, the Tasks delegate form), so the
//          shared model and effort pickers read and write model state exactly like a
//          fresh chat composer. The draft is discarded on unmount.
// Layer: Web UI hook
// Exports: useScratchComposerDraft, ScratchComposerDraft, ScratchModelDraft

import type { ModelSlug, ProviderInstanceId, ProviderKind, ThreadId } from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getProviderInstanceOptions,
  resolveSelectableProviderInstanceId,
  type AppSettings,
} from "../appSettings";
import { newThreadId } from "~/lib/utils";
import {
  providerInstanceModelSelectionKey,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../composerDraftStore";
import { buildModelSelection, type ProviderOptions } from "../providerModelOptions";

export function useScratchComposerDraft(input: {
  readonly defaultProvider: ProviderKind;
  readonly settings: Pick<
    AppSettings,
    "codexAccounts" | "codexHomePath" | "providerInstances" | "selectedCodexAccountId"
  >;
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
      instanceId?: ProviderInstanceId,
      supportsAutoMode?: boolean,
      options?: ProviderOptions,
    ) => {
      // Mirrors the composer: update the scratch draft and persist the sticky selection.
      useComposerDraftStore.getState().setModelSelectionAndSticky(
        scratchThreadId,
        buildModelSelection(provider, model, options, supportsAutoMode, {
          instanceId: instanceId ?? provider,
        }),
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
    selectedProviderInstanceId,
    selectedModel,
    selectedProviderModelOptions: draftModelSelection?.options,
    selectedModelSupportsAutoMode:
      draftModelSelection?.provider === "claudeAgent"
        ? draftModelSelection.supportsAutoMode
        : undefined,
    handleProviderModelChange,
  };
}

export type ScratchComposerDraft = ReturnType<typeof useScratchComposerDraft>;

/**
 * The slice of a scratch draft that the model catalog and pickers read, so a surface that
 * layers more state on the draft (Kanban's images and mentions) can pass its own draft.
 */
export type ScratchModelDraft = Pick<
  ScratchComposerDraft,
  | "scratchThreadId"
  | "prompt"
  | "setPrompt"
  | "selectedProviderInstanceId"
  | "selectedProvider"
  | "selectedModel"
  | "selectedModelSupportsAutoMode"
  | "selectedProviderModelOptions"
  | "handleProviderModelChange"
>;
