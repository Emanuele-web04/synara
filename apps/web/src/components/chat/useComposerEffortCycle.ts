import type {
  ProviderInstanceId,
  ProviderKind,
  ProviderModelDescriptor,
  ThreadId,
} from "@synara/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ProviderOptions } from "../../providerModelOptions";
import { getComposerTraitSelection, planComposerEffortCycle } from "./composerTraits";
import { useComposerTraitCommit } from "./useComposerTraitCommit";

const EFFORT_PREVIEW_DURATION_MS = 1_500;

// Owns the brief keyboard preview independently of a manually opened model picker.
export function useComposerEffortCycle(input: {
  threadId: ThreadId;
  provider: ProviderKind;
  providerInstanceId: ProviderInstanceId;
  model: string;
  runtimeModel: ProviderModelDescriptor | undefined;
  modelOptions: ProviderOptions | undefined;
  prompt: string;
}) {
  const { threadId, provider, providerInstanceId, model, runtimeModel, modelOptions, prompt } =
    input;
  const [isEffortPreviewOpen, setIsEffortPreviewOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const commitTrait = useComposerTraitCommit(input);

  const dismissEffortPreview = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setIsEffortPreviewOpen(false);
  }, []);

  useEffect(() => {
    // A preview and its timer belong to this thread, account and model only.
    const reset = window.setTimeout(dismissEffortPreview, 0);
    return () => {
      window.clearTimeout(reset);
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [threadId, provider, providerInstanceId, model, dismissEffortPreview]);

  const cycleEffort = useCallback((): boolean => {
    const selection = getComposerTraitSelection(
      provider,
      model,
      prompt,
      modelOptions,
      runtimeModel,
    );
    const plan = planComposerEffortCycle({ provider, selection, prompt });
    if (!plan || plan.kind !== "options") return false;
    commitTrait(plan.patch);
    setIsEffortPreviewOpen(true);
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(dismissEffortPreview, EFFORT_PREVIEW_DURATION_MS);
    return true;
  }, [provider, model, prompt, modelOptions, runtimeModel, commitTrait, dismissEffortPreview]);

  return { isEffortPreviewOpen, cycleEffort, dismissEffortPreview };
}
