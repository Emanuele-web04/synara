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
//
// The "feature" presentation is for launches that earn more room: a 480px sheet whose
// hero is a full-bleed illustrated band with its own close button, then a centered
// pitch and capsule actions.

import { useRef, type ReactNode, type KeyboardEventHandler } from "react";

import { useAnnouncementSheetSlot } from "./announcementSheetSlot";
import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const ACTION_BUTTON_CLASS_NAME = "rounded-[10px] text-ui-lg sm:text-ui-lg";
const FEATURE_ACTION_BUTTON_CLASS_NAME = "min-w-28 px-5 text-ui-lg sm:text-ui-lg";

export function AnnouncementSheet(props: {
  open: boolean;
  presentation?: "sheet" | "tour" | "feature";
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  // Footer start (e.g. a pager) and the slot between dismiss and confirm (e.g. Back).
  navigation?: ReactNode;
  navigationEnd?: ReactNode;
  handOffOnConfirm?: boolean;
  allowAfterHandOff?: boolean;
  // Beta welcome runs before the first-run gate; ordinary announcements wait for it.
  waitForOnboarding?: boolean;
  // "last" waits until startup settles and every other queued sheet or hint is done.
  order?: "any" | "last";
  // Decorative hero rendered above the title; the sheet owns the spacing below it.
  hero: ReactNode;
  title: ReactNode;
  // Two lines at 378px wide is the reference sheet's proportion; longer copy wraps to
  // three and throws the whole vertical rhythm off.
  description: ReactNode;
  // Optional structured content (rows, a status note) below the pitch. Kept out of
  // the description because that renders as a paragraph.
  details?: ReactNode;
  // Omitted on single-action sheets; the confirm button still closes via onConfirm.
  dismissLabel?: string;
  confirmLabel: string;
  // Fired by the dismiss button and by Escape / backdrop closes.
  onDismiss: () => void;
  onConfirm: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  // Announcements probe independently at startup; only the slot holder is shown so two
  // sheets never stack. The other opens once this one is dismissed, but not after a
  // confirm, whose follow-on flow it would cover.
  const { open, handOff } = useAnnouncementSheetSlot(
    props.open,
    props.allowAfterHandOff,
    props.waitForOnboarding,
    props.order,
  );
  const confirm = () => {
    if (props.handOffOnConfirm !== false) handOff();
    props.onConfirm();
  };
  if (props.presentation === "feature") {
    return (
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) props.onDismiss();
        }}
      >
        <DialogPopup
          showCloseButton={false}
          initialFocus={sheetRef}
          onKeyDown={props.onKeyDown}
          className="max-w-[480px] overflow-hidden rounded-[20px]"
        >
          <div
            ref={sheetRef}
            tabIndex={-1}
            className="flex min-h-0 flex-col overflow-y-auto outline-none"
          >
            <div className="relative h-[268px] shrink-0 overflow-hidden">
              <div aria-hidden className="absolute inset-0">
                {props.hero}
              </div>
              {/* Frosted so it reads on any hero art; Escape and the backdrop close too. */}
              <DialogClose
                aria-label="Close"
                className="absolute end-3 top-3 rounded-lg bg-white/25 text-neutral-900 ring-1 ring-white/55 ring-inset backdrop-blur-sm [:hover,[data-pressed]]:bg-white/45 [:hover,[data-pressed]]:text-neutral-900"
                render={<Button size="icon-xs" variant="ghost" />}
              >
                <XIcon />
              </DialogClose>
            </div>

            <div className="flex flex-col items-center px-10 pt-7 pb-8 text-center max-sm:px-6">
              <DialogHeader className="items-center gap-2 p-0">
                <DialogTitle className="text-[20px] leading-tight tracking-[-0.015em]">
                  {props.title}
                </DialogTitle>
                <DialogDescription className="max-w-[380px] text-ui-lg leading-normal">
                  {props.description}
                </DialogDescription>
              </DialogHeader>

              {props.details}

              <DialogFooter
                variant="bare"
                className="justify-center gap-3 p-0 pt-6 sm:justify-center"
              >
                {props.dismissLabel !== undefined ? (
                  <Button
                    shape="capsule"
                    size="lg"
                    variant="subtle"
                    className={FEATURE_ACTION_BUTTON_CLASS_NAME}
                    onClick={props.onDismiss}
                  >
                    {props.dismissLabel}
                  </Button>
                ) : null}
                <Button
                  shape="capsule"
                  size="lg"
                  className={FEATURE_ACTION_BUTTON_CLASS_NAME}
                  onClick={confirm}
                >
                  {props.confirmLabel}
                </Button>
              </DialogFooter>
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    );
  }
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
        onKeyDown={props.onKeyDown}
        data-feature-tour={props.presentation === "tour" ? "" : undefined}
        className="max-w-[420px] rounded-[20px]"
      >
        {/* Take initial focus here rather than on the first button: the sheet opens
            unprompted at startup, and a ring on the dismiss button points at the wrong
            action. Tab still reaches both buttons and rings them normally. */}
        <div
          ref={sheetRef}
          tabIndex={-1}
          className="flex min-h-0 flex-col overflow-y-auto p-5 outline-none"
        >
          <div
            aria-hidden
            className={cn(
              "mb-8 flex h-16 items-center",
              props.presentation === "tour" && "mb-6 h-auto shrink-0",
            )}
          >
            {props.hero}
          </div>

          <DialogHeader
            className={cn("gap-2 p-0", props.presentation === "tour" && "min-h-[90px] shrink-0")}
          >
            <DialogTitle className="text-[19px] leading-tight">{props.title}</DialogTitle>
            <DialogDescription className="text-ui-lg leading-normal">
              {props.description}
            </DialogDescription>
          </DialogHeader>

          {props.details}

          <DialogFooter
            className={cn(
              "shrink-0 gap-2 p-0 pt-3",
              props.presentation === "tour" && "flex-row flex-wrap items-center justify-end",
            )}
          >
            {props.navigation}
            {props.dismissLabel !== undefined ? (
              <Button
                variant="ghost"
                className={ACTION_BUTTON_CLASS_NAME}
                onClick={props.onDismiss}
              >
                {props.dismissLabel}
              </Button>
            ) : null}
            {props.navigationEnd}
            <Button className={ACTION_BUTTON_CLASS_NAME} onClick={confirm}>
              {props.confirmLabel}
            </Button>
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
