// FILE: ProviderModelPicker.tsx
// Purpose: Renders the composer provider/model menu and supports controlled opening for shortcuts.
// Layer: Chat composer presentation
// Depends on: provider availability metadata, shared menu primitives, and picker trigger styling.

import { type ModelSlug, type ProviderKind, type ServerProviderStatus } from "@synara/contracts";
import { resolveSelectableModel } from "@synara/shared/model";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { type ProviderPickerKind, PROVIDER_OPTIONS } from "../../session-logic";
import { appHistory } from "../../appNavigation";
import { formatProviderModelOptionName } from "../../providerModelOptions";
import { compareProvidersByOrder } from "../../providerOrdering";
import {
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "../ProviderIcon";
import { cn } from "~/lib/utils";
import { PickerPanelShell } from "./PickerPanelShell";
import { PickerTriggerButton } from "./PickerTriggerButton";
import { ProviderModelOptionGroupList } from "./ProviderModelOptionGroupList";
import { ComposerPickerMenuPopup, ComposerPickerMenuSubPopup } from "./ComposerPickerMenuPopup";
import {
  COMPOSER_PICKER_MODEL_PANEL_CLASS_NAME,
  COMPOSER_PICKER_PROVIDER_PANEL_CLASS_NAME,
} from "./composerPickerStyles";
import { ShortcutKbd } from "../ui/shortcut-kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type ProviderModelOption } from "../../providerModelOptions";
import { Skeleton } from "../ui/skeleton";
import { CheckIcon, ChevronRightIcon, PlusIcon, SearchIcon } from "~/lib/icons";

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderKind;
  label: string;
  available: true;
} {
  return option.available;
}

function resolveLiveProviderAvailability(provider: ServerProviderStatus | undefined): {
  disabled: boolean;
  label: string | null;
} {
  if (!provider) {
    return {
      disabled: true,
      label: "Checking",
    };
  }

  if (!provider.available) {
    return {
      disabled: true,
      label: provider.authStatus === "unauthenticated" ? "Sign in" : "Unavailable",
    };
  }

  if (provider.authStatus === "unauthenticated") {
    return {
      disabled: true,
      label: "Sign in",
    };
  }

  return {
    disabled: false,
    label: null,
  };
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

// Removes user-hidden providers from a provider option list while always
// preserving any providers the caller marks as protected (the active and
// locked provider for the current thread). Without that carve-out, hiding the
// provider you're already using would erase the entry that lets you switch
// away from it.
function filterProviderOptionsByVisibility<T extends { value: ProviderKind }>(
  options: ReadonlyArray<T>,
  hiddenProviders: ReadonlySet<ProviderKind>,
  protectedProviders: ReadonlySet<ProviderKind>,
): ReadonlyArray<T> {
  if (hiddenProviders.size === 0) {
    return options;
  }
  return options.filter(
    (option) => protectedProviders.has(option.value) || !hiddenProviders.has(option.value),
  );
}

function providerIconClassName(
  provider: ProviderKind | ProviderPickerKind,
  fallbackClassName: string,
): string {
  return provider === "claudeAgent" || provider === "antigravity" || provider === "pi"
    ? "text-foreground"
    : fallbackClassName;
}

const SEARCHABLE_MODEL_PICKER_THRESHOLD = 15;
function stripParameterizedModelSuffix(model: string): string {
  return model.trim().replace(/\[[^\]]*\]$/u, "");
}

function resolveSelectedModelLabel(input: {
  provider: ProviderKind;
  model: string;
  options: ReadonlyArray<ProviderModelOption>;
}): string {
  const resolvedSlug = resolveSelectableModel(input.provider, input.model, input.options);
  if (resolvedSlug) {
    const resolvedOption = input.options.find((option) => option.slug === resolvedSlug);
    if (resolvedOption) {
      return resolvedOption.name;
    }
  }
  if (input.provider === "cursor") {
    const baseModel = stripParameterizedModelSuffix(input.model);
    const baseMatch = input.options.find(
      (option) => stripParameterizedModelSuffix(option.slug) === baseModel,
    );
    if (baseMatch) {
      return baseMatch.name;
    }
  }
  return formatProviderModelOptionName({
    provider: input.provider,
    slug: input.model,
  });
}

function buildModelSearchText(option: ProviderModelOption): string {
  return [
    option.name,
    option.slug,
    option.description,
    option.upstreamProviderName,
    option.upstreamProviderId,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
}

type ProviderModelMenuItemsProps = {
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProviderStatus>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  loadingModelProviders?: Partial<Record<ProviderKind, boolean>>;
  discoveryErrorsByProvider?: Partial<Record<ProviderKind, string | undefined>>;
  hiddenProviders?: ReadonlyArray<ProviderKind>;
  providerOrder?: ReadonlyArray<ProviderKind>;
  disabled?: boolean;
  // The combined picker browses within its existing popup instead of stacking
  // provider/model submenus over the configuration panel.
  navigation?: {
    provider: ProviderKind | null;
    onProviderBrowse: (provider: ProviderKind) => void;
  };
  onProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
  // Invoked after a model selection commits so callers can close ancestor
  // menus and refocus the composer.
  onAfterSelection?: () => void;
};

// Renders only the popup body of the provider/model picker. Designed to be
// dropped into any shared picker popup or submenu so the same selection logic can
// be reused by the standalone picker and the combined composer trait picker.
export const ProviderModelMenuItems = function ProviderModelMenuItems(
  props: ProviderModelMenuItemsProps,
) {
  const { onAfterSelection } = props;
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const deferredModelSearchQuery = useDeferredValue(modelSearchQuery);
  const activeProvider = props.lockedProvider ?? props.provider;
  const hiddenProviders = props.hiddenProviders;
  const providerOrder = props.providerOrder;
  const hiddenProviderSet = new Set<ProviderKind>(hiddenProviders ?? []);
  const protectedProviderSet = new Set<ProviderKind>([props.provider]);
  if (props.lockedProvider !== null) {
    protectedProviderSet.add(props.lockedProvider);
  }
  const visibleAvailableProviderOptions = filterProviderOptionsByVisibility(
    AVAILABLE_PROVIDER_OPTIONS.toSorted((left, right) =>
      compareProvidersByOrder(providerOrder ?? [], left.value, right.value),
    ).filter((option) =>
      props.providers?.some((provider) => provider.provider === option.value && provider.available),
    ),
    hiddenProviderSet,
    protectedProviderSet,
  );
  const handleModelChange = (provider: ProviderKind, value: string) => {
    if (props.disabled) return;
    if (!value) return;
    const resolvedModel = resolveSelectableModel(
      provider,
      value,
      props.modelOptionsByProvider[provider],
    );
    if (!resolvedModel) return;
    props.onProviderModelChange(provider, resolvedModel);
    onAfterSelection?.();
  };
  const renderModelRadioGroup = (provider: ProviderKind) => {
    const providerOptions = props.modelOptionsByProvider[provider];
    const isLoading = props.loadingModelProviders?.[provider] ?? false;
    const providerLabel =
      PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ?? provider;
    const shouldShowSearch =
      !isLoading &&
      (provider === "opencode" ||
        provider === "cursor" ||
        provider === "devin" ||
        provider === "cline" ||
        provider === "pi") &&
      providerOptions.length >= SEARCHABLE_MODEL_PICKER_THRESHOLD;
    const normalizedModelSearchQuery = deferredModelSearchQuery.trim().toLowerCase();
    const filteredOptions =
      shouldShowSearch && normalizedModelSearchQuery.length > 0
        ? providerOptions.filter((option) =>
            buildModelSearchText(option).includes(normalizedModelSearchQuery),
          )
        : providerOptions;

    const discoveryError = props.discoveryErrorsByProvider?.[provider];
    const discoveryErrorElement = discoveryError ? (
      <div role="status" className="px-3 py-2 text-xs text-destructive">
        {discoveryError}
      </div>
    ) : null;

    const content = isLoading ? (
      <div className="space-y-2 px-2 py-2" role="status" aria-label="Loading models">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className={cn("h-3.5 rounded-full", index % 3 === 0 ? "w-24" : "w-32")} />
          </div>
        ))}
      </div>
    ) : filteredOptions.length > 0 ? (
      <MenuRadioGroup
        aria-label={`${providerLabel} models`}
        value={activeProvider === provider ? props.model : ""}
        onValueChange={(value) => handleModelChange(provider, value)}
      >
        <ProviderModelOptionGroupList
          key={provider}
          options={filteredOptions}
          provider={provider}
          activeModel={props.model}
          isSearching={normalizedModelSearchQuery.length > 0}
          {...(onAfterSelection ? { onAfterSelection } : {})}
        />
      </MenuRadioGroup>
    ) : (
      <div
        role="status"
        className="flex flex-col items-center gap-2 px-4 py-6 text-center text-muted-foreground"
      >
        <SearchIcon aria-hidden="true" className="size-5 opacity-60" />
        <span className="text-[length:var(--app-font-size-ui,12px)] text-foreground">
          {provider === "pi" && normalizedModelSearchQuery.length === 0
            ? "No Pi models found"
            : "No matches"}
        </span>
        {normalizedModelSearchQuery.length > 0 ? (
          <span className="text-[length:var(--app-font-size-ui-sm,11px)]">
            Try a different model or provider name.
          </span>
        ) : null}
      </div>
    );

    return (
      <>
        {!shouldShowSearch ? (
          <div className="shrink-0 px-2 pb-1.5 pt-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
            Select model
          </div>
        ) : null}
        <PickerPanelShell
          searchPlaceholder="Search models"
          query={modelSearchQuery}
          {...(shouldShowSearch ? { onQueryChange: setModelSearchQuery } : {})}
          stopSearchKeyPropagation
          autoFocusSearch
          widthClassName="w-full"
          variant="plain"
          listMaxHeightClassName="max-h-[min(16rem,55dvh)]"
        >
          {discoveryErrorElement}
          {content}
        </PickerPanelShell>
      </>
    );
  };

  if (props.lockedProvider !== null) {
    return <>{renderModelRadioGroup(props.lockedProvider)}</>;
  }
  if (props.navigation?.provider) {
    return <>{renderModelRadioGroup(props.navigation.provider)}</>;
  }

  return (
    <>
      {visibleAvailableProviderOptions.map((option) => {
        const OptionIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[option.value];
        const liveProvider = props.providers?.find((entry) => entry.provider === option.value);
        const availability = resolveLiveProviderAvailability(liveProvider);
        if (availability.disabled) {
          return (
            <MenuItem key={option.value} disabled>
              <OptionIcon
                aria-hidden="true"
                className={cn(
                  "size-3 shrink-0 opacity-80",
                  providerIconClassName(option.value, "text-muted-foreground/85"),
                )}
              />
              <span>{option.label}</span>
              <span className="ms-auto text-[11px] text-muted-foreground/80">
                {availability.label}
              </span>
            </MenuItem>
          );
        }
        const providerContent = (
          <>
            <OptionIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0",
                providerIconClassName(option.value, "text-muted-foreground/85"),
              )}
            />
            <span className="min-w-0 flex-1">{option.label}</span>
            {activeProvider === option.value ? (
              <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            ) : null}
          </>
        );
        const navigation = props.navigation;
        if (navigation) {
          const browseProvider = () => {
            setModelSearchQuery("");
            navigation.onProviderBrowse(option.value);
          };
          return (
            <MenuItem
              key={option.value}
              aria-label={option.label}
              data-browse-provider={option.value}
              data-current-provider={activeProvider === option.value ? "" : undefined}
              className="data-current-provider:bg-[var(--color-background-button-secondary)]"
              closeOnClick={false}
              onClick={browseProvider}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  event.stopPropagation();
                  browseProvider();
                }
              }}
            >
              {providerContent}
              <ChevronRightIcon aria-hidden="true" className="-me-0.5 shrink-0" />
            </MenuItem>
          );
        }
        return (
          <MenuSub
            key={option.value}
            onOpenChange={(nextOpen) => {
              if (nextOpen) setModelSearchQuery("");
            }}
          >
            <MenuSubTrigger
              aria-label={option.label}
              data-current-provider={activeProvider === option.value ? "" : undefined}
              className="data-current-provider:bg-[var(--color-background-button-secondary)]"
            >
              {providerContent}
            </MenuSubTrigger>
            <ComposerPickerMenuSubPopup className={COMPOSER_PICKER_MODEL_PANEL_CLASS_NAME}>
              {renderModelRadioGroup(option.value)}
            </ComposerPickerMenuSubPopup>
          </MenuSub>
        );
      })}
      {visibleAvailableProviderOptions.length > 0 ? <MenuSeparator /> : null}
      <MenuItem
        className="text-muted-foreground"
        onClick={() => appHistory.push("/settings?section=providers")}
      >
        <PlusIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground/85" />
        <span>Add Providers</span>
      </MenuItem>
    </>
  );
};

export function resolveProviderModelLabel(input: {
  provider: ProviderKind;
  lockedProvider: ProviderKind | null;
  model: ModelSlug;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
}): string {
  const activeProvider = input.lockedProvider ?? input.provider;
  return resolveSelectedModelLabel({
    provider: activeProvider,
    model: input.model,
    options: input.modelOptionsByProvider[activeProvider],
  });
}

export function getProviderIconClassName(
  provider: ProviderKind | ProviderPickerKind,
  fallbackClassName: string = "text-muted-foreground/70",
): string {
  return providerIconClassName(provider, fallbackClassName);
}

type ProviderModelPickerProps = {
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProviderStatus>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  loadingModelProviders?: Partial<Record<ProviderKind, boolean>>;
  discoveryErrorsByProvider?: Partial<Record<ProviderKind, string | undefined>>;
  hiddenProviders?: ReadonlyArray<ProviderKind>;
  providerOrder?: ReadonlyArray<ProviderKind>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  // Icon-only trigger for narrow composers; the model name moves to title/sr-only.
  hideLabel?: boolean;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSelectionCommitted?: () => void;
  shortcutLabel?: string | null;
  onProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
};

export const ProviderModelPicker = function ProviderModelPicker(props: ProviderModelPickerProps) {
  const { onOpenChange, onSelectionCommitted, open } = props;
  const [uncontrolledMenuOpen, setUncontrolledMenuOpen] = useState(false);
  const selectionCommitTimerRef = useRef<number | null>(null);
  const isMenuOpen = open ?? uncontrolledMenuOpen;
  const activeProvider = props.lockedProvider ?? props.provider;
  const selectedModelLabel = resolveProviderModelLabel({
    provider: props.provider,
    lockedProvider: props.lockedProvider,
    model: props.model,
    modelOptionsByProvider: props.modelOptionsByProvider,
  });
  const ProviderIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[activeProvider];

  const setMenuOpen = (nextOpen: boolean) => {
    if (open === undefined) {
      setUncontrolledMenuOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };
  const scheduleSelectionCommitted = () => {
    if (selectionCommitTimerRef.current !== null) {
      window.clearTimeout(selectionCommitTimerRef.current);
    }
    // Base UI restores focus to the trigger while closing; refocus callers after that tick.
    selectionCommitTimerRef.current = window.setTimeout(() => {
      selectionCommitTimerRef.current = null;
      onSelectionCommitted?.();
    }, 0);
  };
  useEffect(
    () => () => {
      if (selectionCommitTimerRef.current !== null) {
        window.clearTimeout(selectionCommitTimerRef.current);
      }
    },
    [],
  );

  const handleAfterSelection = () => {
    setMenuOpen(false);
    scheduleSelectionCommitted();
  };

  const triggerButton = (
    <PickerTriggerButton
      disabled={props.disabled ?? false}
      title={selectedModelLabel}
      compact={props.compact ?? false}
      hideLabel={props.hideLabel ?? false}
      className="text-[var(--color-text-foreground)]"
      icon={
        <ProviderIcon
          aria-hidden="true"
          className={cn(
            // opacity-100 opts out of the Button base's [&_svg]:opacity-80 dimming.
            "size-3.5 shrink-0 opacity-100",
            providerIconClassName(activeProvider, "text-muted-foreground/70"),
            props.activeProviderIconClassName,
          )}
        />
      }
      label={selectedModelLabel}
    />
  );

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
      {props.shortcutLabel ? (
        <Tooltip>
          <TooltipTrigger render={<MenuTrigger render={triggerButton} />}>
            <span className="sr-only">{selectedModelLabel}</span>
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
        <MenuTrigger render={triggerButton}>
          <span className="sr-only">{selectedModelLabel}</span>
        </MenuTrigger>
      )}
      <ComposerPickerMenuPopup
        align="start"
        className={
          props.lockedProvider !== null
            ? COMPOSER_PICKER_MODEL_PANEL_CLASS_NAME
            : COMPOSER_PICKER_PROVIDER_PANEL_CLASS_NAME
        }
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
          onAfterSelection={handleAfterSelection}
        />
      </ComposerPickerMenuPopup>
    </Menu>
  );
};
