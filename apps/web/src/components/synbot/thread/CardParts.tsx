// FILE: CardParts.tsx
// Purpose: The pieces every work card in a bot's thread shares (the hand-off, the task, the
//          report): the head (faces, a title with a quiet line under it, the state chip on the
//          right), the two faces of a hand-off joined by a dashed arrow, the state chip, the
//          engine chip (the provider's mark and the model's name) and the fold toggle.
// Layer: SynBot thread UI
// Exports: CardHead, FacePath, StatusChip, ModelChip, FoldToggle

import type { Bot, ModelSelection } from "@synara/contracts";
import { formatModelDisplayName } from "@synara/shared/model";
import type { ReactNode } from "react";

import { useTranslation } from "~/i18n";

import { ProviderIcon } from "../../ProviderIcon";
import { BotFace } from "../BotFace";
import { Chip, type Tone } from "../kit/controls";
import { Icon, type IconName } from "../kit/Icon";
import type { MascotMood } from "../kit/mood";

/** The faces' size in a card's head and folded line. */
export const CARD_FACE = 22;

/** Faces (or one face), the title and a quiet line under it, the state chip on the right. */
export function CardHead({
  faces,
  title,
  sub,
  status,
}: {
  readonly faces: ReactNode;
  readonly title: ReactNode;
  readonly sub?: ReactNode;
  readonly status?: ReactNode;
}) {
  return (
    <div className="card-head">
      <span className="card-head__faces">{faces}</span>
      <span className="card-head__text">
        <span className="card-head__title">{title}</span>
        {sub ? <span className="card-head__sub">{sub}</span> : null}
      </span>
      {status}
    </div>
  );
}

/** The asking bot's face, a dashed arrow, the receiving bot's face. */
export function FacePath({
  from,
  to,
  toMood,
}: {
  readonly from: Bot | null;
  readonly to: Bot | null;
  readonly toMood: MascotMood;
}) {
  return (
    <span className="face-path" aria-hidden>
      <BotFace bot={from} size={CARD_FACE} mood="idle" />
      <svg className="face-path__arrow" width="14" height="8" viewBox="0 0 14 8" fill="none">
        <path d="M1 4h9" strokeWidth="1.4" strokeDasharray="1.5 2.5" strokeLinecap="round" />
        <path d="M9.5 1.5 12 4l-2.5 2.5" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <BotFace bot={to} size={CARD_FACE} mood={toMood} />
    </span>
  );
}

const STATUS_ICON: Partial<Record<Tone, IconName>> = {
  active: "loading",
  good: "check",
  bad: "close",
};

/** Where a card's work stands: a dot while it waits for you, a spinner while it runs, a check
 * when done, a cross when it failed. */
export function StatusChip({ tone, label }: { readonly tone: Tone; readonly label: string }) {
  const icon = STATUS_ICON[tone];
  return (
    <Chip tone={tone} dot={tone === "attention"} icon={icon}>
      {label}
    </Chip>
  );
}

/** The engine a bot works on: the provider's mark and the model's name. */
export function ModelChip({ selection }: { readonly selection: ModelSelection }) {
  const name = formatModelDisplayName(selection.model) ?? selection.model;
  return (
    <Chip
      tone="muted"
      className="hb-chip--engine"
      title={selection.model}
      leading={
        // ProviderIcon brings the provider's own tone. Importing ProviderModelPicker for it
        // would pull the browser history into every card (and break tests in Node).
        <ProviderIcon provider={selection.provider} className="hb-chip__mark" />
      }
    >
      {name}
    </Chip>
  );
}

/** The chevron that folds a finished card to one line and opens it again. */
export function FoldToggle({
  open,
  onToggle,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label = open ? t("synbot:cardFold") : t("synbot:cardUnfold");
  return (
    <button
      type="button"
      className="card-fold"
      aria-expanded={open}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      <Icon name="chevron-down" size="xs" />
    </button>
  );
}
