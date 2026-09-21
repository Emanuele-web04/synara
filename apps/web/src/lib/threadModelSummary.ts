import type { ModelSelection, ProviderKind } from "@synara/contracts";

import {
  getComposerTraitSelection,
  resolveComposerTraitStatusLabel,
  showsComposerFastModeBadge,
} from "~/components/chat/composerTraits";
import { formatProviderModelOptionName, type ProviderOptions } from "~/providerModelOptions";

export interface ThreadModelSummary {
  provider: ProviderKind;
  modelLabel: string;
  statusLabel: string | null;
  fastMode: boolean;
}

export function resolveThreadModelSummary(
  modelSelection: ModelSelection | null | undefined,
): ThreadModelSummary | null {
  if (!modelSelection) {
    return null;
  }
  // deliberately the selection's provider not the live session's — glyph and model name must describe the same selection and a live session can briefly report a different provider
  const provider = modelSelection.provider;
  const modelLabel = formatProviderModelOptionName({ provider, slug: modelSelection.model });
  if (modelLabel.length === 0) {
    return null;
  }
  // The prompt only matters for prompt-injected efforts (Claude's ultrathink), which a stored selection never carries, so an empty draft is correct here.
  const traits = getComposerTraitSelection(
    provider,
    modelSelection.model,
    "",
    modelSelection.options as ProviderOptions | undefined,
  );
  return {
    provider,
    modelLabel,
    statusLabel: resolveComposerTraitStatusLabel(traits),
    fastMode: showsComposerFastModeBadge(traits),
  };
}
