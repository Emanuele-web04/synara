// FILE: ComposerModelEffortPicker.tsx
// Purpose: Combined composer picker for model + effort/reasoning + speed in a single trigger.
// Layer: Chat composer presentation
// Depends on: provider/model menu items, traits menu content (which owns the fast-mode
//   toggle in its Effort header), shared menu primitives, and composer trait helpers.

import {
  PROVIDER_DISPLAY_NAMES,
  type ModelSlug,
  type ProviderAgentDescriptor,
  type ProviderKind,
  type ProviderModelDescriptor,
  type ProviderModelOptions,
  type ServerProviderStatus,
  type ThreadId,
} from "@synara/contracts";
import { useCallback, useRef, useState } from "react";

import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FastModeIcon,
  SettingsIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { ComposerModelPreset } from "../../lib/composerModelPresets";
import { type ProviderModelOption } from "../../providerModelOptions";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ShortcutKbd } from "../ui/shortcut-kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "../ProviderIcon";
import {
  COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME,
  COMPOSER_PICKER_MODEL_PANEL_CLASS_NAME,
  COMPOSER_PICKER_PROVIDER_PANEL_CLASS_NAME,
  COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
} from "./composerPickerStyles";
import { ComposerEffortSliderCard } from "./ComposerEffortSliderCard";
import { ComposerModelPresetMenu } from "./ComposerModelPresetMenu";
import { captureComposerModelPreset } from "./composerModelPresetSelection";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
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
  onProviderModelChange: (
    provider: ProviderKind,
    model: ModelSlug,
    preset?: ComposerModelPreset,
  ) => void | Promise<boolean | void>;
  onSelectionCommitted?: () => void;

  // Traits/effort/speed data.
  threadId: ThreadId;
  runtimeModel?: ProviderModelDescriptor | undefined;
  runtimeModels?: ReadonlyArray<ProviderModelDescriptor> | null | undefined;
  runtimeModelsByProvider?: Partial<
    Record<ProviderKind, ReadonlyArray<ProviderModelDescriptor> | null>
  >;
  runtimeAgents?: ReadonlyArray<ProviderAgentDescriptor> | null | undefined;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;

  // Shared menu control.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  shortcutLabel?: string | null;
};

// One compact panel before and after chat startup: saved configurations first,
// then the current model, reasoning and speed controls. The provider/catalog
// replaces the panel's contents and continues to respect the session's provider lock.
export function ComposerModelEffortPicker(props: ComposerModelEffortPickerProps) {
  const { onOpenChange, open } = props;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [catalogPage, setCatalogPage] = useState<"configuration" | "providers" | ProviderKind>(
    "configuration",
  );
  const focusNextPageRef = useRef(false);
  const lastBrowsedProviderRef = useRef<ProviderKind | null>(null);
  const isMenuOpen = open ?? uncontrolledOpen;
  const currentPage =
    catalogPage === "configuration" ? catalogPage : (props.lockedProvider ?? catalogPage);
  const navigateTo = (nextPage: typeof catalogPage) => {
    focusNextPageRef.current = true;
    setCatalogPage(nextPage);
  };
  const browseModels = () => navigateTo(props.lockedProvider ?? "providers");
  const goBack = () =>
    navigateTo(
      currentPage !== "providers" && props.lockedProvider === null ? "providers" : "configuration",
    );
  const focusPage = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element || !focusNextPageRef.current) return;
      focusNextPageRef.current = false;
      // Let the menu register the new page's items before focusing one, so its
      // roving index agrees with DOM focus on the very next arrow-key press.
      const frame = requestAnimationFrame(() => {
        const target =
          currentPage === "configuration"
            ? element.querySelector<HTMLElement>("[data-model-catalog-trigger]")
            : (element.querySelector<HTMLElement>('input[type="search"]') ??
              element.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ??
              (lastBrowsedProviderRef.current
                ? element.querySelector<HTMLElement>(
                    `[data-browse-provider="${lastBrowsedProviderRef.current}"]`,
                  )
                : null) ??
              element.querySelector<HTMLElement>("[data-current-provider]") ??
              element.querySelector<HTMLElement>(
                '[role="menuitemradio"], [data-browse-provider]',
              ) ??
              element.querySelector<HTMLElement>("[data-catalog-back]"));
        target?.focus();
      });
      return () => cancelAnimationFrame(frame);
    },
    [currentPage],
  );

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

  const hiddenTriggerTitle = [
    props.hideModelLabel ? modelLabel : null,
    props.hideStatusLabel ? triggerStatusLabel : null,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" · ");

  const triggerButton = (
    <Button
      size="sm"
      variant="chrome"
      disabled={props.disabled ?? false}
      className={cn(
        "min-w-0 shrink-0 justify-start gap-1.5 whitespace-nowrap px-2 sm:px-2.5 [&_svg]:mx-0",
        COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
      )}
      aria-label="Change model and reasoning"
      {...(hiddenTriggerTitle.length > 0 ? { title: hiddenTriggerTitle } : {})}
    />
  );

  const triggerContent = (
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      <ProviderIcon
        aria-hidden="true"
        className={cn(
          // opacity-100 opts out of the Button base's [&_svg]:opacity-80 dimming.
          "size-3.5 shrink-0 opacity-100",
          getProviderIconClassName(activeProvider, "text-[var(--color-text-foreground)]"),
        )}
      />
      {props.hideModelLabel ? (
        <span className="sr-only">{modelLabel}</span>
      ) : (
        <span className="min-w-0 truncate text-[var(--color-text-foreground)]">{modelLabel}</span>
      )}
      {showsFastBadge ? (
        <FastModeIcon
          aria-hidden="true"
          className={cn("size-3.5 shrink-0", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)}
        />
      ) : null}
      {triggerStatusLabel ? (
        props.hideStatusLabel ? (
          <>
            <SettingsIcon
              aria-hidden="true"
              className={cn("size-3.5 shrink-0", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)}
            />
            <span className="sr-only">{triggerStatusLabel}</span>
          </>
        ) : (
          <span className={cn("shrink-0", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)}>
            {triggerStatusLabel}
          </span>
        )
      ) : null}
      <ChevronDownIcon aria-hidden="true" className="ms-0.5 size-3 shrink-0 opacity-60" />
    </span>
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
      // Page swaps and filtering move rows beneath a stationary pointer. Keep
      // hover visual-only so it cannot take keyboard focus from the search field.
      highlightItemOnHover={false}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) {
          setCatalogPage("configuration");
          focusNextPageRef.current = false;
          lastBrowsedProviderRef.current = null;
        }
      }}
      onOpenChange={(nextOpen, eventDetails) => {
        // Configuration rows update in place, leaving the save star reachable.
        // Applying a preset closes explicitly after the asynchronous commit succeeds.
        if (!nextOpen && eventDetails.reason === "item-press") {
          eventDetails.cancel();
          return;
        }
        if (props.disabled) {
          setMenuOpen(false);
          return;
        }
        setMenuOpen(nextOpen);
      }}
    >
      {props.shortcutLabel ? (
        <Tooltip>
          <TooltipTrigger render={<MenuTrigger render={triggerButton} />}>
            {triggerContent}
          </TooltipTrigger>
          {!isMenuOpen ? (
            <TooltipPopup side="top" sideOffset={6} variant="picker">
              <span className="inline-flex items-center gap-2 px-1 py-0.5">
                <span>Change model</span>
                <ShortcutKbd
                  shortcutLabel={props.shortcutLabel}
                  className="h-4 min-w-4 px-1 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground"
                />
              </span>
            </TooltipPopup>
          ) : null}
        </Tooltip>
      ) : (
        <MenuTrigger render={triggerButton}>{triggerContent}</MenuTrigger>
      )}
      <ComposerPickerMenuPopup
        align="end"
        side="top"
        className={cn(
          currentPage === "providers"
            ? COMPOSER_PICKER_PROVIDER_PANEL_CLASS_NAME
            : COMPOSER_PICKER_MODEL_PANEL_CLASS_NAME,
          "rounded-[1.25rem]",
          "[&_[role^=menuitem]:not([data-disabled]):hover]:bg-[var(--color-background-button-secondary-hover)]",
        )}
        onKeyDownCapture={(event) => {
          if (
            currentPage !== "configuration" &&
            (event.key === "Escape" ||
              (event.key === "ArrowLeft" &&
                !(
                  event.target instanceof HTMLInputElement ||
                  event.target instanceof HTMLTextAreaElement
                )))
          ) {
            event.preventDefault();
            event.stopPropagation();
            goBack();
            return;
          }
          // This panel mixes menu rows and native form controls. Let Tab follow
          // their DOM order instead of the menu's Shift+Tab-to-dismiss behavior.
          if (event.key === "Tab") event.stopPropagation();
        }}
      >
        <div key={currentPage} ref={focusPage}>
          {currentPage !== "configuration" ? (
            <>
              <MenuItem
                data-catalog-back=""
                aria-label={
                  currentPage === "providers" || props.lockedProvider !== null
                    ? "Back to configuration"
                    : "Back to providers"
                }
                className="text-muted-foreground"
                closeOnClick={false}
                onClick={goBack}
              >
                <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
                <span>
                  {currentPage === "providers" ? "Providers" : PROVIDER_DISPLAY_NAMES[currentPage]}
                </span>
              </MenuItem>
              <MenuSeparator />
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
                navigation={{
                  provider: currentPage === "providers" ? null : currentPage,
                  onProviderBrowse: (provider) => {
                    lastBrowsedProviderRef.current = provider;
                    navigateTo(provider);
                  },
                }}
                onProviderModelChange={props.onProviderModelChange}
                onAfterSelection={() => navigateTo("configuration")}
              />
            </>
          ) : (
            <ComposerModelPresetMenu
              currentPreset={captureComposerModelPreset({
                provider: props.provider,
                model: props.model,
                selection: traitSelection,
              })}
              modelLabel={modelLabel}
              lockedProvider={props.lockedProvider}
              providers={props.providers}
              hiddenProviders={props.hiddenProviders}
              modelOptionsByProvider={props.modelOptionsByProvider}
              loadingModelProviders={props.loadingModelProviders}
              runtimeModelsByProvider={
                props.runtimeModelsByProvider ?? {
                  [props.provider]:
                    props.runtimeModels ?? (props.runtimeModel ? [props.runtimeModel] : []),
                }
              }
              prompt={props.prompt}
              onApply={(preset) =>
                props.onProviderModelChange(preset.provider, preset.model, preset)
              }
              onApplied={() => {
                setMenuOpen(false);
                props.onSelectionCommitted?.();
              }}
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
                    onBrowseModels={browseModels}
                  />
                  {hasSliderCompanionTraits ? (
                    <>
                      <MenuSeparator />
                      <TraitsMenuContent {...traitsMenuContentProps} excludeEffort />
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  {hasTraitsTopSection ? <TraitsMenuContent {...traitsMenuContentProps} /> : null}

                  {hasTraitsTopSection ? <MenuSeparator /> : null}

                  <MenuItem
                    data-model-catalog-trigger=""
                    closeOnClick={false}
                    className="data-highlighted:bg-transparent hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:bg-[var(--color-background-button-secondary-hover)]"
                    onClick={browseModels}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowRight") {
                        event.preventDefault();
                        event.stopPropagation();
                        browseModels();
                      }
                    }}
                  >
                    <ProviderIcon
                      aria-hidden="true"
                      className={cn("size-3 shrink-0", getProviderIconClassName(activeProvider))}
                    />
                    <span className="truncate">{modelLabel}</span>
                    <ChevronRightIcon aria-hidden="true" className="-me-0.5 shrink-0" />
                  </MenuItem>
                  {!hasTraitsTopSection && !props.loadingModelProviders?.[props.provider] ? (
                    <p className="px-2 pt-1 text-[11px] text-muted-foreground/75">
                      No adjustable settings for this model.
                    </p>
                  ) : null}
                </>
              )}
            </ComposerModelPresetMenu>
          )}
        </div>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
