// FILE: ComposerSnoozeNotice.tsx
// Purpose: Composer strip for a snoozed chat: when it returns, how long is left,
//          that sending cancels the reminder, and Return now / Change time.
// Layer: Chat composer UI
// Exports: ComposerSnoozeNotice

import { useState } from "react";

import { ClockIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { SNOOZE_PRESETS, type SnoozeDuration } from "~/lib/threadSnooze";
import { SnoozeCountdown } from "../SnoozeCountdown";
import { SnoozeUntilDialog } from "../SnoozeUntilDialog";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { COMPOSER_INLINE_ACTION_PILL_CLASS_NAME } from "./composerPickerStyles";
import { COMPOSER_NOTICE_CONTENT_CLASS_NAME } from "./composerStackedPanelStyles";

const ACTION_CLASS_NAME = cn(COMPOSER_INLINE_ACTION_PILL_CLASS_NAME, "text-ui-sm");

export function ComposerSnoozeNotice({
  snoozedUntil,
  onReturnNow,
  onReschedule,
}: {
  snoozedUntil: string;
  onReturnNow: () => void;
  onReschedule: (duration: SnoozeDuration) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <div
      role="status"
      data-testid="composer-snooze-notice"
      // Same corners as the banner frame so the tint never pokes past its rounded top.
      className={cn(
        COMPOSER_NOTICE_CONTENT_CLASS_NAME,
        "squircle flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[inherit] bg-info/8",
      )}
    >
      <ClockIcon className="size-3.5 shrink-0 text-info" aria-hidden />
      <span className="min-w-0 flex-1 text-ui-sm text-muted-foreground">
        <span className="font-medium text-foreground">
          <SnoozeCountdown snoozedUntil={snoozedUntil} />
        </span>
        <span className="block">Sending a message cancels the reminder.</span>
      </span>
      <button type="button" className={ACTION_CLASS_NAME} onClick={onReturnNow}>
        Return now
      </button>
      <Menu modal={false}>
        <MenuTrigger render={<button type="button" className={ACTION_CLASS_NAME} />}>
          Change time
        </MenuTrigger>
        <ComposerPickerMenuPopup align="end" side="top" sideOffset={6}>
          {SNOOZE_PRESETS.map((preset) => (
            <MenuItem key={preset.id} onClick={() => onReschedule(preset.duration)}>
              {preset.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onClick={() => setDialogOpen(true)}>Pick date & time…</MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
      <SnoozeUntilDialog
        open={dialogOpen}
        currentSnoozedUntil={snoozedUntil}
        onOpenChange={setDialogOpen}
        onSnooze={onReschedule}
      />
    </div>
  );
}
