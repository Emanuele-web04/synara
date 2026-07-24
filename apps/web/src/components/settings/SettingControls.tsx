// FILE: SettingControls.tsx
// Purpose: Reusable settings row controls (reset button, select, segmented control).
// Layer: Settings UI components
// Exports: SettingResetButton, SettingsSelectControl, SettingsSegmentedControl,
//          useSettingsRestoreSignal

import { type ReactNode, useEffect, useEffectEvent, useRef } from "react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Select, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Undo2Icon } from "~/lib/icons";
import { SETTINGS_CONTROL_RADIUS_CLASS_NAME } from "~/settingsPanelStyles";
import { SettingsSelectPopup } from "./SettingsPanelPrimitives";
import { useUiText } from "~/hooks/useUiText";

export function useSettingsRestoreSignal(epoch: number, onRestore: () => void): void {
  const previousEpochRef = useRef(epoch);
  const restore = useEffectEvent(onRestore);

  useEffect(() => {
    if (previousEpochRef.current === epoch) return;
    previousEpochRef.current = epoch;
    restore();
  }, [epoch]);
}

export function SettingResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  const t = useUiText();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`${t("Reset")} ${t(label)}`}
            className="size-5 rounded-lg p-0 text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">{t("Reset to default")}</TooltipPopup>
    </Tooltip>
  );
}

export function SettingsSelectControl({
  value,
  onValueChange,
  ariaLabel,
  triggerClassName = "w-full sm:w-44",
  valueContent,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel: string;
  triggerClassName?: string;
  valueContent: ReactNode;
  children: ReactNode;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
    >
      <SelectTrigger
        className={cn(SETTINGS_CONTROL_RADIUS_CLASS_NAME, triggerClassName)}
        aria-label={ariaLabel}
      >
        <SelectValue>{valueContent}</SelectValue>
      </SelectTrigger>
      <SettingsSelectPopup>{children}</SettingsSelectPopup>
    </Select>
  );
}

export type SettingsSegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
};

/** Inline row of toggle buttons used in place of a select when there are only a
 *  handful of mutually exclusive options (e.g. theme: Light / Dark / System).
 *  The active option reads as a filled pill; the rest stay quiet until hovered. */
export function SettingsSegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SettingsSegmentedOption<T>[];
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex w-full items-center gap-1 sm:w-auto"
    >
      {options.map((option) => {
        const isActive = option.value === value;
        return (
          <Button
            key={option.value}
            role="radio"
            aria-checked={isActive}
            size="sm"
            variant={isActive ? "secondary" : "ghost"}
            className={cn(
              SETTINGS_CONTROL_RADIUS_CLASS_NAME,
              "flex-1 sm:flex-none",
              !isActive && "text-muted-foreground",
            )}
            onClick={() => onValueChange(option.value)}
          >
            {option.icon}
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}
