// FILE: SettingControls.tsx
// Purpose: Reusable settings row controls (reset button, select, font field with presets).
// Layer: Settings UI components
// Exports: SettingResetButton, SettingsSelectControl, SettingsFontControl, font preset lists

import { type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/menu";
import { Select, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ChevronDownIcon, Undo2Icon } from "~/lib/icons";
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
            className="size-5 rounded-xl p-0 text-muted-foreground hover:text-foreground"
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
      <SelectTrigger className={triggerClassName} aria-label={ariaLabel}>
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

/** Free-text font field with the standard input chrome plus a chevron menu of common
 *  presets, matching the other settings dropdowns while still allowing custom families. */
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
