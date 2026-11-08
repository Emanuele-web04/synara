// FILE: ChoiceParts.tsx
// Purpose: The parts every ask card shares (HoloBot's thread/ChoiceCard.tsx and InlineText.tsx):
//          lettered answer rows (A, B, C…), the two-way pair of small buttons (the first primary,
//          a danger one red), and plain text with its `backticked` commands and paths
//          in the monospace face.
// Layer: SynBot thread UI
// Exports: ChoiceRow, ChoiceRows, Pair, InlineText

import { Fragment } from "react";

import { useTranslation } from "~/i18n";

import { CapsuleButton, type ButtonKind } from "../kit/controls";
import { LETTERS, useLetterKeys } from "./cardKeys";

export interface ChoiceRow {
  readonly id: string;
  readonly label: string;
  readonly danger?: boolean;
  readonly primary?: boolean;
  /** The answer it got: its letter filled. */
  readonly picked?: boolean;
}

/** Lettered answers; on the focused card the letters answer from the keyboard. */
export function ChoiceRows({
  rows,
  open,
  disabled,
  label,
  onPick,
}: {
  readonly rows: readonly ChoiceRow[];
  /** Answerable now (else they only show what was picked). */
  readonly open: boolean;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly onPick: (row: ChoiceRow) => void;
}) {
  const { t } = useTranslation();
  useLetterKeys(open && !disabled ? rows.length : 0, (index) => {
    const row = rows[index];
    if (row) onPick(row);
  });
  if (rows.length === 0) return null;
  return (
    <div className="choice__rows" role="group" aria-label={label ?? t("synbot:answers")}>
      {rows.map((row, index) => (
        <button
          key={row.id}
          type="button"
          className={row.danger ? "choice__row choice__row--danger" : "choice__row"}
          data-picked={row.picked || undefined}
          data-primary={(open && row.primary) || undefined}
          aria-pressed={row.picked}
          disabled={!open || disabled}
          onClick={() => onPick(row)}
        >
          <span className="choice__letter">{LETTERS[open ? index : 0]}</span>
          <span className="choice__label">{row.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Small capsules side by side; the first is primary, a danger one red. */
export function Pair({
  buttons,
  disabled,
  onPick,
}: {
  readonly buttons: readonly (ChoiceRow & { readonly kind?: ButtonKind })[];
  readonly disabled?: boolean;
  readonly onPick: (row: ChoiceRow) => void;
}) {
  const { t } = useTranslation();
  useLetterKeys(disabled ? 0 : buttons.length, (index) => {
    const button = buttons[index];
    if (button) onPick(button);
  });
  return (
    <div className="choice__pair" role="group" aria-label={t("synbot:answers")}>
      {buttons.map((button, index) => (
        <CapsuleButton
          key={button.id}
          kind={button.kind ?? (button.danger ? "danger" : index === 0 ? "primary" : "normal")}
          small
          disabled={disabled}
          onClick={() => onPick(button)}
        >
          {button.label}
        </CapsuleButton>
      ))}
    </div>
  );
}

const CODE = /`([^`\n]+)`/g;
const STRONG = /\*\*([^*\n]+)\*\*/g;

/** A run of plain text with its **bold** words (a bot's result often marks them). */
function Emphasis({ text }: { readonly text: string }) {
  const parts = text.split(STRONG);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          // oxlint-disable-next-line react/no-array-index-key -- positional text parts
          <strong key={index}>{part}</strong>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- positional text parts
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** Plain text with its `backticked` commands and paths in the monospace face and its **bold**
 * words bold. */
export function InlineText({ text }: { readonly text: string }) {
  const parts = text.split(CODE);
  // split() with a group alternates text and captured code.
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          // oxlint-disable-next-line react/no-array-index-key -- positional text parts
          <code key={index} className="inline-code">
            {part}
          </code>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- positional text parts
          <Emphasis key={index} text={part} />
        ),
      )}
    </>
  );
}
