// FILE: ProviderInstancePicker.tsx
// Purpose: Keeps provider-account selection separate from model selection in the composer.
// Layer: Chat composer presentation
// Depends on: provider-instance settings, live provider status, and shared picker primitives.

import {
  type ProviderInstanceId,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { memo, useCallback, useMemo, useState } from "react";

import { SettingsIcon, UserIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { PickerTriggerButton } from "./PickerTriggerButton";
import {
  findProviderStatusForInstance,
  resolveLiveProviderAvailability,
  type ProviderModelPickerInstance,
} from "./ProviderModelPicker";

export interface ProviderInstancePickerProps {
  readonly provider: ProviderKind;
  readonly providerInstances: ReadonlyArray<ProviderModelPickerInstance>;
  readonly providers?: ReadonlyArray<ServerProviderStatus>;
  readonly selectedProviderInstanceId: ProviderInstanceId;
  readonly selectionLocked?: boolean;
  readonly compact?: boolean;
  readonly hideLabel?: boolean;
  readonly onProviderInstanceChange: (instanceId: ProviderInstanceId) => void;
  readonly onManageAccounts: () => void;
  readonly onSelectionCommitted?: () => void;
}

function pickerSectionLabel(provider: ProviderKind): string {
  return provider === "codex" || provider === "claudeAgent" ? "Accounts" : "Profiles";
}

function manageLabel(provider: ProviderKind): string {
  return provider === "codex" || provider === "claudeAgent"
    ? "Manage accounts…"
    : "Manage profiles…";
}

export const ProviderInstancePicker = memo(function ProviderInstancePicker(
  props: ProviderInstancePickerProps,
) {
  const [open, setOpen] = useState(false);
  const instances = useMemo(
    () => props.providerInstances.filter((instance) => instance.provider === props.provider),
    [props.provider, props.providerInstances],
  );
  const selectedInstance =
    instances.find((instance) => instance.instanceId === props.selectedProviderInstanceId) ??
    instances[0];
  const selectedLabel = selectedInstance?.label ?? "Default";
  const triggerLabel = `Account: ${selectedLabel}`;

  const handleInstanceChange = useCallback(
    (value: string) => {
      if (!value || props.selectionLocked || value === props.selectedProviderInstanceId) {
        return;
      }
      props.onProviderInstanceChange(value as ProviderInstanceId);
      setOpen(false);
      props.onSelectionCommitted?.();
    },
    [props],
  );

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <PickerTriggerButton
            compact={props.compact ?? false}
            hideLabel={props.hideLabel ?? false}
            icon={<UserIcon aria-hidden="true" className="size-3.5" />}
            label={triggerLabel}
            className="max-w-44"
          />
        }
      >
        <span className="sr-only">{triggerLabel}</span>
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" fixedWidth>
        <div className="px-2.5 pb-1 pt-1 text-[11px] font-medium text-muted-foreground uppercase tracking-[0.08em]">
          {pickerSectionLabel(props.provider)}
        </div>
        <MenuRadioGroup
          value={props.selectedProviderInstanceId}
          onValueChange={handleInstanceChange}
        >
          {instances.map((instance) => {
            const availability = instance.enabled
              ? resolveLiveProviderAvailability(
                  findProviderStatusForInstance({
                    providers: props.providers,
                    provider: instance.provider,
                    instanceId: instance.instanceId,
                  }),
                )
              : { disabled: true, label: "Disabled" };
            const lockedSibling =
              props.selectionLocked && instance.instanceId !== props.selectedProviderInstanceId;
            const statusLabel = lockedSibling ? "New thread" : availability.label;
            return (
              <MenuRadioItem
                key={instance.instanceId}
                value={instance.instanceId}
                disabled={availability.disabled || lockedSibling}
              >
                <span className="truncate">{instance.label}</span>
                {statusLabel ? (
                  <span
                    className={cn(
                      "ms-auto text-[11px] text-muted-foreground/80",
                      statusLabel !== "Checking" && "uppercase tracking-[0.08em]",
                    )}
                  >
                    {statusLabel}
                  </span>
                ) : null}
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem
          onClick={() => {
            setOpen(false);
            props.onManageAccounts();
          }}
        >
          <SettingsIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
          {manageLabel(props.provider)}
        </MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
});
