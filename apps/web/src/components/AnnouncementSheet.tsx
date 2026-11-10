// FILE: AnnouncementSheet.tsx
// Purpose: Shared one-time announcement sheet — a hero band with a small scene, a
// centered title and short pitch, then dismiss/confirm.
// Layer: Root web overlay
// Exports: AnnouncementSheet (startup slot + dialog), AnnouncementSheetPopup (layout only)
//
// The band is the same DialogHeroBand that opens Add a device, so every announcement opens
// the same way. 420px wide; body copy and buttons follow the UI font size from Settings;
// only the title is fixed.
//
// Uses the dialog system's opaque "solid" surface — the frosted composer default
// reads translucent over the desktop, since the Electron window itself is
// transparent under macOS vibrancy.

import { useRef, type ReactNode } from "react";

import { useAnnouncementSheetSlot } from "./announcementSheetSlot";
import { DialogHeroBand } from "./DialogHeroBand";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const ACTION_BUTTON_CLASS_NAME = "flex-1 rounded-[10px] text-ui-lg sm:text-ui-lg";

interface AnnouncementSheetContent {
  // Decorative scene rendered inside the hero band; the band owns its size and backdrop.
  hero: ReactNode;
  title: ReactNode;
  // Two lines at 364px wide is the reference proportion; longer copy wraps to three and
  // throws the whole vertical rhythm off.
  description: ReactNode;
  // Optional structured content (rows, a status note) below the pitch. Kept out of
  // the description because that renders as a paragraph.
  details?: ReactNode;
  // Omitted on single-action sheets; the confirm button still closes via onConfirm.
  dismissLabel?: string;
  confirmLabel: string;
  confirmDisabled?: boolean;
  onDismiss: () => void;
  onConfirm: () => void;
}

/** The sheet's popup without the startup slot, for surfaces that arbitrate on their own. */
export function AnnouncementSheetPopup(props: AnnouncementSheetContent) {
  const sheetRef = useRef<HTMLDivElement>(null);
  return (
    // The dismiss button is the close affordance, so the popup's own X would be a duplicate.
    <DialogPopup
      showCloseButton={false}
      initialFocus={sheetRef}
      className="max-w-[420px] overflow-hidden rounded-[20px]"
    >
      {/* Take initial focus here rather than on the first button: the sheet opens
          unprompted at startup, and a ring on the dismiss button points at the wrong
          action. Tab still reaches both buttons and rings them normally. */}
      <div
        ref={sheetRef}
        tabIndex={-1}
        className="flex min-h-0 flex-col overflow-y-auto outline-none"
      >
        <DialogHeroBand>{props.hero}</DialogHeroBand>
        <div className="flex flex-col px-7 pt-5 pb-6">
          <DialogHeader className="items-center gap-1.5 p-0 text-center">
            <DialogTitle className="text-[19px] leading-tight">{props.title}</DialogTitle>
            <DialogDescription className="text-ui-lg leading-normal text-balance">
              {props.description}
            </DialogDescription>
          </DialogHeader>

          {props.details}

          <DialogFooter variant="bare" className="shrink-0 gap-2 p-0 pt-5">
            {props.dismissLabel !== undefined ? (
              <Button
                variant="secondary"
                className={ACTION_BUTTON_CLASS_NAME}
                onClick={props.onDismiss}
              >
                {props.dismissLabel}
              </Button>
            ) : null}
            <Button
              className={ACTION_BUTTON_CLASS_NAME}
              disabled={props.confirmDisabled}
              onClick={props.onConfirm}
            >
              {props.confirmLabel}
            </Button>
          </DialogFooter>
        </div>
      </div>
    </DialogPopup>
  );
}

export function AnnouncementSheet(
  props: AnnouncementSheetContent & {
    open: boolean;
    handOffOnConfirm?: boolean;
    allowAfterHandOff?: boolean;
    // Beta welcome runs before the first-run gate; ordinary announcements wait for it.
    waitForOnboarding?: boolean;
  },
) {
  // Announcements probe independently at startup; only the slot holder is shown so two
  // sheets never stack. The other opens once this one is dismissed, but not after a
  // confirm, whose follow-on flow it would cover.
  const {
    open: wantsOpen,
    handOffOnConfirm,
    allowAfterHandOff,
    waitForOnboarding,
    ...content
  } = props;
  const { open, handOff } = useAnnouncementSheetSlot(
    wantsOpen,
    allowAfterHandOff,
    waitForOnboarding,
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        // Fired by Escape / backdrop closes; the dismiss button calls onDismiss directly.
        if (!nextOpen) props.onDismiss();
      }}
    >
      <AnnouncementSheetPopup
        {...content}
        onConfirm={() => {
          if (handOffOnConfirm !== false) handOff();
          props.onConfirm();
        }}
      />
    </Dialog>
  );
}
