// FILE: AnnouncementSheet.tsx
// Purpose: Shared one-time announcement sheet — hero, title, short pitch, then dismiss/confirm.
// Layer: Root web overlay
//
// Geometry is matched to the macOS system announcement sheet it apes — 420px wide,
// 20px padding, 64px hero, 32px buttons. Body copy and buttons follow the UI font size
// from Settings; only the title is fixed.
//
// Uses the dialog system's opaque "solid" surface — the frosted composer default
// reads translucent over the desktop, since the Electron window itself is
// transparent under macOS vibrancy.

import { useRef, type ReactNode } from "react";

import { useAnnouncementSheetSlot } from "./announcementSheetSlot";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const ACTION_BUTTON_CLASS_NAME =
  "rounded-[10px] text-[length:var(--app-font-size-ui-lg,13px)] sm:text-[length:var(--app-font-size-ui-lg,13px)]";

export function AnnouncementSheet(props: {
  open: boolean;
  // Decorative hero rendered above the title; the sheet owns the spacing below it.
  hero: ReactNode;
  title: ReactNode;
  // Two lines at 378px wide is the reference sheet's proportion; longer copy wraps to
  // three and throws the whole vertical rhythm off.
  description: ReactNode;
  dismissLabel: string;
  confirmLabel: string;
  // Fired by the dismiss button and by Escape / backdrop closes.
  onDismiss: () => void;
  onConfirm: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  // Announcements probe independently at startup; only the slot holder is shown so two
  // sheets never stack. The other opens once this one closes.
  const open = useAnnouncementSheetSlot(props.open);
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) props.onDismiss();
      }}
    >
      {/* The dismiss button is the close affordance, so the popup's own X would be a duplicate. */}
      <DialogPopup
        showCloseButton={false}
        initialFocus={sheetRef}
        className="max-w-[420px] rounded-[20px]"
      >
        {/* Take initial focus here rather than on the first button: the sheet opens
            unprompted at startup, and a ring on the dismiss button points at the wrong
            action. Tab still reaches both buttons and rings them normally. */}
        <div ref={sheetRef} tabIndex={-1} className="flex flex-col p-5 outline-none">
          <div aria-hidden className="mb-8 flex h-16 items-center">
            {props.hero}
          </div>

          <DialogHeader className="gap-2 p-0">
            <DialogTitle className="text-[19px] leading-tight">{props.title}</DialogTitle>
            <DialogDescription className="text-[length:var(--app-font-size-ui-lg,13px)] leading-normal">
              {props.description}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="gap-2 p-0 pt-3">
            <Button variant="ghost" className={ACTION_BUTTON_CLASS_NAME} onClick={props.onDismiss}>
              {props.dismissLabel}
            </Button>
            <Button className={ACTION_BUTTON_CLASS_NAME} onClick={props.onConfirm}>
              {props.confirmLabel}
            </Button>
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
