// FILE: ScratchAgentControls.tsx
// Purpose: The agent/model controls shared by the surfaces that start a chat without the
//          chat composer (Kanban's new-task dialog, the Tasks delegate form): the split
//          model + effort pickers and the permissions control, all wired to a scratch
//          composer draft and its model catalog. Each surface keeps its own layout and
//          wrapper; these render only the controls.
// Layer: Chat UI component (pickers for composer-less surfaces)
// Exports: ScratchModelPickers, ScratchRuntimeControls

import type { ServerProviderStatus } from "@synara/contracts";

import { getProviderInstanceOptions, useAppSettings } from "~/appSettings";
import { RuntimeUsageControls } from "~/components/BranchToolbar";
import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { TraitsPicker } from "~/components/chat/TraitsPicker";
import type { ScratchModelDraft } from "~/hooks/useScratchComposerDraft";
import type { ScratchModelCatalog } from "~/hooks/useScratchModelCatalog";

/**
 * Model picker plus the separate effort/thinking/speed picker, like a fresh chat
 * composer. Renders two siblings so the caller's wrapper decides the row and gap.
 */
export function ScratchModelPickers({
  draft,
  catalog,
  providerStatuses,
}: {
  draft: ScratchModelDraft;
  catalog: ScratchModelCatalog;
  providerStatuses: readonly ServerProviderStatus[];
}) {
  const { settings } = useAppSettings();
  return (
    <>
      <ProviderModelPicker
        compact
        provider={draft.selectedProvider}
        model={draft.selectedModel ?? ""}
        lockedProvider={null}
        providers={providerStatuses}
        modelOptionsByProvider={catalog.modelOptionsByProvider}
        modelOptionsByProviderInstance={catalog.modelOptionsByProviderInstance}
        providerInstances={getProviderInstanceOptions(settings)}
        selectedProviderInstanceId={draft.selectedProviderInstanceId}
        loadingModelProviders={catalog.loadingModelProviders}
        discoveryErrorsByProvider={catalog.discoveryErrorsByProvider}
        hiddenProviders={settings.hiddenProviders}
        providerOrder={settings.providerOrder}
        onProviderModelChange={catalog.handleProviderModelChange}
        open={catalog.isModelPickerOpen}
        onOpenChange={catalog.setIsModelPickerOpen}
      />
      <TraitsPicker
        provider={draft.selectedProvider}
        selectedProviderInstanceId={draft.selectedProviderInstanceId}
        threadId={draft.scratchThreadId}
        model={draft.selectedModel}
        runtimeModel={catalog.selectedRuntimeModel}
        runtimeModels={catalog.runtimeModelsByProvider[draft.selectedProvider]}
        runtimeAgents={catalog.selectedRuntimeAgents}
        modelOptions={draft.selectedProviderModelOptions}
        prompt={draft.prompt}
        onPromptChange={draft.setPrompt}
        open={catalog.isTraitsPickerOpen}
        onOpenChange={catalog.setIsTraitsPickerOpen}
      />
    </>
  );
}

/** The permissions (runtime mode) control for the scratch draft's provider and model. */
export function ScratchRuntimeControls({
  draft,
  catalog,
}: {
  draft: Pick<ScratchModelDraft, "selectedProvider">;
  catalog: ScratchModelCatalog;
}) {
  return (
    <RuntimeUsageControls
      provider={draft.selectedProvider}
      runtimeModel={catalog.runtimeModelForCapabilities}
      providerStatus={catalog.selectedProviderStatus}
      runtimeMode={catalog.runtimeMode}
      onRuntimeModeChange={catalog.setRuntimeMode}
    />
  );
}
