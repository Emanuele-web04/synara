// FILE: draftFallbackModelSelection.ts
// Purpose: The model selection a new chat or project starts on before anything else
//          picks one: the project default, else the new-chat default agent and account.
// Layer: Web model-selection helper
// Exports: resolveDraftFallbackModelSelection

import { DEFAULT_MODEL_BY_PROVIDER, type ModelSelection } from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";

import { newChatDefaultInstanceIdFor, type NewChatDefault } from "../appSettings";
import { buildModelSelection } from "../providerModelOptions";

/**
 * Fallback model selection for a draft thread before the first server turn exists,
 * and the seed selection of a new project (`projectDefault: null`). An explicit
 * project default wins; otherwise the new-chat default agent is used (pi and omp
 * have no default model, so they are skipped), then codex. The model comes from
 * the project default only when it matches the chosen provider, otherwise the
 * provider's own default. The new-chat default account is attached only when its
 * agent is the one chosen and no project default applies.
 */
export function resolveDraftFallbackModelSelection(input: {
  projectDefault: ModelSelection | null | undefined;
  newChatDefault: NewChatDefault;
}): ModelSelection {
  const settingsProvider =
    input.newChatDefault.defaultProvider === "pi" || input.newChatDefault.defaultProvider === "omp"
      ? null
      : input.newChatDefault.defaultProvider;
  const provider = input.projectDefault?.provider ?? settingsProvider ?? "codex";
  const model =
    (provider === input.projectDefault?.provider ? input.projectDefault.model : null) ??
    getDefaultModel(provider) ??
    DEFAULT_MODEL_BY_PROVIDER.codex;
  const instanceId = newChatDefaultInstanceIdFor(
    input.newChatDefault,
    provider,
    input.projectDefault?.provider,
  );
  return instanceId
    ? buildModelSelection(provider, model, undefined, { instanceId })
    : buildModelSelection(provider, model);
}
