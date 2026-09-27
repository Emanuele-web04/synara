// FILE: useScratchModelCatalog.ts
// Purpose: The model catalog, runtime mode, and model changes behind a scratch composer
//          draft (see useScratchComposerDraft), so surfaces that start a chat without the
//          chat composer (Kanban's new-task dialog, the Tasks delegate form) pick models
//          and runtime modes exactly like chat.
// Layer: Web UI hook
// Exports: useScratchModelCatalog

import type {
  ModelSlug,
  ProviderKind,
  RuntimeMode,
  ServerProviderStatus,
  ThreadId,
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

export function useScratchModelCatalog(input: {
  readonly scratchThreadId: ThreadId;
  readonly selectedProvider: ProviderKind;
  readonly selectedModel: ModelSlug | null;
  readonly selectedModelSupportsAutoMode: boolean | undefined;
  /** The scratch draft's own model setter, which also saves the sticky choice. */
  readonly setScratchProviderModel: (
    provider: ProviderKind,
    model: ModelSlug,
    supportsAutoMode?: boolean,
    options?: ProviderOptions,
  ) => void;
  readonly providerStatuses: readonly ServerProviderStatus[];
  /** Keep discovery warm while a picker can open, so effort and fast-mode controls fill in. */
  readonly discoveryEnabled: boolean;
  readonly discoveryCwd: string | null;
}) {
  const {
    scratchThreadId,
    selectedProvider,
    selectedModel,
    selectedModelSupportsAutoMode,
    setScratchProviderModel,
  } = input;
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(DEFAULT_RUNTIME_MODE);
  const selectedProviderStatus = useMemo(
    () => findProviderStatus(input.providerStatuses, selectedProvider),
    [input.providerStatuses, selectedProvider],
  );
  const modelHintByProvider = useMemo<Partial<Record<ProviderKind, string | null>>>(
    () => ({ [selectedProvider]: selectedModel }),
    [selectedProvider, selectedModel],
  );
  const catalog = useProviderModelCatalog({
    selectedProvider,
    discoveryEnabled: input.discoveryEnabled,
    cwd: input.discoveryCwd,
    modelHintByProvider,
  });
  const { modelOptionsByProvider, runtimeModelsByProvider, selectedRuntimeModel } = catalog;
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
    (provider: ProviderKind, model: ModelSlug, options?: ProviderOptions) => {
      const runtimeModel = resolveRuntimeModelDescriptor({
        provider,
        model,
        runtimeModels: runtimeModelsByProvider[provider],
      });
      setRuntimeMode((current) => normalizeRuntimeModeForProvider(current, provider));
      setScratchProviderModel(provider, model, runtimeModel?.supportsAutoMode, options);
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
    const firstOption = modelOptionsByProvider[selectedProvider][0];
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
        ),
      );
    }
  }, [
    modelOptionsByProvider,
    runtimeModelsByProvider,
    scratchThreadId,
    selectedModel,
    selectedProvider,
  ]);

  return {
    ...catalog,
    runtimeMode,
    setRuntimeMode,
    selectedProviderStatus,
    runtimeModelForCapabilities,
    handleProviderModelChange,
  };
}
