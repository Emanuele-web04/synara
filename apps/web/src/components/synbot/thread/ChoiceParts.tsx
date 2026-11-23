// FILE: ChoiceParts.tsx
// Purpose: The parts every ask card shares (HoloBot's thread/ChoiceCard.tsx and InlineText.tsx):
//          lettered answer rows (A, B, C…, each with an optional line under it; answered, the
//          pick keeps its own letter), the two-way pair of answer buttons (primary only when the
//          answer is, a danger one red), and plain text with its `backticked` commands and paths
//          in the monospace face. The letters answer from the keyboard through the card's own
//          onKeyDown (cardKeys.ts).
// Layer: SynBot thread UI
// Exports: ChoiceRow, ChoiceRows, Pair, InlineText

import { Fragment } from "react";

import { useTranslation } from "~/i18n";

import { CapsuleButton, type ButtonKind } from "../kit/controls";
import { Icon } from "../kit/Icon";
import { LETTERS } from "./cardKeys";

export interface ChoiceRow {
  readonly id: string;
  readonly label: string;
  /** A quiet line under the label (a question option's description). */
  readonly detail?: string | undefined;
  readonly danger?: boolean;
  readonly primary?: boolean;
  /** The answer it got: its letter filled. */
  readonly picked?: boolean;
  /** Its letter where the rows show only the pick (its place among the answers offered); null
   * for an answer that had none (a dismiss): a check instead. */
  readonly letter?: string | null;
}

/** Lettered answers; the card's onKeyDown answers them from the keyboard. */
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
  if (rows.length === 0) return null;
  return (
    <div className="choice__rows" role="group" aria-label={label ?? t("synbot:answers")}>
      {rows.map((row, index) => {
        const letter = row.letter === undefined ? LETTERS[index] : row.letter;
        return (
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
            <span className="choice__letter" aria-hidden>
              {letter ?? <Icon name="check" size="xs" />}
            </span>
            <span className="choice__text">
              <span className="choice__label">{row.label}</span>
              {row.detail ? <span className="choice__sub">{row.detail}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Answer buttons side by side: primary only when the answer is, a danger one red. */
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
  return (
    <div className="choice__pair" role="group" aria-label={t("synbot:answers")}>
      {buttons.map((button) => (
        <CapsuleButton
          key={button.id}
          kind={button.kind ?? (button.primary ? "primary" : button.danger ? "danger" : "normal")}
          compact
          disabled={disabled}
          title={button.detail}
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
