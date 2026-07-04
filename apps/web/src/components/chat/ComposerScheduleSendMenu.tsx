// FILE: ComposerScheduleSendMenu.tsx
// Purpose: Composer timer control for arming a prompt to send later.
// Layer: Chat composer presentation

import { memo } from "react";

import { ClockIcon, XIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";

export type ScheduledComposerDispatchMode = "new" | "queue" | "steer";

export type ScheduledComposerDelayOption = {
  readonly seconds: number;
  readonly label: string;
};

export const DEFAULT_SCHEDULED_COMPOSER_DELAY_OPTIONS: ScheduledComposerDelayOption[] = [
  { seconds: 5 * 60, label: "5 min" },
  { seconds: 30 * 60, label: "30 min" },
  { seconds: 60 * 60, label: "1 hour" },
  { seconds: 4 * 60 * 60, label: "4 hours" },
  { seconds: 5 * 60 * 60, label: "5 hours" },
];

export function scheduledComposerDispatchLabel(mode: ScheduledComposerDispatchMode): string {
  switch (mode) {
    case "new":
      return "New chat";
    case "queue":
      return "Queue";
    case "steer":
      return "Steer";
  }
}

export function formatScheduledComposerCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

export const ComposerScheduleSendMenu = memo(function ComposerScheduleSendMenu(props: {
  canSchedule: boolean;
  selectedDelaySeconds: number;
  selectedMode: ScheduledComposerDispatchMode;
  pendingCountdownLabel: string | null;
  pendingMode: ScheduledComposerDispatchMode | null;
  pendingPreviewText: string | null;
  delayOptions?: readonly ScheduledComposerDelayOption[];
  onDelayChange: (seconds: number) => void;
  onModeChange: (mode: ScheduledComposerDispatchMode) => void;
  onSchedule: () => void;
  onCancel: () => void;
}) {
  const delayOptions = props.delayOptions ?? DEFAULT_SCHEDULED_COMPOSER_DELAY_OPTIONS;

  if (props.pendingCountdownLabel !== null && props.pendingMode !== null) {
    return (
      <div
        className="flex min-w-0 items-center gap-1 rounded-full border border-[color:var(--color-border-light)] bg-[var(--composer-surface)] py-0.5 pe-0.5 ps-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground"
        title={props.pendingPreviewText ?? undefined}
      >
        <ClockIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">
          {scheduledComposerDispatchLabel(props.pendingMode)} in {props.pendingCountdownLabel}
        </span>
        <IconButton
          label="Cancel scheduled prompt"
          size="icon-chip"
          variant="ghost"
          onClick={props.onCancel}
        >
          <XIcon />
        </IconButton>
      </div>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className="rounded-full"
            aria-label="Schedule prompt"
            disabled={!props.canSchedule}
            title="Schedule this prompt to send later"
          />
        }
      >
        <ClockIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="end" side="top" className="w-56 min-w-56">
        <MenuGroup>
          <MenuGroupLabel>Send in</MenuGroupLabel>
          <MenuRadioGroup
            value={String(props.selectedDelaySeconds)}
            onValueChange={(value) => {
              const seconds = Number(value);
              if (Number.isFinite(seconds)) {
                props.onDelayChange(seconds);
              }
            }}
          >
            {delayOptions.map((option) => (
              <MenuRadioItem key={option.seconds} value={String(option.seconds)}>
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Direction</MenuGroupLabel>
          <MenuRadioGroup value={props.selectedMode} onValueChange={props.onModeChange}>
            <MenuRadioItem value="new">New chat</MenuRadioItem>
            <MenuRadioItem value="queue">Queue current chat</MenuRadioItem>
            <MenuRadioItem value="steer">Steer current chat</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <Button
          type="button"
          size="sm"
          variant="subtle"
          className="mx-1 mb-1 mt-0.5 w-[calc(100%-0.5rem)]"
          disabled={!props.canSchedule}
          onClick={props.onSchedule}
        >
          Start timer
        </Button>
      </ComposerPickerMenuPopup>
    </Menu>
  );
});
