// FILE: Dialog.tsx
// Purpose: HoloBot's dialogs (ported from packages/ui Dialog.tsx and AlertDialog.tsx) on
//          Synara's ui/dialog: the rest of the window is inert and focus stays inside, and
//          Synara's menus open over it. Esc and a click on the scrim close it only when
//          `closable`; the title row has a close button. HoloBot's card, title row and scrim.
//          AlertDialog: a question before something that cannot be taken back.
// Layer: SynBot kit
// Exports: Dialog, AlertDialog

import { useId, useRef, type ReactNode } from "react";

import { Dialog as DialogRoot, DialogPopup } from "~/components/ui/dialog";
import { useTranslation } from "~/i18n";
import { cn } from "~/lib/utils";

import { CapsuleButton, IconButton } from "./controls";

interface DialogProps {
  readonly open: boolean;
  /** Asked to close (Esc, the scrim, the close button): the owner sets `open` false. */
  readonly onClose: () => void;
  readonly title?: ReactNode;
  /** Esc, the scrim and the close button close it (default true). */
  readonly closable?: boolean;
  /** The close button in the title row (default: when closable). */
  readonly closeButton?: boolean;
  /** 580 px instead of 460. */
  readonly wide?: boolean;
  /** Buttons, right-aligned under the body. */
  readonly footer?: ReactNode;
  /** Accessible name when there is no visible title. */
  readonly label?: string;
  readonly children?: ReactNode;
}

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href]";

/** The first control takes the focus, as usual, unless it is the title row's close button: the
 * dialog itself takes it then (no ring on a control nobody chose; Tab reaches it). */
function openingFocus(popup: HTMLElement | null): boolean | HTMLElement {
  const first = popup?.querySelector(FOCUSABLE);
  return popup && first?.closest(".hb-dialog__head") ? popup : true;
}

export function Dialog({
  open,
  onClose,
  title,
  closable = true,
  closeButton = closable,
  wide,
  footer,
  label,
  children,
}: DialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const popup = useRef<HTMLDivElement>(null);

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next && closable) onClose();
      }}
      disablePointerDismissal={!closable}
    >
      <DialogPopup
        ref={popup}
        className={cn("hb hb-dialog", wide && "hb-dialog--wide")}
        backdropClassName="hb hb-dialog__scrim"
        showCloseButton={false}
        bottomStickOnMobile={false}
        initialFocus={() => openingFocus(popup.current)}
        aria-label={label}
        aria-labelledby={title ? titleId : undefined}
      >
        <div className="hb-dialog__box">
          {title || closeButton ? (
            <div className="hb-dialog__head">
              <div className="hb-dialog__title" id={titleId}>
                {title}
              </div>
              {closeButton ? (
                <IconButton icon="close" label={t("synbot:close")} kind="ghost" onClick={onClose} />
              ) : null}
            </div>
          ) : null}
          <div className="hb-dialog__body">{children}</div>
          {footer ? <div className="hb-dialog__footer">{footer}</div> : null}
        </div>
      </DialogPopup>
    </DialogRoot>
  );
}

/** A title, one or two lines, Cancel and the answer (primary, or danger for a removal). Cancel
 * has the focus, so Enter right after it opens does not confirm. */
export function AlertDialog({
  open,
  title,
  message,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  readonly title: ReactNode;
  readonly message?: ReactNode;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const { t } = useTranslation();
  const footer = (
    <>
      <CapsuleButton kind="normal" autoFocus disabled={busy} onClick={onCancel}>
        {t("common:form_cancel")}
      </CapsuleButton>
      <CapsuleButton kind={danger ? "danger" : "primary"} disabled={busy} onClick={onConfirm}>
        {confirmLabel}
      </CapsuleButton>
    </>
  );
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      footer={footer}
      closeButton={false}
      closable={!busy}
    >
      {message}
    </Dialog>
  );
}
