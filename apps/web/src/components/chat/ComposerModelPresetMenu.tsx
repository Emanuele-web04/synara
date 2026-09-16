// FILE: ComposerModelPresetMenu.tsx
// Purpose: Compact saved configurations above the current model/effort controls.
// Layer: Composer presentation and local preferences; selection is delegated to ChatView.

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ProviderModelDescriptor,
  type ServerProviderStatus,
} from "@synara/contracts";
import { type ReactNode, useRef, useState } from "react";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  COMPOSER_MODEL_PRESETS_STORAGE_KEY,
  ComposerModelPresetsSchema,
  EMPTY_COMPOSER_MODEL_PRESETS,
  composerModelPresetKey,
  composerModelPresetReasoningLabel,
  normalizeComposerModelPresets,
  toggleComposerModelPreset,
  type ComposerModelPreset,
} from "../../lib/composerModelPresets";
import { StarFilledIcon, StarIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import type { ProviderModelOption } from "../../providerModelOptions";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "../ProviderIcon";
import { MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator } from "../ui/menu";
import { planComposerModelPreset } from "./composerModelPresetSelection";
import { resolveRuntimeModelDescriptor } from "./runtimeModelCapabilities";

type ComposerModelPresetMenuProps = {
  currentPreset: ComposerModelPreset;
  modelLabel: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProviderStatus> | undefined;
  hiddenProviders?: ReadonlyArray<ProviderKind> | undefined;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  loadingModelProviders?: Partial<Record<ProviderKind, boolean>> | undefined;
  runtimeModelsByProvider?:
    | Partial<Record<ProviderKind, ReadonlyArray<ProviderModelDescriptor> | null>>
    | undefined;
  prompt: string;
  onApply: (preset: ComposerModelPreset) => void | Promise<boolean | void>;
  onApplied: () => void;
  children: ReactNode;
};

const STAR_BUTTON_CLASS_NAME =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60 disabled:opacity-40";

export function ComposerModelPresetMenu(props: ComposerModelPresetMenuProps) {
  const [storedPresets, setPresets] = useLocalStorage(
    COMPOSER_MODEL_PRESETS_STORAGE_KEY,
    EMPTY_COMPOSER_MODEL_PRESETS,
    ComposerModelPresetsSchema,
  );
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const presets = normalizeComposerModelPresets(storedPresets);
  const visiblePresets = presets.filter((preset) =>
    props.lockedProvider !== null
      ? preset.provider === props.lockedProvider
      : !props.hiddenProviders?.includes(preset.provider),
  );
  const currentKey = composerModelPresetKey(props.currentPreset);
  const currentIsSaved = presets.some((preset) => composerModelPresetKey(preset) === currentKey);
  const currentLabel = [props.modelLabel, composerModelPresetReasoningLabel(props.currentPreset)]
    .filter(Boolean)
    .join(" · ");

  const applyPreset = async (preset: ComposerModelPreset) => {
    if (applying) return;
    setApplying(true);
    setApplyError(null);
    try {
      const applied = await props.onApply(preset);
      if (applied === false) {
        setApplyError("Could not apply this preset. Your configuration has not changed.");
      } else {
        props.onApplied();
      }
    } catch {
      setApplyError("Could not apply this preset. Please try again.");
    } finally {
      setApplying(false);
    }
  };

  return (
    <>
      <MenuGroup aria-label="Presets">
        <MenuGroupLabel>Presets</MenuGroupLabel>
        {visiblePresets.length === 0 ? (
          <p className="px-2 pb-1.5 text-[11px] text-muted-foreground/75">
            Save a model + effort with the star below.
          </p>
        ) : (
          <div className="composer-picker-scroll max-h-44 overflow-y-auto">
            {visiblePresets.map((preset) => {
              const modelLabel =
                props.modelOptionsByProvider[preset.provider].find(
                  (option) => option.slug === preset.model,
                )?.name ?? preset.model;
              const label = [modelLabel, composerModelPresetReasoningLabel(preset)]
                .filter(Boolean)
                .join(" · ");
              const key = composerModelPresetKey(preset);
              const plan = planComposerModelPreset({
                preset,
                lockedProvider: props.lockedProvider,
                availableModels: props.modelOptionsByProvider[preset.provider],
                providerAvailable:
                  props.providers?.some(
                    (provider) => provider.provider === preset.provider && provider.available,
                  ) ?? true,
                loading: props.loadingModelProviders?.[preset.provider] ?? false,
                runtimeModel: resolveRuntimeModelDescriptor({
                  provider: preset.provider,
                  model: preset.model,
                  runtimeModels: props.runtimeModelsByProvider?.[preset.provider],
                }),
                prompt: props.prompt,
              });
              const ProviderIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[preset.provider];
              return (
                <div key={key} className="flex min-w-0 items-center gap-0.5">
                  <MenuItem
                    closeOnClick={false}
                    disabled={applying || plan.kind === "unavailable"}
                    aria-label={`Apply ${label} (${PROVIDER_DISPLAY_NAMES[preset.provider]})`}
                    title={
                      plan.kind === "unavailable"
                        ? `${label} — ${plan.reason}`
                        : `${label} — ${PROVIDER_DISPLAY_NAMES[preset.provider]}`
                    }
                    className={cn(
                      "min-w-0 flex-1 px-2 py-1 text-[11px]",
                      key === currentKey && "bg-[var(--color-background-button-secondary)]",
                    )}
                    onClick={() => void applyPreset(preset)}
                  >
                    {props.lockedProvider === null ? (
                      <ProviderIcon aria-hidden="true" className="size-3 shrink-0" />
                    ) : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{label}</span>
                      {plan.kind === "unavailable" ? (
                        <span className="block whitespace-normal text-[10px] text-muted-foreground">
                          {plan.reason}
                        </span>
                      ) : null}
                    </span>
                  </MenuItem>
                  <button
                    type="button"
                    aria-label={`Remove ${label} preset (${PROVIDER_DISPLAY_NAMES[preset.provider]})`}
                    title="Remove preset"
                    disabled={applying}
                    className={cn(STAR_BUTTON_CLASS_NAME, "text-amber-400")}
                    onClick={() => {
                      setPresets((current) =>
                        current.filter((entry) => composerModelPresetKey(entry) !== key),
                      );
                      saveButtonRef.current?.focus();
                    }}
                  >
                    <StarFilledIcon aria-hidden="true" className="size-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </MenuGroup>
      <MenuSeparator />
      <div className="flex items-center justify-between gap-1 px-2">
        <span className="text-[10px] font-medium text-muted-foreground/75">
          Current configuration
        </span>
        <button
          ref={saveButtonRef}
          type="button"
          aria-label={
            currentIsSaved ? `Remove ${currentLabel} preset` : `Save ${currentLabel} as preset`
          }
          aria-pressed={currentIsSaved}
          title={currentIsSaved ? "Remove current preset" : "Save model + effort"}
          disabled={applying}
          className={cn(STAR_BUTTON_CLASS_NAME, currentIsSaved && "text-amber-400")}
          onClick={() =>
            setPresets((current) => toggleComposerModelPreset(current, props.currentPreset))
          }
        >
          {currentIsSaved ? (
            <StarFilledIcon aria-hidden="true" className="size-3" />
          ) : (
            <StarIcon aria-hidden="true" className="size-3" />
          )}
        </button>
      </div>
      <div inert={applying} aria-busy={applying}>
        {props.children}
      </div>
      {applying || applyError ? (
        <p role="status" className="px-2 py-1 text-[11px] text-muted-foreground">
          {applying ? "Applying preset…" : applyError}
        </p>
      ) : null}
    </>
  );
}
