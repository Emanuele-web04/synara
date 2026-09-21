import { type ProviderKind, type ServerProviderStatus } from "@synara/contracts";
import { type ReactNode } from "react";

import { PlusIcon, StarFilledIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "../ProviderIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type ComposerModelPickerTab, STARRED_TAB } from "./ComposerModelPicker.logic";
import { getProviderIconClassName, resolveLiveProviderAvailability } from "./ProviderModelPicker";

function PickerTabButton(props: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            role="tab"
            aria-label={props.label}
            aria-selected={props.active}
            disabled={props.disabled ?? false}
            className={cn(
              "relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/70 outline-none transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent",
              props.active &&
                // The accent token is theme-injected; fall back to the icon color without it.
                "text-foreground after:absolute after:inset-x-1.5 after:-bottom-1 after:h-0.5 after:rounded-full after:bg-[var(--color-text-accent,currentColor)]",
            )}
            onClick={props.onSelect}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top" variant="picker">
        {props.label}
      </TooltipPopup>
    </Tooltip>
  );
}

export type ComposerModelPickerProviderTab = {
  provider: ProviderKind;
  label: string;
  /** Null when the provider can be opened; otherwise why not ("Sign in", "Checking"…). */
  unavailableLabel: string | null;
};

export function resolveComposerModelPickerProviderTabs(
  options: ReadonlyArray<{ value: ProviderKind; label: string }>,
  providers: ReadonlyArray<ServerProviderStatus> | undefined,
): ComposerModelPickerProviderTab[] {
  return options.map((option) => {
    const availability = resolveLiveProviderAvailability(
      providers?.find((entry) => entry.provider === option.value),
    );
    return {
      provider: option.value,
      label: option.label,
      unavailableLabel: availability.disabled ? (availability.label ?? "Unavailable") : null,
    };
  });
}

export function ComposerModelPickerTabs(props: {
  tab: ComposerModelPickerTab;
  providerTabs: ReadonlyArray<ComposerModelPickerProviderTab>;
  onTabChange: (tab: ComposerModelPickerTab) => void;
  /** Omitted while the thread is locked to its provider. */
  onAddProviders?: (() => void) | undefined;
}) {
  return (
    <div
      role="tablist"
      aria-label="Model sources"
      className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border p-1.5 [scrollbar-width:none]"
    >
      <PickerTabButton
        label="Starred"
        active={props.tab === STARRED_TAB}
        onSelect={() => props.onTabChange(STARRED_TAB)}
      >
        <StarFilledIcon aria-hidden="true" className="size-3.5" />
      </PickerTabButton>
      {props.providerTabs.map((providerTab) => {
        const TabIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[providerTab.provider];
        return (
          <PickerTabButton
            key={providerTab.provider}
            label={
              providerTab.unavailableLabel
                ? `${providerTab.label} · ${providerTab.unavailableLabel}`
                : providerTab.label
            }
            active={props.tab === providerTab.provider}
            disabled={providerTab.unavailableLabel !== null}
            onSelect={() => props.onTabChange(providerTab.provider)}
          >
            <TabIcon
              aria-hidden="true"
              className={cn("size-4", getProviderIconClassName(providerTab.provider, ""))}
            />
          </PickerTabButton>
        );
      })}
      {props.onAddProviders ? (
        <PickerTabButton label="Add providers" active={false} onSelect={props.onAddProviders}>
          <PlusIcon aria-hidden="true" className="size-3.5" />
        </PickerTabButton>
      ) : null}
    </div>
  );
}
