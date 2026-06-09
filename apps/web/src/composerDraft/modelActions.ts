// FILE: composerDraft/modelActions.ts
// Purpose: Reducers for per-thread model selection/options and sticky provider state.
// Layer: Web state store (reducers)
// Exports: setStickyModelSelectionReducer, applyStickyStateReducer, setModelSelectionReducer,
//   setModelOptionsReducer, setProviderModelOptionsReducer

import type {
  ModelSelection,
  ProviderKind,
  ProviderModelOptions,
  ThreadId,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { getDefaultModel } from "@t3tools/shared/model";
import { buildModelSelection } from "../providerModelOptions";
import { commitDraft, createEmptyThreadDraft } from "./draftMutations";
import { COMPOSER_PROVIDER_KINDS, makeModelSelection } from "./modelSelection";
import type { ComposerDraftStoreState, ComposerThreadDraftState } from "../composerDraftStore";

type StateChange = ComposerDraftStoreState | Partial<ComposerDraftStoreState>;

export function setStickyModelSelectionReducer(
  state: ComposerDraftStoreState,
  normalized: ModelSelection | null,
): StateChange {
  if (!normalized) {
    return state;
  }
  const nextMap: Partial<Record<ProviderKind, ModelSelection>> = {
    ...state.stickyModelSelectionByProvider,
    [normalized.provider]: normalized,
  };
  if (Equal.equals(state.stickyModelSelectionByProvider, nextMap)) {
    return state.stickyActiveProvider === normalized.provider
      ? state
      : { stickyActiveProvider: normalized.provider };
  }
  return {
    stickyModelSelectionByProvider: nextMap,
    stickyActiveProvider: normalized.provider,
  };
}

export function applyStickyStateReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
): StateChange {
  const stickyMap = state.stickyModelSelectionByProvider;
  const stickyActiveProvider = state.stickyActiveProvider;
  if (Object.keys(stickyMap).length === 0 && stickyActiveProvider === null) {
    return state;
  }
  const existing = state.draftsByThreadId[threadId];
  const base = existing ?? createEmptyThreadDraft();
  const nextMap = { ...base.modelSelectionByProvider };
  for (const [provider, selection] of Object.entries(stickyMap)) {
    if (selection) {
      const current = nextMap[provider as ProviderKind];
      nextMap[provider as ProviderKind] = {
        ...selection,
        model: current?.model ?? selection.model,
      };
    }
  }
  if (
    Equal.equals(base.modelSelectionByProvider, nextMap) &&
    base.activeProvider === stickyActiveProvider
  ) {
    return state;
  }
  const nextDraft: ComposerThreadDraftState = {
    ...base,
    modelSelectionByProvider: nextMap,
    activeProvider: stickyActiveProvider,
  };
  return commitDraft(state, threadId, nextDraft);
}

export function setModelSelectionReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  normalized: ModelSelection | null,
): StateChange {
  const existing = state.draftsByThreadId[threadId];
  if (!existing && normalized === null) {
    return state;
  }
  const base = existing ?? createEmptyThreadDraft();
  const nextMap = { ...base.modelSelectionByProvider };
  if (normalized) {
    const current = nextMap[normalized.provider];
    if (normalized.options !== undefined) {
      // Explicit options provided → use them
      nextMap[normalized.provider] = normalized;
    } else {
      // No options in selection → preserve existing options, update provider+model
      nextMap[normalized.provider] = makeModelSelection(
        normalized.provider,
        normalized.model,
        current?.options,
      );
    }
  }
  const nextActiveProvider = normalized?.provider ?? base.activeProvider;
  if (
    Equal.equals(base.modelSelectionByProvider, nextMap) &&
    base.activeProvider === nextActiveProvider
  ) {
    return state;
  }
  const nextDraft: ComposerThreadDraftState = {
    ...base,
    modelSelectionByProvider: nextMap,
    activeProvider: nextActiveProvider,
  };
  return commitDraft(state, threadId, nextDraft);
}

export function setModelOptionsReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  normalizedOpts: ProviderModelOptions | null,
): StateChange {
  const existing = state.draftsByThreadId[threadId];
  if (!existing && normalizedOpts === null) {
    return state;
  }
  const base = existing ?? createEmptyThreadDraft();
  const nextMap = { ...base.modelSelectionByProvider };
  for (const provider of COMPOSER_PROVIDER_KINDS) {
    // Only touch providers explicitly present in the input
    if (!normalizedOpts || !(provider in normalizedOpts)) continue;
    const opts = normalizedOpts[provider];
    const current = nextMap[provider];
    if (opts) {
      const model = current?.model ?? getDefaultModel(provider);
      if (!model) continue;
      nextMap[provider] = makeModelSelection(provider, model, opts);
    } else if (current?.options) {
      // Remove options but keep the selection
      nextMap[provider] = buildModelSelection(provider, current.model);
    }
  }
  if (Equal.equals(base.modelSelectionByProvider, nextMap)) {
    return state;
  }
  const nextDraft: ComposerThreadDraftState = {
    ...base,
    modelSelectionByProvider: nextMap,
  };
  return commitDraft(state, threadId, nextDraft);
}

export function setProviderModelOptionsReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  normalizedProvider: ProviderKind,
  providerOpts: ProviderModelOptions[ProviderKind] | undefined,
  fallbackModel: string | null | undefined,
  persistSticky: boolean,
): StateChange {
  const existing = state.draftsByThreadId[threadId];
  const base = existing ?? createEmptyThreadDraft();

  // Update the map entry for this provider
  const nextMap = { ...base.modelSelectionByProvider };
  const currentForProvider = nextMap[normalizedProvider];
  if (providerOpts) {
    const nextModel = currentForProvider?.model ?? fallbackModel;
    if (!nextModel) {
      return state;
    }
    nextMap[normalizedProvider] = makeModelSelection(normalizedProvider, nextModel, providerOpts);
  } else if (currentForProvider?.options) {
    nextMap[normalizedProvider] = buildModelSelection(normalizedProvider, currentForProvider.model);
  }

  // Handle sticky persistence
  let nextStickyMap = state.stickyModelSelectionByProvider;
  let nextStickyActiveProvider = state.stickyActiveProvider;
  if (persistSticky) {
    nextStickyMap = { ...state.stickyModelSelectionByProvider };
    const stickyBase =
      nextStickyMap[normalizedProvider] ??
      base.modelSelectionByProvider[normalizedProvider] ??
      (fallbackModel ? makeModelSelection(normalizedProvider, fallbackModel) : null);
    if (!stickyBase) {
      return state;
    }
    if (providerOpts) {
      nextStickyMap[normalizedProvider] = makeModelSelection(
        normalizedProvider,
        stickyBase.model,
        providerOpts,
      );
    } else if (stickyBase.options) {
      nextStickyMap[normalizedProvider] = buildModelSelection(normalizedProvider, stickyBase.model);
    }
    nextStickyActiveProvider = base.activeProvider ?? normalizedProvider;
  }

  if (
    Equal.equals(base.modelSelectionByProvider, nextMap) &&
    Equal.equals(state.stickyModelSelectionByProvider, nextStickyMap) &&
    state.stickyActiveProvider === nextStickyActiveProvider
  ) {
    return state;
  }

  const nextDraft: ComposerThreadDraftState = {
    ...base,
    modelSelectionByProvider: nextMap,
  };

  return {
    ...commitDraft(state, threadId, nextDraft),
    ...(persistSticky
      ? {
          stickyModelSelectionByProvider: nextStickyMap,
          stickyActiveProvider: nextStickyActiveProvider,
        }
      : {}),
  };
}
