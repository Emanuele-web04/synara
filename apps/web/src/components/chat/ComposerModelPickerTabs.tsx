// FILE: ComposerModelPickerTabs.tsx
// Purpose: Icon tab strip of the composer model picker — starred presets, one tab per
//   account of every offered provider, and a shortcut to provider settings.
// Layer: Chat composer presentation
// Depends on: provider icons/availability helpers and tooltip primitives.

import {
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { type ReactNode } from "react";

import { PlusIcon, StarFilledIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "../ProviderIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type ComposerModelPickerTab,
  providerAccountInitials,
  STARRED_TAB,
} from "./ComposerModelPicker.logic";
import {
  findProviderStatusForInstance,
  getProviderIconClassName,
  type ProviderModelPickerInstance,
  resolveLiveProviderAvailability,
} from "./ProviderModelPicker";

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
  /** Account the tab lists models for; a default account shares the provider id. */
  instanceId: ProviderInstanceId;
  label: string;
  /** Initials telling same-provider accounts apart; null while the provider has one. */
  badge: string | null;
  /** Null when the account can be opened; otherwise why not ("Sign in", "Checking"…). */
  unavailableLabel: string | null;
};

// One tab per enabled account, so a second Codex or Claude account is as reachable as
// another provider. A started thread stays on its account: siblings are listed but closed.
export function resolveComposerModelPickerProviderTabs(input: {
  options: ReadonlyArray<{ value: ProviderKind; label: string }>;
  providers: ReadonlyArray<ServerProviderStatus> | undefined;
  providerInstances?: ReadonlyArray<ProviderModelPickerInstance> | undefined;
  lockedInstanceId?: ProviderInstanceId | null | undefined;
}): ComposerModelPickerProviderTab[] {
  return input.options.flatMap((option) => {
    const accounts = (input.providerInstances ?? []).filter(
      (instance) => instance.provider === option.value && instance.enabled,
    );
    const hasSiblingAccounts = accounts.length > 1;
    const tabs = hasSiblingAccounts
      ? accounts.map((account) => ({
          instanceId: account.instanceId,
          label: account.label.toLowerCase().includes(option.label.toLowerCase())
            ? account.label
            : `${option.label} · ${account.label}`,
          badge: providerAccountInitials(account.label),
        }))
      : [{ instanceId: accounts[0]?.instanceId ?? option.value, label: option.label, badge: null }];
    return tabs.map((tab) => {
      const availability = resolveLiveProviderAvailability(
        findProviderStatusForInstance({
          providers: input.providers,
          provider: option.value,
          instanceId: tab.instanceId,
        }),
      );
      const lockedToSibling =
        input.lockedInstanceId != null && tab.instanceId !== input.lockedInstanceId;
      return {
        provider: option.value,
        ...tab,
        unavailableLabel: lockedToSibling
          ? "New thread"
          : availability.disabled
            ? (availability.label ?? "Unavailable")
            : null,
      };
    });
  });
}

export function ProviderAccountBadge(props: { initials: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "rounded-sm bg-popover px-0.5 font-medium text-ui-2xs leading-none text-foreground ring-1 ring-border",
        props.className,
      )}
    >
      {props.initials}
    </span>
  );
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
            key={providerTab.instanceId}
            label={
              providerTab.unavailableLabel
                ? `${providerTab.label} · ${providerTab.unavailableLabel}`
                : providerTab.label
            }
            active={props.tab === providerTab.instanceId}
            disabled={providerTab.unavailableLabel !== null}
            onSelect={() => props.onTabChange(providerTab.instanceId)}
          >
            <TabIcon
              aria-hidden="true"
              className={cn("size-4", getProviderIconClassName(providerTab.provider, ""))}
            />
            {providerTab.badge ? (
              <ProviderAccountBadge
                initials={providerTab.badge}
                className="absolute -right-1 -bottom-0.5"
              />
            ) : null}
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
