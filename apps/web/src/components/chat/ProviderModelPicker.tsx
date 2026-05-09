// FILE: ProviderModelPicker.tsx
// Purpose: Renders the composer provider/model menu and supports controlled opening for shortcuts.
// Layer: Chat composer presentation
// Depends on: provider availability metadata, shared menu primitives, and picker trigger styling.

import { type ModelSlug, type ProviderKind, type ServerProviderStatus } from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import * as Schema from "effect/Schema";
import { Fragment, memo, useCallback, useDeferredValue, useMemo, useState } from "react";
import { type ProviderPickerKind, PROVIDER_OPTIONS } from "../../session-logic";
import { formatProviderModelOptionName } from "../../providerModelOptions";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { ClaudeAI, CursorIcon, Gemini, Icon, OpenAI, OpenCodeIcon } from "../Icons";
import { cn } from "~/lib/utils";
import { PickerPanelShell } from "./PickerPanelShell";
import { PickerTriggerButton } from "./PickerTriggerButton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ShortcutKbd } from "../ui/shortcut-kbd";
import {
  groupProviderModelOptions,
  groupProviderModelOptionsWithFavorites,
  type ProviderModelOption,
} from "../../providerModelOptions";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { StarFilledIcon, StarIcon } from "../../lib/icons";
import { Skeleton } from "../ui/skeleton";

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderKind;
  label: string;
  available: true;
} {
  return option.available;
}

const PROVIDER_ICON_BY_PROVIDER: Record<ProviderPickerKind, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  cursor: CursorIcon,
  gemini: Gemini,
  opencode: OpenCodeIcon,
};

function resolveLiveProviderAvailability(provider: ServerProviderStatus | undefined): {
  disabled: boolean;
  label: string | null;
} {
  if (!provider) {
    return {
      disabled: false,
      label: null,
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
const UNAVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter((option) => !option.available);

function providerIconClassName(
  provider: ProviderKind | ProviderPickerKind,
  fallbackClassName: string,
): string {
  return provider === "claudeAgent" || provider === "gemini"
    ? "text-foreground"
    : fallbackClassName;
}

const SEARCHABLE_MODEL_PICKER_THRESHOLD = 15;
const FAVORITE_MODEL_STORAGE_KEYS = {
  cursor: "dpcode:cursor-favourite-models:v1",
  opencode: "dpcode:opencode-favourite-models:v1",
} as const;
const FavoriteModelSlugs = Schema.Array(Schema.String);
type FavoriteModelProvider = keyof typeof FAVORITE_MODEL_STORAGE_KEYS;

function supportsModelFavorites(provider: ProviderKind): provider is FavoriteModelProvider {
  return provider === "cursor" || provider === "opencode";
}

// Keeps persisted favorite slugs compact and stable while preserving the user's order.
function toggleFavoriteModelSlug(current: ReadonlyArray<string>, slug: string): string[] {
  const normalizedCurrent = Array.from(new Set(current.filter((entry) => entry.trim().length > 0)));
  return normalizedCurrent.includes(slug)
    ? normalizedCurrent.filter((entry) => entry !== slug)
    : [...normalizedCurrent, slug];
}

function stripParameterizedModelSuffix(model: string): string {
  return model.trim().replace(/\[[^\]]*\]$/u, "");
}

function resolveSelectedModelLabel(input: {
  provider: ProviderKind;
  model: string;
  options: ReadonlyArray<ProviderModelOption>;
}): string {
  const exact = input.options.find((option) => option.slug === input.model);
  if (exact) {
    return exact.name;
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
  return [option.name, option.slug, option.upstreamProviderName, option.upstreamProviderId]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
}

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProviderStatus>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  loadingModelProviders?: Partial<Record<ProviderKind, boolean>>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  shortcutLabel?: string | null;
  onProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
}) {
  const { onOpenChange, open } = props;
  const [uncontrolledMenuOpen, setUncontrolledMenuOpen] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [cursorFavoriteModelSlugs, setCursorFavoriteModelSlugs] = useLocalStorage(
    FAVORITE_MODEL_STORAGE_KEYS.cursor,
    [],
    FavoriteModelSlugs,
  );
  const [openCodeFavoriteModelSlugs, setOpenCodeFavoriteModelSlugs] = useLocalStorage(
    FAVORITE_MODEL_STORAGE_KEYS.opencode,
    [],
    FavoriteModelSlugs,
  );
  const deferredModelSearchQuery = useDeferredValue(modelSearchQuery);
  const activeProvider = props.lockedProvider ?? props.provider;
  const isMenuOpen = open ?? uncontrolledMenuOpen;
  const openCodeFavoriteModelSlugSet = useMemo(
    () => new Set(openCodeFavoriteModelSlugs),
    [openCodeFavoriteModelSlugs],
  );
  const cursorFavoriteModelSlugSet = useMemo(
    () => new Set(cursorFavoriteModelSlugs),
    [cursorFavoriteModelSlugs],
  );
  const favoriteModelSlugSets = useMemo(
    () => ({
      cursor: cursorFavoriteModelSlugSet,
      opencode: openCodeFavoriteModelSlugSet,
    }),
    [cursorFavoriteModelSlugSet, openCodeFavoriteModelSlugSet],
  );
  const selectedProviderOptions = props.modelOptionsByProvider[activeProvider];
  const selectedModelLabel = resolveSelectedModelLabel({
    provider: activeProvider,
    model: props.model,
    options: selectedProviderOptions,
  });
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[activeProvider];
  const setMenuOpen = useCallback(
    (nextOpen: boolean) => {
      if (open === undefined) {
        setUncontrolledMenuOpen(nextOpen);
      }
      if (!nextOpen) {
        setModelSearchQuery("");
      }
      onOpenChange?.(nextOpen);
    },
    [onOpenChange, open],
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
    setMenuOpen(false);
  };
  const toggleFavoriteModel = useCallback(
    (provider: FavoriteModelProvider, slug: string) => {
      const setFavoriteModelSlugs =
        provider === "cursor" ? setCursorFavoriteModelSlugs : setOpenCodeFavoriteModelSlugs;
      setFavoriteModelSlugs((current) => toggleFavoriteModelSlug(current, slug));
    },
    [setCursorFavoriteModelSlugs, setOpenCodeFavoriteModelSlugs],
  );

  const renderModelRadioGroup = (provider: ProviderKind) => {
    if (props.loadingModelProviders?.[provider]) {
      return (
        <div className="w-60 space-y-2 px-2 py-2" aria-label="Loading models">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex items-center gap-2 rounded-md px-2 py-1.5">
              <Skeleton className="size-3.5 rounded-full" />
              <Skeleton className={cn("h-3.5 rounded-full", index % 3 === 0 ? "w-24" : "w-32")} />
            </div>
          ))}
        </div>
      );
    }

    const providerOptions = props.modelOptionsByProvider[provider];
    const shouldShowSearch =
      (provider === "opencode" || provider === "cursor") &&
      providerOptions.length >= SEARCHABLE_MODEL_PICKER_THRESHOLD;
    const normalizedModelSearchQuery = deferredModelSearchQuery.trim().toLowerCase();
    const filteredOptions =
      shouldShowSearch && normalizedModelSearchQuery.length > 0
        ? providerOptions.filter((option) =>
            buildModelSearchText(option).includes(normalizedModelSearchQuery),
          )
        : providerOptions;
    const favoriteProvider = supportsModelFavorites(provider) ? provider : null;
    const favoriteModelSlugSet =
      favoriteProvider !== null ? favoriteModelSlugSets[favoriteProvider] : undefined;
    const groupedOptions =
      favoriteModelSlugSet !== undefined
        ? groupProviderModelOptionsWithFavorites({
            options: filteredOptions,
            favoriteSlugs: favoriteModelSlugSet,
          })
        : groupProviderModelOptions(filteredOptions);

    const content =
      groupedOptions.length > 0 ? (
        <MenuRadioGroup
          value={activeProvider === provider ? props.model : ""}
          onValueChange={(value) => handleModelChange(provider, value)}
        >
          {groupedOptions.map((group, index) => (
            <Fragment key={`${provider}:${group.key}`}>
              <MenuGroup>
                {group.label ? <MenuGroupLabel>{group.label}</MenuGroupLabel> : null}
                {group.options.map((modelOption) => {
                  const isFavorite = favoriteModelSlugSet?.has(modelOption.slug) ?? false;
                  return (
                    <MenuRadioItem
                      key={`${provider}:${modelOption.slug}`}
                      value={modelOption.slug}
                      onClick={() => setMenuOpen(false)}
                    >
                      {favoriteModelSlugSet !== undefined ? (
                        <span className="flex w-full min-w-0 items-center gap-2">
                          <span className="block min-w-0 flex-1 truncate">{modelOption.name}</span>
                          <button
                            type="button"
                            aria-label={
                              isFavorite
                                ? `Remove ${modelOption.name} from favourites`
                                : `Add ${modelOption.name} to favourites`
                            }
                            className={cn(
                              "-me-2 ms-auto inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground/55 transition-colors hover:bg-[var(--color-background-elevated-tertiary)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60",
                              isFavorite && "text-amber-300 hover:text-amber-200",
                            )}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              if (favoriteProvider !== null) {
                                toggleFavoriteModel(favoriteProvider, modelOption.slug);
                              }
                            }}
                            onPointerDown={(event) => {
                              event.stopPropagation();
                            }}
                          >
                            {isFavorite ? (
                              <StarFilledIcon aria-hidden="true" className="size-3.5" />
                            ) : (
                              <StarIcon aria-hidden="true" className="size-3.5" />
                            )}
                          </button>
                        </span>
                      ) : (
                        modelOption.name
                      )}
                    </MenuRadioItem>
                  );
                })}
              </MenuGroup>
              {index < groupedOptions.length - 1 ? <MenuSeparator /> : null}
            </Fragment>
          ))}
        </MenuRadioGroup>
      ) : (
        <div className="px-2 py-2 text-muted-foreground text-sm">No matches</div>
      );

    if (!shouldShowSearch) {
      return content;
    }

    return (
      <PickerPanelShell
        searchPlaceholder="Search models or providers"
        query={modelSearchQuery}
        onQueryChange={setModelSearchQuery}
        stopSearchKeyPropagation
        autoFocusSearch
        widthClassName="w-60"
        bleedParentPadding
      >
        {content}
      </PickerPanelShell>
    );
  };

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setMenuOpen(false);
          return;
        }
        setMenuOpen(open);
      }}
    >
      {props.shortcutLabel ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <PickerTriggerButton
                    disabled={props.disabled ?? false}
                    compact={props.compact ?? false}
                    icon={
                      <ProviderIcon
                        aria-hidden="true"
                        className={cn(
                          "size-3.5 shrink-0",
                          providerIconClassName(activeProvider, "text-muted-foreground/70"),
                          props.activeProviderIconClassName,
                        )}
                      />
                    }
                    label={selectedModelLabel}
                  />
                }
              />
            }
          >
            <span className="sr-only">{selectedModelLabel}</span>
          </TooltipTrigger>
          {!isMenuOpen ? (
            <TooltipPopup side="top" sideOffset={6}>
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
        <MenuTrigger
          render={
            <PickerTriggerButton
              disabled={props.disabled ?? false}
              compact={props.compact ?? false}
              icon={
                <ProviderIcon
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 shrink-0",
                    providerIconClassName(activeProvider, "text-muted-foreground/70"),
                    props.activeProviderIconClassName,
                  )}
                />
              }
              label={selectedModelLabel}
            />
          }
        >
          <span className="sr-only">{selectedModelLabel}</span>
        </MenuTrigger>
      )}
      <MenuPopup align="start">
        {props.lockedProvider !== null ? (
          renderModelRadioGroup(props.lockedProvider)
        ) : (
          <>
            {AVAILABLE_PROVIDER_OPTIONS.map((option) => {
              const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
              const liveProvider = props.providers?.find(
                (entry) => entry.provider === option.value,
              );
              const availability = resolveLiveProviderAvailability(liveProvider);
              if (availability.disabled) {
                return (
                  <MenuItem key={option.value} disabled>
                    <OptionIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0 opacity-80",
                        providerIconClassName(option.value, "text-muted-foreground/85"),
                      )}
                    />
                    <span>{option.label}</span>
                    <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                      {availability.label}
                    </span>
                  </MenuItem>
                );
              }
              return (
                <MenuSub key={option.value}>
                  <MenuSubTrigger>
                    <OptionIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0",
                        providerIconClassName(option.value, "text-muted-foreground/85"),
                      )}
                    />
                    {option.label}
                  </MenuSubTrigger>
                  <MenuSubPopup className="[--available-height:min(24rem,70vh)]">
                    {renderModelRadioGroup(option.value)}
                  </MenuSubPopup>
                </MenuSub>
              );
            })}
            {UNAVAILABLE_PROVIDER_OPTIONS.length > 0 && <MenuSeparator />}
            {UNAVAILABLE_PROVIDER_OPTIONS.map((option) => {
              const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
              return (
                <MenuItem key={option.value} disabled>
                  <OptionIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground/85 opacity-80"
                  />
                  <span>{option.label}</span>
                  <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                    Coming soon
                  </span>
                </MenuItem>
              );
            })}
          </>
        )}
      </MenuPopup>
    </Menu>
  );
});
