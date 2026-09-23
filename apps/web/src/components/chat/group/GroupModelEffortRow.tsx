import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { ModelSelection, ProviderKind, ProviderModelDescriptor } from "@synara/contracts";

import { useAppSettings } from "~/appSettings";
import { useProviderModelCatalog } from "~/hooks/useProviderModelCatalog";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import {
  buildModelSelection,
  buildNextProviderOptions,
  buildProviderOptionPatch,
  type ProviderOptions,
} from "~/providerModelOptions";
import { SettingsRow } from "~/components/settings/SettingsPanelPrimitives";
import { SettingsSelectControl } from "~/components/settings/SettingControls";
import { SelectItem } from "~/components/ui/select";
import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { getComposerTraitSelection } from "~/components/chat/composerTraits";
import { resolveRuntimeModelDescriptor } from "~/components/chat/runtimeModelCapabilities";
import { cn } from "~/lib/utils";

import { modelSelectionsEqual } from "./groupSettingsDialog.logic";

function useGroupModelCatalog(input: {
  readonly selection: ModelSelection;
  readonly projectCwd: string;
  readonly pickerOpen: boolean;
}) {
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  return useProviderModelCatalog({
    selectedProvider: input.selection.provider,
    discoveryEnabled: input.pickerOpen,
    // Warm discovery for the row's provider so dynamic effort levels are known
    // even when the model picker itself never opens.
    prefetchProviders: [input.selection.provider],
    cwd: resolveProviderDiscoveryCwd({
      activeThreadWorktreePath: null,
      activeProjectCwd: input.projectCwd.length > 0 ? input.projectCwd : null,
      serverCwd: serverConfigQuery.data?.cwd ?? null,
    }),
    modelHintByProvider: { [input.selection.provider]: input.selection.model },
  });
}

/**
 * Reapply the current effort override on a model change when the new model
 * exposes the same option id and accepts the same value; otherwise drop it.
 */
function carryEffortOverride(input: {
  readonly current: ModelSelection;
  readonly currentRuntimeModel: ProviderModelDescriptor | undefined;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly runtimeModel: ProviderModelDescriptor | undefined;
}): ProviderOptions | undefined {
  const options = input.current.options;
  if (options === undefined) return undefined;
  const optionId = getComposerTraitSelection(
    input.current.provider,
    input.current.model,
    "",
    options,
    input.currentRuntimeModel,
  ).primarySelectDescriptor?.id;
  if (optionId === undefined) return undefined;
  const value = (options as Record<string, unknown>)[optionId];
  if (typeof value !== "string") return undefined;
  const nextTraits = getComposerTraitSelection(
    input.provider,
    input.model,
    "",
    undefined,
    input.runtimeModel,
  );
  if (
    nextTraits.primarySelectDescriptor?.id !== optionId ||
    !nextTraits.effortLevels.some((option) => option.value === value)
  ) {
    return undefined;
  }
  return buildNextProviderOptions(
    input.provider,
    undefined,
    buildProviderOptionPatch(input.provider, optionId, value),
  );
}

function UseDefaultLink(props: { readonly disabled: boolean; readonly onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      className={cn(
        "text-ui-sm text-muted-foreground hover:text-foreground",
        props.disabled && "cursor-default opacity-50 hover:text-muted-foreground",
      )}
      onClick={props.onClick}
    >
      Use default
    </button>
  );
}

export function GroupModelRow(props: {
  readonly title: string;
  readonly description: string;
  readonly selection: ModelSelection;
  readonly defaultSelection: ModelSelection | null;
  readonly projectCwd: string;
  readonly onChange: (next: ModelSelection) => void;
}) {
  const { settings } = useAppSettings();
  const providerStatuses = useProviderStatusesForLocalConfig();
  const [pickerOpen, setPickerOpen] = useState(false);
  const {
    modelOptionsByProvider,
    loadingModelProviders,
    discoveryErrorsByProvider,
    runtimeModelsByProvider,
  } = useGroupModelCatalog({
    selection: props.selection,
    projectCwd: props.projectCwd,
    pickerOpen,
  });
  const isDefault =
    props.defaultSelection !== null &&
    modelSelectionsEqual(props.selection, props.defaultSelection);

  return (
    <SettingsRow
      title={props.title}
      description={props.description}
      control={
        <div className="flex w-full flex-col items-stretch gap-1 sm:w-auto sm:items-end">
          <ProviderModelPicker
            compact
            provider={props.selection.provider}
            model={props.selection.model}
            lockedProvider={null}
            providers={providerStatuses}
            modelOptionsByProvider={modelOptionsByProvider}
            loadingModelProviders={loadingModelProviders}
            discoveryErrorsByProvider={discoveryErrorsByProvider}
            hiddenProviders={settings.hiddenProviders}
            providerOrder={settings.providerOrder}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onProviderModelChange={(provider, model) => {
              const runtimeModel = resolveRuntimeModelDescriptor({
                provider,
                model,
                runtimeModels: runtimeModelsByProvider[provider],
              });
              const options = carryEffortOverride({
                current: props.selection,
                currentRuntimeModel: resolveRuntimeModelDescriptor({
                  provider: props.selection.provider,
                  model: props.selection.model,
                  runtimeModels: runtimeModelsByProvider[props.selection.provider],
                }),
                provider,
                model,
                runtimeModel,
              });
              props.onChange(
                buildModelSelection(provider, model, options, runtimeModel?.supportsAutoMode),
              );
            }}
          />
          {props.defaultSelection ? (
            <UseDefaultLink
              disabled={isDefault}
              onClick={() => {
                const fallback = props.defaultSelection;
                if (fallback) props.onChange(fallback);
              }}
            />
          ) : null}
        </div>
      }
    />
  );
}

export function GroupEffortRow(props: {
  readonly title: string;
  readonly description: string;
  readonly selection: ModelSelection;
  readonly projectCwd: string;
  readonly onChange: (next: ModelSelection) => void;
}) {
  const { runtimeModelsByProvider, selectedProviderModelsLoading } = useGroupModelCatalog({
    selection: props.selection,
    projectCwd: props.projectCwd,
    pickerOpen: false,
  });
  const runtimeModel = resolveRuntimeModelDescriptor({
    provider: props.selection.provider,
    model: props.selection.model,
    runtimeModels: runtimeModelsByProvider[props.selection.provider],
  });
  const traits = getComposerTraitSelection(
    props.selection.provider,
    props.selection.model,
    "",
    props.selection.options ?? undefined,
    runtimeModel,
  );
  const optionId = traits.primarySelectDescriptor?.id ?? null;
  const effortOptions = traits.effortLevels.filter(
    (option) => !traits.promptInjectedValues.includes(option.value),
  );
  const hasOverride =
    optionId !== null &&
    props.selection.options !== undefined &&
    optionId in props.selection.options;

  if (effortOptions.length === 0 || optionId === null) {
    return (
      <SettingsRow
        title={props.title}
        description={props.description}
        status={
          <span className="text-muted-foreground">
            {selectedProviderModelsLoading
              ? "Checking effort support…"
              : `Not available for ${props.selection.model}.`}
          </span>
        }
      />
    );
  }

  const handleEffortChange = (value: string) => {
    const patch = buildProviderOptionPatch(props.selection.provider, optionId, value);
    const options = buildNextProviderOptions(
      props.selection.provider,
      props.selection.options ?? undefined,
      patch,
    );
    props.onChange(
      buildModelSelection(
        props.selection.provider,
        props.selection.model,
        options,
        "supportsAutoMode" in props.selection ? props.selection.supportsAutoMode : undefined,
      ),
    );
  };

  const handleUseDefault = () => {
    const options = props.selection.options;
    if (!options || !(optionId in options)) return;
    const nextOptions = { ...(options as Record<string, unknown>) };
    delete nextOptions[optionId];
    props.onChange(
      buildModelSelection(
        props.selection.provider,
        props.selection.model,
        Object.keys(nextOptions).length > 0 ? (nextOptions as typeof options) : undefined,
        "supportsAutoMode" in props.selection ? props.selection.supportsAutoMode : undefined,
      ),
    );
  };

  const currentEffort = traits.effort ?? effortOptions[0]!.value;
  const currentLabel =
    effortOptions.find((option) => option.value === currentEffort)?.label ?? currentEffort;

  return (
    <SettingsRow
      title={props.title}
      description={props.description}
      control={
        <div className="flex w-full flex-col items-stretch gap-1 sm:w-auto sm:items-end">
          <SettingsSelectControl
            value={currentEffort}
            onValueChange={handleEffortChange}
            ariaLabel={props.title}
            valueContent={currentLabel}
          >
            {effortOptions.map((option) => (
              <SelectItem key={option.value} value={option.value} hideIndicator>
                {option.label}
              </SelectItem>
            ))}
          </SettingsSelectControl>
          <UseDefaultLink disabled={!hasOverride} onClick={handleUseDefault} />
        </div>
      }
    />
  );
}
