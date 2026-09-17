// FILE: ComposerModelEffortPicker.tsx
// Purpose: Combined composer picker for model + effort/reasoning + speed in a single trigger.
// Layer: Chat composer presentation
// Depends on: provider/model menu items, traits menu content (which owns the fast-mode
//   toggle in its Effort header), shared menu primitives, and composer trait helpers.

import {
  type ModelSlug,
  type ProviderAgentDescriptor,
  type ProviderKind,
  type ProviderModelDescriptor,
  type ProviderModelOptions,
  type ServerProviderStatus,
  type ThreadId,
} from "@synara/contracts";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { type ProviderModelOption } from "../../providerModelOptions";
import { Menu, MenuSeparator, MenuSub, MenuSubTrigger } from "../ui/menu";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "../ProviderIcon";
import { COMPOSER_PICKER_MODEL_SUBMENU_HEIGHT_CLASS_NAME } from "./composerPickerStyles";
import { ComposerEffortSliderCard } from "./ComposerEffortSliderCard";
import { ComposerModelMenuTrigger } from "./ComposerModelMenuTrigger";
import { ComposerPickerMenuPopup, ComposerPickerMenuSubPopup } from "./ComposerPickerMenuPopup";
import {
  getComposerTraitSelection,
  hasVisibleComposerTraitControls,
  resolveComposerTraitStatusLabel,
  showsComposerFastModeBadge,
} from "./composerTraits";
import {
  getProviderIconClassName,
  ProviderModelMenuItems,
  resolveProviderModelLabel,
} from "./ProviderModelPicker";
import { hasComposerAgentControls, TraitsMenuContent } from "./TraitsPicker";

export type ComposerEffortControl = "menu" | "slider";

type ComposerModelEffortPickerProps = {
  // Model picker data.
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProviderStatus>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  loadingModelProviders?: Partial<Record<ProviderKind, boolean>>;
  discoveryErrorsByProvider?: Partial<Record<ProviderKind, string | undefined>>;
  hiddenProviders?: ReadonlyArray<ProviderKind>;
  providerOrder?: ReadonlyArray<ProviderKind>;
  compact?: boolean;
  // Narrow-composer degradation: drop the model name (provider icon stays)
  // and/or the effort/status label; both remain available to assistive tech.
  hideModelLabel?: boolean;
  hideStatusLabel?: boolean;
  disabled?: boolean;
  // "menu" (default) lists effort levels as radio rows; "slider" renders the
  // effort ladder as a stepped slider card with the model list behind its label.
  // Models without an effort ladder always fall back to the menu layout.
  effortControl?: ComposerEffortControl;
  onProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
  onSelectionCommitted?: () => void;

  // Traits/effort/speed data.
  threadId: ThreadId;
  runtimeModel?: ProviderModelDescriptor | undefined;
  runtimeModels?: ReadonlyArray<ProviderModelDescriptor> | null | undefined;
  runtimeAgents?: ReadonlyArray<ProviderAgentDescriptor> | null | undefined;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;

  // Shared menu control.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  shortcutLabel?: string | null;
};

// Renders a single composer trigger that combines model selection, reasoning
// effort, and the optional speed/fast-mode toggle. The primary menu hosts the
// reasoning radio group (with fast mode as an icon toggle in its Effort
// header); the model is reachable via a sub-menu so the footer stays compact.
export function ComposerModelEffortPicker(props: ComposerModelEffortPickerProps) {
  const { onOpenChange, open } = props;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isMenuOpen = open ?? uncontrolledOpen;

  const setMenuOpen = (nextOpen: boolean) => {
    if (open === undefined) {
      setUncontrolledOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };

  const activeProvider = props.lockedProvider ?? props.provider;
  const ProviderIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[activeProvider];
  const modelLabel = resolveProviderModelLabel({
    provider: props.provider,
    lockedProvider: props.lockedProvider,
    model: props.model,
    modelOptionsByProvider: props.modelOptionsByProvider,
  });

  const traitSelection = getComposerTraitSelection(
    props.provider,
    props.model,
    props.prompt,
    props.modelOptions,
    props.runtimeModel,
  );

  const hasTraitsTopSection = hasVisibleComposerTraitControls(traitSelection);
  const usesEffortSlider =
    props.effortControl === "slider" && traitSelection.effortLevels.length > 0;
  // Trait sections the slider card does not own (thinking, context window, agent).
  const hasSliderCompanionTraits =
    usesEffortSlider &&
    (hasVisibleComposerTraitControls(traitSelection, {
      includeEffort: false,
      includeFastMode: false,
    }) ||
      hasComposerAgentControls(props.provider, props.runtimeAgents));

  const triggerStatusLabel = resolveComposerTraitStatusLabel(traitSelection);
  const showsFastBadge = showsComposerFastModeBadge(traitSelection);

  const handleAfterModelSelection = () => {
    setMenuOpen(false);
    props.onSelectionCommitted?.();
  };

  const handleAfterTraitsSelection = () => {
    setMenuOpen(false);
    props.onSelectionCommitted?.();
  };

  // Shared between the radio and slider layouts so both reach the same model list;
  // each layout decides what a committed model selection closes.
  const renderModelSubmenuPopup = (onAfterSelection: () => void) => (
    <ComposerPickerMenuSubPopup
      fixedWidth
      className={COMPOSER_PICKER_MODEL_SUBMENU_HEIGHT_CLASS_NAME}
    >
      <ProviderModelMenuItems
        provider={props.provider}
        model={props.model}
        lockedProvider={props.lockedProvider}
        {...(props.providers ? { providers: props.providers } : {})}
        modelOptionsByProvider={props.modelOptionsByProvider}
        {...(props.loadingModelProviders
          ? { loadingModelProviders: props.loadingModelProviders }
          : {})}
        {...(props.discoveryErrorsByProvider
          ? { discoveryErrorsByProvider: props.discoveryErrorsByProvider }
          : {})}
        {...(props.hiddenProviders ? { hiddenProviders: props.hiddenProviders } : {})}
        {...(props.providerOrder ? { providerOrder: props.providerOrder } : {})}
        {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
        onProviderModelChange={props.onProviderModelChange}
        onAfterSelection={onAfterSelection}
      />
    </ComposerPickerMenuSubPopup>
  );

  const traitsMenuContentProps = {
    provider: props.provider,
    threadId: props.threadId,
    model: props.model,
    ...(props.runtimeModel ? { runtimeModel: props.runtimeModel } : {}),
    ...(props.runtimeModels !== undefined ? { runtimeModels: props.runtimeModels } : {}),
    ...(props.runtimeAgents !== undefined ? { runtimeAgents: props.runtimeAgents } : {}),
    modelOptions: props.modelOptions,
    prompt: props.prompt,
    onPromptChange: props.onPromptChange,
  };

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(nextOpen) => {
        if (props.disabled) {
          setMenuOpen(false);
          return;
        }
        setMenuOpen(nextOpen);
      }}
    >
      <ComposerModelMenuTrigger
        provider={activeProvider}
        modelLabel={modelLabel}
        statusLabel={triggerStatusLabel}
        showsFastBadge={showsFastBadge}
        hideModelLabel={props.hideModelLabel}
        hideStatusLabel={props.hideStatusLabel}
        disabled={props.disabled}
        isMenuOpen={isMenuOpen}
        shortcutLabel={props.shortcutLabel}
      />
      <ComposerPickerMenuPopup
        align="end"
        side="top"
        {...(usesEffortSlider
          ? // Standard picker width; rounder shell so the slider reads as a card, not a menu.
            { fixedWidth: true, className: "rounded-[1.25rem]" }
          : { fixedWidth: true })}
      >
        {usesEffortSlider ? (
          <>
            <ComposerEffortSliderCard
              provider={props.provider}
              threadId={props.threadId}
              model={props.model}
              modelLabel={modelLabel}
              {...(props.runtimeModel ? { runtimeModel: props.runtimeModel } : {})}
              modelOptions={props.modelOptions}
              prompt={props.prompt}
              onPromptChange={props.onPromptChange}
              renderModelSubmenuPopup={renderModelSubmenuPopup}
            />
            {hasSliderCompanionTraits ? (
              <>
                <MenuSeparator />
                <TraitsMenuContent
                  {...traitsMenuContentProps}
                  excludeEffort
                  onSelectionComplete={handleAfterTraitsSelection}
                />
              </>
            ) : null}
          </>
        ) : (
          <>
            {hasTraitsTopSection ? (
              <TraitsMenuContent
                {...traitsMenuContentProps}
                onSelectionComplete={handleAfterTraitsSelection}
              />
            ) : null}

            {hasTraitsTopSection ? <MenuSeparator /> : null}

            <MenuSub>
              <MenuSubTrigger>
                <ProviderIcon
                  aria-hidden="true"
                  className={cn("size-3 shrink-0", getProviderIconClassName(activeProvider))}
                />
                <span className="truncate">{modelLabel}</span>
              </MenuSubTrigger>
              {renderModelSubmenuPopup(handleAfterModelSelection)}
            </MenuSub>
          </>
        )}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
