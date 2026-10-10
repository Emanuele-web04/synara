// controlled popover anchored to the requesting row control; the change is held as pending state and only patched on Confirm

import type * as React from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverDescription, PopoverPopup, PopoverTitle } from "~/components/ui/popover";

export function AutomationRiskConfirmPopover({
  open,
  onOpenChange,
  anchor,
  title,
  detail,
  confirmLabel,
  confirmDisabled,
  onConfirm,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly anchor: React.RefObject<HTMLElement | null>;
  readonly title: string;
  readonly detail: string;
  readonly confirmLabel: string;
  readonly confirmDisabled?: boolean;
  readonly onConfirm: () => void;
  /** Optional extra content between the copy and the actions (e.g. a thread picker). */
  readonly children?: React.ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverPopup anchor={anchor} side="bottom" align="end" className="w-72">
        <div className="flex flex-col gap-3">
          <div className="space-y-1">
            <PopoverTitle className="text-ui-lg font-medium">{title}</PopoverTitle>
            <PopoverDescription className="text-ui leading-snug">{detail}</PopoverDescription>
          </div>
          {children}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={confirmDisabled} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
