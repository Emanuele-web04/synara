// FILE: SettingControls.tsx
// Purpose: Reusable settings row controls (reset button, select, segmented control).
// Layer: Settings UI components
// Exports: SettingResetButton, SettingsSelectControl, SettingsSegmentedControl

import { type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Select, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/menu";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { ChevronDownIcon, Undo2Icon } from "~/lib/icons";
import { SETTINGS_CONTROL_RADIUS_CLASS_NAME } from "~/settingsPanelStyles";
import { SettingsSelectPopup } from "./SettingsPanelPrimitives";

export function SettingResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Reset ${label} to default`}
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
      <TooltipPopup side="top">Reset to default</TooltipPopup>
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

export type FontPreset = { label: string; value: string };

export const UI_FONT_PRESETS: readonly FontPreset[] = [
  { label: "System default", value: "" },
  { label: "System UI", value: "system-ui" },
  { label: "Inter", value: "Inter" },
  { label: "Helvetica Neue", value: "Helvetica Neue" },
  { label: "Arial", value: "Arial" },
  { label: "Roboto", value: "Roboto" },
  { label: "Segoe UI", value: "Segoe UI" },
];

export const CODE_FONT_PRESETS: readonly FontPreset[] = [
  { label: "System default", value: "" },
  { label: "JetBrains Mono", value: "JetBrains Mono" },
  { label: "Fira Code", value: "Fira Code" },
  { label: "SF Mono", value: "SF Mono" },
  { label: "Menlo", value: "Menlo" },
  { label: "Monaco", value: "Monaco" },
  { label: "Consolas", value: "Consolas" },
  { label: "Source Code Pro", value: "Source Code Pro" },
];

export function SettingsFontControl({
  value,
  onValueChange,
  presets,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onValueChange: (value: string) => void;
  presets: readonly FontPreset[];
  placeholder: string;
  ariaLabel: string;
}) {
  return (
    <InputGroup className="w-full sm:w-48">
      <InputGroupInput
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        aria-label={ariaLabel}
      />
      <InputGroupAddon align="inline-end">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`${ariaLabel} presets`}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
          >
            <ChevronDownIcon className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {presets.map((preset) => (
              <DropdownMenuItem key={preset.label} onClick={() => onValueChange(preset.value)}>
                {preset.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </InputGroupAddon>
    </InputGroup>
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
