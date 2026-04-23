// FILE: ProviderModelPicker.tsx
// Purpose: Renders the composer provider/model menu and supports controlled opening for shortcuts.
// Layer: Chat composer presentation
// Depends on: provider availability metadata, shared menu primitives, and picker trigger styling.

import { type ModelSlug, type ProviderKind, type ServerProviderStatus } from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { Fragment, memo, useCallback, useDeferredValue, useState } from "react";
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
import { ClaudeAI, Gemini, Icon, OpenAI, OpenCodeIcon } from "../Icons";
import { cn } from "~/lib/utils";
import { PickerPanelShell } from "./PickerPanelShell";
import { PickerTriggerButton } from "./PickerTriggerButton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ShortcutKbd } from "../ui/shortcut-kbd";
import { groupProviderModelOptions, type ProviderModelOption } from "../../providerModelOptions";

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

const OPENCODE_MODEL_SEARCH_THRESHOLD = 15;

function buildOpenCodeModelSearchText(option: ProviderModelOption): string {
  return [
    option.name,
    option.slug,
    option.upstreamProviderName,
    option.upstreamProviderId,
  ]
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
  const [openCodeSearchQuery, setOpenCodeSearchQuery] = useState("");
  const deferredOpenCodeSearchQuery = useDeferredValue(openCodeSearchQuery);
  const activeProvider = props.lockedProvider ?? props.provider;
  const isMenuOpen = open ?? uncontrolledMenuOpen;
  const selectedProviderOptions = props.modelOptionsByProvider[activeProvider];
  const selectedModelLabel =
    selectedProviderOptions.find((option) => option.slug === props.model)?.name ??
    formatProviderModelOptionName({
      provider: activeProvider,
      slug: props.model,
    });
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[activeProvider];
  const setMenuOpen = useCallback(
    (nextOpen: boolean) => {
      if (open === undefined) {
        setUncontrolledMenuOpen(nextOpen);
      }
      if (!nextOpen) {
        setOpenCodeSearchQuery("");
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

  const renderModelRadioGroup = (provider: ProviderKind) => {
    const providerOptions = props.modelOptionsByProvider[provider];
    const shouldShowOpenCodeSearch =
      provider === "opencode" && providerOptions.length >= OPENCODE_MODEL_SEARCH_THRESHOLD;
    const normalizedOpenCodeSearchQuery = deferredOpenCodeSearchQuery.trim().toLowerCase();
    const filteredOptions =
      shouldShowOpenCodeSearch && normalizedOpenCodeSearchQuery.length > 0
        ? providerOptions.filter((option) =>
            buildOpenCodeModelSearchText(option).includes(normalizedOpenCodeSearchQuery),
          )
        : providerOptions;
    const groupedOptions = groupProviderModelOptions(filteredOptions);

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
                {group.options.map((modelOption) => (
                  <MenuRadioItem
                    key={`${provider}:${modelOption.slug}`}
                    value={modelOption.slug}
                    onClick={() => setMenuOpen(false)}
                  >
                    {modelOption.name}
                  </MenuRadioItem>
                ))}
              </MenuGroup>
              {index < groupedOptions.length - 1 ? <MenuSeparator /> : null}
            </Fragment>
          ))}
        </MenuRadioGroup>
      ) : (
        <div className="px-2 py-2 text-muted-foreground text-sm">No matches</div>
      );

    if (!shouldShowOpenCodeSearch) {
      return content;
    }

    return (
      <PickerPanelShell
        searchPlaceholder="Search models or providers"
        query={openCodeSearchQuery}
        onQueryChange={setOpenCodeSearchQuery}
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
