// FILE: useComposerTraitCommit.ts
// Purpose: One store write path for composer trait changes (effort, fast mode, thinking, context).
// Layer: Chat composer state hook
// Depends on: composer draft store and provider option patch helpers.

import type { ProviderInstanceId, ProviderKind, ThreadId } from "@synara/contracts";
import { useCallback } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { buildNextProviderOptions, type ProviderOptions } from "../../providerModelOptions";

// Merges a trait patch into the thread's provider options and persists it as the
// sticky choice for the model. Every trait surface (radio menu, slider card,
// keyboard shortcuts) funnels through here so persistence semantics stay identical.
export function useComposerTraitCommit(input: {
  threadId: ThreadId;
  provider: ProviderKind;
  providerInstanceId?: ProviderInstanceId | null | undefined;
  model: string | null | undefined;
  modelOptions: ProviderOptions | null | undefined;
}): (patch: Record<string, unknown>) => void {
  const { threadId, provider, providerInstanceId, model, modelOptions } = input;
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  return useCallback(
    (patch: Record<string, unknown>) => {
      setProviderModelOptions(
        threadId,
        provider,
        buildNextProviderOptions(provider, modelOptions, patch),
        {
          ...(providerInstanceId ? { instanceId: providerInstanceId } : {}),
          ...(model !== undefined ? { model } : {}),
          persistSticky: true,
        },
      );
    },
    [threadId, provider, providerInstanceId, modelOptions, model, setProviderModelOptions],
  );
}
