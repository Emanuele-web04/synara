// FILE: SnoozeUntilDialog.tsx
// Purpose: Custom snooze date-time entry, shared by the sidebar menu and the in-chat notice.
// Layer: Shared UI component
// Exports: SnoozeUntilDialog

import { parseFutureDateTimeLocalValue, toDateTimeLocalValue } from "../lib/threadSnooze";
import { RenameDialog } from "./RenameDialog";

export function SnoozeUntilDialog({
  open,
  currentSnoozedUntil,
  onOpenChange,
  onSnooze,
}: {
  open: boolean;
  currentSnoozedUntil: string | null;
  onOpenChange: (open: boolean) => void;
  onSnooze: (deadline: Date) => void;
}) {
  const initialValue = toDateTimeLocalValue(
    currentSnoozedUntil !== null
      ? new Date(currentSnoozedUntil)
      : new Date(Date.now() + 60 * 60_000),
  );
  return (
    <RenameDialog
      open={open}
      title="Snooze until"
      description="The chat returns with a reminder at this time."
      initialValue={initialValue}
      inputType="datetime-local"
      saveLabel="Snooze"
      isValueValid={(value) => parseFutureDateTimeLocalValue(value, Date.now()) !== null}
      onOpenChange={onOpenChange}
      onSave={(value) => {
        const deadline = parseFutureDateTimeLocalValue(value, Date.now());
        if (deadline) onSnooze(deadline);
      }}
    />
  );
}
