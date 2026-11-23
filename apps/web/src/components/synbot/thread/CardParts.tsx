// FILE: CardParts.tsx
// Purpose: The pieces every work card in a bot's thread shares (the hand-off, the task, the
//          report, the merge proof): the head (faces, a title with a quiet line under it, the
//          state chip on the right), the two faces of a hand-off joined by a dashed arrow, the
//          state chip, the one checklist mark (a task's steps, the proof's checks, a report's
//          outcome), the engine chip (the provider's mark and the model's name), the fold toggle
//          and "5m ago" that keeps itself current.
// Layer: SynBot thread UI
// Exports: CardHead, FacePath, StatusChip, StatusMark, MarkShape, MarkTone, ModelChip,
//          FoldToggle, useTimeAgo

import type { Bot, ModelSelection } from "@synara/contracts";
import { formatModelDisplayName } from "@synara/shared/model";
import type { ReactNode } from "react";

import { useNowMs } from "~/hooks/useNowMs";
import { useTranslation } from "~/i18n";
import { formatRelativeTimeAgo } from "~/lib/relativeTime";

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

/** The relative times on the cards move on once a minute (half a minute keeps "now" honest). */
const TIME_TICK_MS = 30_000;

/** "5m ago" for `iso`, kept current while the card shows (null without a time). */
export function useTimeAgo(iso: string | null | undefined): string | null {
  const now = useNowMs(Boolean(iso), TIME_TICK_MS);
  return iso ? formatRelativeTimeAgo(iso, now) : null;
}

/** A mark's shape: done, failed, under way (a ring with a dot), not yet (an empty ring). */
export type MarkShape = "check" | "cross" | "dot" | "ring";
/** Its color: the text's ink, or a tone's. */
export type MarkTone = "ink" | "good" | "bad" | "attention" | "muted";

/** The one checklist mark every card uses: a task's steps, the proof's checks, a report's end. */
export function StatusMark({
  shape,
  tone = "ink",
}: {
  readonly shape: MarkShape;
  readonly tone?: MarkTone;
}) {
  return (
    <svg
      className={`status-mark status-mark--${tone}`}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      aria-hidden
    >
      {shape === "check" || shape === "cross" ? (
        <>
          <circle cx="12" cy="12" r="11" className="status-mark__fill" />
          <path
            d={shape === "check" ? "m7.5 12 3 3 6-6.5" : "m8.5 8.5 7 7m0-7-7 7"}
            fill="none"
            className="status-mark__on"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : shape === "dot" ? (
        <>
          <circle
            cx="12"
            cy="12"
            r="10"
            fill="none"
            className="status-mark__ring"
            strokeWidth="2"
          />
          <circle cx="12" cy="12" r="4" className="status-mark__fill" />
        </>
      ) : (
        <circle cx="12" cy="12" r="10" fill="none" className="status-mark__ring" strokeWidth="2" />
      )}
    </svg>
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
