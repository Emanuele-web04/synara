// FILE: Dialog.tsx
// Purpose: HoloBot's dialogs (ported from packages/ui Dialog.tsx and AlertDialog.tsx): a native
//          <dialog> opened with showModal(), so the rest of the window is inert and focus stays
//          inside. Esc and a click on the scrim close it only when `closable`; the title row has
//          a close button. AlertDialog: a question before something that cannot be taken back.
// Layer: SynBot kit
// Exports: Dialog, AlertDialog

import {
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { useTranslation } from "~/i18n";

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

export function Dialog(props: DialogProps) {
  if (!props.open) return null;
  return <OpenDialog {...props} />;
}

function OpenDialog({
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
  const ref = useRef<HTMLDialogElement>(null);
  const latest = useRef({ onClose, closable });
  useEffect(() => {
    latest.current = { onClose, closable };
  });

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    // showModal() focuses the first control; when that is the close button, the dialog itself
    // takes the focus instead (no ring on a control nobody chose; Tab reaches it).
    if (document.activeElement === dialog.querySelector(".hb-dialog__head button")) dialog.focus();
    // Closed by something else (a close watcher): reopen unless it may close.
    const onNativeClose = () => {
      // A close queued by an earlier mount (React remounting the effect) arrives after the
      // dialog opened again: it is stale.
      if (dialog.open) return;
      if (latest.current.closable) latest.current.onClose();
      else if (dialog.isConnected) dialog.showModal();
    };
    dialog.addEventListener("close", onNativeClose);
    return () => {
      dialog.removeEventListener("close", onNativeClose);
      if (dialog.open) dialog.close();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (closable) onClose();
  };
  // The box fills the <dialog> element: a click whose target is the element itself landed on
  // the scrim.
  const onClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === ref.current && closable) onClose();
  };

  return (
    <dialog
      ref={ref}
      className={`hb hb-dialog${wide ? " hb-dialog--wide" : ""}`}
      tabIndex={-1}
      aria-label={label}
      onKeyDown={onKeyDown}
      onCancel={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <div className="hb-dialog__box">
        {title || closeButton ? (
          <div className="hb-dialog__head">
            <div className="hb-dialog__title">{title}</div>
            {closeButton ? (
              <IconButton icon="close" label={t("synbot:close")} kind="ghost" onClick={onClose} />
            ) : null}
          </div>
        ) : null}
        <div className="hb-dialog__body">{children}</div>
        {footer ? <div className="hb-dialog__footer">{footer}</div> : null}
      </div>
    </dialog>
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
