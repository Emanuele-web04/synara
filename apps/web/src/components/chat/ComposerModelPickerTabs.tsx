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
import { type CSSProperties, type ReactNode } from "react";

import { PlusIcon, StarFilledIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "../ProviderIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  normalizeProviderAccentColor,
  providerAccountQualifiedLabel,
} from "~/lib/providerInstancePresentation";
import { ProviderAccountDot } from "../ProviderAccountMark";
import { SurfaceTabStrip } from "./chatHeaderControls";
import { type ComposerModelPickerTab, STARRED_TAB } from "./ComposerModelPicker.logic";
import {
  findProviderStatusForInstance,
  type ProviderModelPickerInstance,
  resolveLiveProviderAvailability,
} from "./ProviderModelPicker";

function PickerTabButton(props: {
  label: string;
  /** False for the settings shortcut outside the tab list. */
  tab?: boolean;
  /** Defaults to the label; an unavailable account explains itself here instead. */
  tooltip?: string;
  active: boolean;
  disabled?: boolean;
  /** Colors the active marker: the account's accent, so the open tab points at it. */
  accentColor?: string | undefined;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            role={props.tab === false ? undefined : "tab"}
            aria-label={props.label}
            aria-selected={props.tab === false ? undefined : props.active}
            {...(props.active ? { "data-surface-tab-active": "" } : {})}
            // Not the native attribute: a disabled button swallows the hover that shows
            // why the tab is closed.
            aria-disabled={props.disabled ?? false}
            className={cn(
              "relative flex h-7 min-w-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-1.5 text-muted-foreground/70 outline-none transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60 aria-disabled:cursor-default aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground/70",
              props.active &&
                // The accent token is theme-injected; fall back to the icon color without it.
                "text-foreground after:absolute after:inset-x-1.5 after:-bottom-1 after:h-0.5 after:rounded-full after:bg-[var(--tab-accent,var(--color-text-accent,currentColor))]",
            )}
            style={
              props.accentColor
                ? ({ "--tab-accent": props.accentColor } as CSSProperties)
                : undefined
            }
            onClick={() => {
              if (!props.disabled) props.onSelect();
            }}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top" variant="picker">
        {props.tooltip ?? props.label}
      </TooltipPopup>
    </Tooltip>
  );
}

export type ComposerModelPickerProviderTab = {
  provider: ProviderKind;
  /** Account the tab lists models for; a default account shares the provider id. */
  instanceId: ProviderInstanceId;
  label: string;
  /** Account name written beside the icon of the open tab; null while the provider has
   *  one account and its icon says it all. */
  name: string | null;
  /** A second account of its provider: its icon is dotted to differ from the default. */
  dotted: boolean;
  accentColor?: string | undefined;
  /** Tooltip sentence explaining why the account cannot run right now; null when it can. */
  unavailableLabel: string | null;
  /** The tab cannot be opened at all (another account's thread, status still loading). */
  blocked: boolean;
  /** Shown in place of the model list when the account still has to be signed in or fixed. */
  setupMessage: string | null;
};

// Why an enabled account cannot run, phrased for its tab tooltip.
function describeUnavailableAccount(label: string, status: ServerProviderStatus): string {
  const reason =
    status.status === "error" || !status.available
      ? "Unavailable"
      : status.status === "warning"
        ? "Limited"
        : "Not ready";
  return [`${label} — ${reason}.`, status.message?.trim()].filter(Boolean).join(" ");
}

function resolveAccountTabState(input: {
  label: string;
  status: ServerProviderStatus | undefined;
  lockedToSibling: boolean;
}): Pick<ComposerModelPickerProviderTab, "unavailableLabel" | "blocked" | "setupMessage"> {
  const { label, status } = input;
  if (input.lockedToSibling) {
    return {
      unavailableLabel: `${label} is unavailable in this thread. Start a new thread to switch accounts.`,
      blocked: true,
      setupMessage: null,
    };
  }
  if (!resolveLiveProviderAvailability(status).disabled) {
    return { unavailableLabel: null, blocked: false, setupMessage: null };
  }
  if (!status) {
    return { unavailableLabel: `${label} — Checking.`, blocked: true, setupMessage: null };
  }
  return {
    unavailableLabel: describeUnavailableAccount(label, status),
    blocked: false,
    setupMessage:
      status.authStatus === "unauthenticated"
        ? "Open provider setup to sign in to this account."
        : (status.message?.trim() ?? `${label} is unavailable right now.`),
  };
}

// One tab per enabled account, so a second Codex or Claude account is as reachable as
// another provider. A started thread stays on its account: siblings are listed but closed.
// An account that still needs signing in stays openable and invites the user to set it up.
export function resolveComposerModelPickerProviderTabs(input: {
  options: ReadonlyArray<{ value: ProviderKind; label: string }>;
  providers: ReadonlyArray<ServerProviderStatus> | undefined;
  providerInstances?: ReadonlyArray<ProviderModelPickerInstance> | undefined;
  lockedInstanceId?: ProviderInstanceId | null | undefined;
  // Locks only this provider's sibling accounts; other providers stay pickable.
  lockedInstanceProvider?: ProviderKind | null | undefined;
}): ComposerModelPickerProviderTab[] {
  return input.options.flatMap((option) => {
    const accounts = (input.providerInstances ?? []).filter(
      (instance) => instance.enabled && instance.provider === option.value,
    );
    const hasSiblingAccounts = accounts.length > 1;
    const tabs =
      accounts.length > 0
        ? accounts.map((account) => ({
            instanceId: account.instanceId,
            label: hasSiblingAccounts
              ? providerAccountQualifiedLabel(option.label, account.label)
              : account.isDefault
                ? option.label
                : account.label,
            name: hasSiblingAccounts ? account.label : null,
            dotted: hasSiblingAccounts && !account.isDefault,
            accentColor: account.accentColor,
          }))
        : [
            {
              instanceId: option.value,
              label: option.label,
              name: null,
              dotted: false,
              accentColor: undefined,
            },
          ];
    return tabs.map((tab) => {
      const state = resolveAccountTabState({
        label: tab.label,
        status: findProviderStatusForInstance({
          providers: input.providers,
          provider: option.value,
          instanceId: tab.instanceId,
        }),
        lockedToSibling:
          input.lockedInstanceId != null &&
          tab.instanceId !== input.lockedInstanceId &&
          (input.lockedInstanceProvider == null || option.value === input.lockedInstanceProvider),
      });
      return {
        provider: option.value,
        instanceId: tab.instanceId,
        label: tab.label,
        name: tab.name,
        dotted: tab.dotted,
        accentColor: tab.accentColor,
        unavailableLabel: state.unavailableLabel,
        blocked: state.blocked,
        setupMessage: state.setupMessage,
      };
    });
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
    <div className="flex shrink-0 items-center gap-0.5 border-b border-border p-1.5">
      {/* Many providers and accounts overflow the popup: the strip scrolls sideways, fades
          its hidden edge, and keeps the open tab in view. The vertical padding leaves room
          for the open tab's marker, which hangs below the button. */}
      <SurfaceTabStrip
        role="tablist"
        aria-label="Model sources"
        activeKey={props.tab}
        className="-my-1 flex-1 gap-0.5 py-1"
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
              label={providerTab.label}
              tooltip={providerTab.unavailableLabel ?? providerTab.label}
              active={props.tab === providerTab.instanceId}
              disabled={providerTab.blocked}
              accentColor={normalizeProviderAccentColor(providerTab.accentColor)}
              onSelect={() => props.onTabChange(providerTab.instanceId)}
            >
              <TabIcon
                aria-hidden="true"
                className={cn(
                  // Provider marks are always full-strength, whichever tab is open: the
                  // marker under the tab shows the selection, so none of them reads as off.
                  "size-4 text-foreground",
                  providerTab.unavailableLabel !== null && "opacity-40",
                )}
              />
              <ProviderAccountDot
                accentColor={providerTab.accentColor}
                always={providerTab.dotted}
                className="absolute top-0.5 left-4.5"
              />
              {/* Only the open tab spells its account out; the others stay icon-sized. */}
              {providerTab.name && props.tab === providerTab.instanceId ? (
                <span className="max-w-20 truncate text-ui-sm">{providerTab.name}</span>
              ) : null}
            </PickerTabButton>
          );
        })}
      </SurfaceTabStrip>
      {/* Outside the strip, so it stays reachable however far the tabs scroll. */}
      {props.onAddProviders ? (
        <PickerTabButton
          label="Add providers"
          tab={false}
          active={false}
          onSelect={props.onAddProviders}
        >
          <PlusIcon aria-hidden="true" className="size-3.5" />
        </PickerTabButton>
      ) : null}
    </div>
  );
}
