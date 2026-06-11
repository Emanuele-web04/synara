import { useMemo } from "react";
import { type ModelSelection, type ProviderKind } from "@t3tools/contracts";

interface UseComposerModelHintByProviderParams {
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  draftSelections: Partial<Record<ProviderKind, ModelSelection>>;
}

export function useComposerModelHintByProvider({
  threadModelSelection,
  projectModelSelection,
  draftSelections,
}: UseComposerModelHintByProviderParams): Record<ProviderKind, string | null> {
  return useMemo<Record<ProviderKind, string | null>>(() => {
    const resolveHint = (provider: ProviderKind): string | null =>
      draftSelections[provider]?.model ??
      (threadModelSelection?.provider === provider ? threadModelSelection.model : null) ??
      (projectModelSelection?.provider === provider ? projectModelSelection.model : null);

    return {
      codex: resolveHint("codex"),
      claudeAgent: resolveHint("claudeAgent"),
      cursor: resolveHint("cursor"),
      gemini: resolveHint("gemini"),
      grok: resolveHint("grok"),
      kilo: resolveHint("kilo"),
      opencode: resolveHint("opencode"),
      pi: resolveHint("pi"),
    };
  }, [projectModelSelection, threadModelSelection, draftSelections]);
}
