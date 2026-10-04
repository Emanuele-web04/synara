// FILE: useScratchModelCatalog.ts
// Purpose: The model catalog, runtime mode, picker open state, and model changes behind a
//          scratch composer draft (see useScratchComposerDraft), so surfaces that start a
//          chat without the chat composer (Kanban's new-task dialog, the Tasks delegate
//          form) pick models and runtime modes exactly like chat.
// Layer: Web UI hook
// Exports: useScratchModelCatalog, ScratchModelCatalog

import type {
  ModelSlug,
  ProviderInstanceId,
  ProviderKind,
  RuntimeMode,
  ServerProviderStatus,
} from "@synara/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { resolveRuntimeModelDescriptor } from "~/components/chat/runtimeModelCapabilities";
import { useProviderModelCatalog } from "~/hooks/useProviderModelCatalog";
import { findProviderStatus } from "~/lib/providerAvailability";
import {
  normalizeRuntimeModeForProvider,
  providerModelSupportsAutoRuntimeMode,
} from "~/lib/runtimeMode";
import { useComposerDraftStore } from "../composerDraftStore";
import { buildModelSelection, type ProviderOptions } from "../providerModelOptions";
import { DEFAULT_RUNTIME_MODE } from "../types";
import type { ScratchModelDraft } from "./useScratchComposerDraft";

export function useScratchModelCatalog(input: {
  /** The scratch draft whose provider/model selection this catalog serves. */
  readonly draft: ScratchModelDraft;
  readonly providerStatuses: readonly ServerProviderStatus[];
  readonly discoveryCwd: string | null;
}) {
  const {
    scratchThreadId,
    selectedProvider,
    selectedProviderInstanceId,
    selectedModel,
    selectedModelSupportsAutoMode,
    // The scratch draft's own model setter, which also saves the sticky choice.
    handleProviderModelChange: setScratchProviderModel,
  } = input.draft;
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(DEFAULT_RUNTIME_MODE);
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [isTraitsPickerOpen, setIsTraitsPickerOpen] = useState(false);
  const selectedProviderStatus = useMemo(
    () => findProviderStatus(input.providerStatuses, selectedProvider, selectedProviderInstanceId),
    [input.providerStatuses, selectedProvider, selectedProviderInstanceId],
  );
  const modelHintByProvider = useMemo<Partial<Record<ProviderKind, string | null>>>(
    () => ({ [selectedProvider]: selectedModel }),
    [selectedProvider, selectedModel],
  );
  const catalog = useProviderModelCatalog({
    selectedProvider,
    selectedProviderInstanceId,
    // Keep discovery warm while a picker can open, so effort and fast-mode controls fill in.
    discoveryEnabled: isModelPickerOpen || isTraitsPickerOpen,
    cwd: input.discoveryCwd,
    modelHintByProvider,
  });
  const {
    modelOptionsByProvider,
    modelOptionsByProviderInstance,
    runtimeModelsByProvider,
    selectedRuntimeModel,
  } = catalog;
  const runtimeModelForCapabilities = useMemo(
    () =>
      selectedRuntimeModel ??
      (selectedProvider === "claudeAgent" && typeof selectedModelSupportsAutoMode === "boolean"
        ? {
            slug: selectedModel ?? "default",
            name: selectedModel ?? "default",
            supportsAutoMode: selectedModelSupportsAutoMode,
          }
        : undefined),
    [selectedModel, selectedModelSupportsAutoMode, selectedProvider, selectedRuntimeModel],
  );

  const handleProviderModelChange = useCallback(
    (
      provider: ProviderKind,
      model: ModelSlug,
      instanceId?: ProviderInstanceId,
      options?: ProviderOptions,
    ) => {
      const runtimeModel = resolveRuntimeModelDescriptor({
        provider,
        model,
        runtimeModels: runtimeModelsByProvider[provider],
      });
      setRuntimeMode((current) => normalizeRuntimeModeForProvider(current, provider));
      setScratchProviderModel(provider, model, instanceId, runtimeModel?.supportsAutoMode, options);
    },
    [runtimeModelsByProvider, setScratchProviderModel],
  );

  useEffect(() => {
    if (
      runtimeMode === "auto" &&
      !providerModelSupportsAutoRuntimeMode(
        selectedProvider,
        runtimeModelForCapabilities,
        selectedProviderStatus,
      )
    ) {
      setRuntimeMode("approval-required");
    }
  }, [runtimeMode, runtimeModelForCapabilities, selectedProvider, selectedProviderStatus]);

  // Providers without a static default (e.g. Pi) resolve their model once discovery
  // delivers the catalog. This is not a user choice, so it skips the sticky selection.
  useEffect(() => {
    if (selectedModel !== null) {
      return;
    }
    const firstOption = (modelOptionsByProviderInstance[selectedProviderInstanceId] ??
      modelOptionsByProvider[selectedProvider])[0];
    if (firstOption) {
      useComposerDraftStore.getState().setModelSelection(
        scratchThreadId,
        buildModelSelection(
          selectedProvider,
          firstOption.slug,
          undefined,
          resolveRuntimeModelDescriptor({
            provider: selectedProvider,
            model: firstOption.slug,
            runtimeModels: runtimeModelsByProvider[selectedProvider],
          })?.supportsAutoMode,
          { instanceId: selectedProviderInstanceId },
        ),
      );
    }
  }, [
    modelOptionsByProvider,
    modelOptionsByProviderInstance,
    runtimeModelsByProvider,
    scratchThreadId,
    selectedModel,
    selectedProvider,
    selectedProviderInstanceId,
  ]);

  return {
    ...catalog,
    runtimeMode,
    setRuntimeMode,
    selectedProviderStatus,
    runtimeModelForCapabilities,
    handleProviderModelChange,
    isModelPickerOpen,
    setIsModelPickerOpen,
    isTraitsPickerOpen,
    setIsTraitsPickerOpen,
  };
}

export type ScratchModelCatalog = ReturnType<typeof useScratchModelCatalog>;
