// FILE: BatonCard.tsx
// Purpose: A hand-off between two bots, "passing the baton": the head (the asking bot's face,
//          a dashed arrow, the receiving bot's face, "SynBot → QA", when, and where it stands),
//          the brief, then the engine the receiving bot works on with small capsules on one row.
//          In the asking bot's thread it carries Stop and Open (and the result once done); in
//          the receiving bot's thread it carries the Start / Not now answer of the delegation's
//          start card, so the brief shows once (A / B answer it while the card has focus). Once
//          done, or once its delegation left the client's snapshot (where it stood is unknown,
//          so it is settled: no Stop), it folds to one line (the chevron opens it again).
//          Left-aligned like the bot's bubbles.
// Layer: SynBot thread UI
// Exports: BatonCard, BatonStart

import {
  BOT_DELEGATION_TERMINAL_STATES,
  type BotCard,
  type ProjectId,
  type ThreadId,
} from "@synara/contracts";
import { useState } from "react";

import { useNowMs } from "~/hooks/useNowMs";
import { useTranslation } from "~/i18n";
import { readNativeApi } from "~/nativeApi";
import { batonState, withinBatonGrace } from "~/synbot/botThread.logic";
import { botById, delegationById } from "~/synbot/synbotState.logic";
import { useSynbotStore } from "~/synbot/synbotStore";
import type { WorkLogSynbotNotice } from "~/workLog";

import { delegationMood } from "../BotFace";
import { CapsuleButton, type Tone } from "../kit/controls";
import { Icon } from "../kit/Icon";
import { useOpenBot } from "../synbotNav";
import { CardHead, FacePath, FoldToggle, ModelChip, StatusChip, useTimeAgo } from "./CardParts";
import { letterKeyHandler } from "./cardKeys";
import { InlineText } from "./ChoiceParts";
import { delegationStateKey, delegationTone } from "./stateWords";
import { useCardAnswer } from "./useCardAnswer";
import { useStopAction } from "./useStopAction";

/** The delegation's start card, answered from the baton in the receiving bot's thread. */
export interface BatonStart {
  readonly card: BotCard;
  readonly threadId: ThreadId | null;
  readonly resolution: WorkLogSynbotNotice["resolution"];
}

/** How often a baton without its delegation checks whether its grace has run out. */
const GRACE_TICK_MS = 15_000;

export function BatonCard({
  delegationId,
  fromBotId,
  toBotId,
  brief,
  createdAt,
  side,
  start,
}: {
  readonly delegationId: string;
  readonly fromBotId?: ProjectId | null;
  readonly toBotId?: ProjectId | null;
  /** What was asked; null when no brief is known (the internal prompt never shows). */
  readonly brief: string | null;
  /** When the hand-off was sent, for a delegation the snapshot no longer has. */
  readonly createdAt?: string | null;
  /** Whose thread it sits in: the asking bot's or the receiving bot's. */
  readonly side: "from" | "to";
  readonly start?: BatonStart | null;
}) {
  const { t } = useTranslation();
  const openBot = useOpenBot();
  const data = useSynbotStore((store) => store.data);
  const snapshotReady = useSynbotStore((store) => store.status === "ready");
  const delegation = delegationById(data, delegationId);
  const from = botById(data, fromBotId ?? delegation?.fromBotId ?? null);
  const to = botById(data, toBotId ?? delegation?.toBotId ?? null);
  const { stopping, stop: runStop } = useStopAction();
  const [unfolded, setUnfolded] = useState(false);
  const startOpen = side === "to" && start != null && !start.resolution;
  const { pending, answered, answer } = useCardAnswer(
    startOpen ? start.card : null,
    start?.threadId ?? null,
  );
  // Only a hand-off sent moments ago and not yet in the snapshot needs the clock (its grace
  // after sending); an old one settles at once and never ticks.
  const [mountedAt] = useState(Date.now);
  const now = useNowMs(
    delegation === null && withinBatonGrace(createdAt ?? null, mountedAt),
    GRACE_TICK_MS,
  );
  const state = batonState({
    live: delegation?.state ?? null,
    startOpen,
    startAnswered: Boolean(start?.resolution),
    snapshotReady,
    createdAt: createdAt ?? null,
    nowMs: now,
  });
  const settled = state === "settled";
  const active = !settled && !BOT_DELEGATION_TERMINAL_STATES.has(state);
  const tone: Tone = settled ? "muted" : delegationTone(state);
  const statusLabel = settled ? (start?.resolution?.label ?? "") : t(delegationStateKey(state));
  const result = !active && side === "from" ? (delegation?.resultSummary ?? null) : null;
  const stop = () => runStop(() => readNativeApi()?.bots.cancelDelegation({ delegationId }));
  const other = side === "from" ? to : from;
  const title = t("synbot:batonTitle", {
    from: from?.name ?? t("synbot:removedBot"),
    to: to?.name ?? t("synbot:removedBot"),
  });
  const when = useTimeAgo(delegation?.createdAt ?? createdAt ?? null);
  const faces = <FacePath from={from} to={to} toMood={settled ? "idle" : delegationMood(state)} />;
  const status = statusLabel ? <StatusChip tone={tone} label={statusLabel} /> : null;
  // The Start card's answers: Not now first, Start (primary) last on the right; A / B too.
  const options = startOpen
    ? start.card.options.toSorted(
        (left, right) => Number(left.tone === "primary") - Number(right.tone === "primary"),
      )
    : [];
  const answerable = startOpen && pending === null && !answered;
  const onKeyDown = letterKeyHandler(answerable ? options.length : 0, (index) => {
    const option = options[index];
    if (option) answer(option.id, option.label);
  });
  // Done (or over, how unknown): one line, its chevron opens the rest.
  const folds = state === "completed" || settled;
  if (folds && !unfolded) {
    return (
      <article className="baton baton--folded" data-settled={settled || undefined}>
        <CardHead faces={faces} title={title} sub={when} status={status} />
        <FoldToggle open={false} onToggle={() => setUnfolded(true)} />
      </article>
    );
  }
  const engine = to ? (to.taskModelSelection ?? to.modelSelection) : null;
  return (
    <article
      className="baton"
      data-settled={settled || undefined}
      onKeyDown={answerable ? onKeyDown : undefined}
    >
      <div className="baton__top">
        <CardHead faces={faces} title={title} sub={when} status={status} />
        {folds ? <FoldToggle open onToggle={() => setUnfolded(false)} /> : null}
      </div>
      {brief ? (
        <p className="baton__brief">
          <InlineText text={brief} />
        </p>
      ) : null}
      {result ? (
        <p className="baton__result">
          <InlineText text={result} />
        </p>
      ) : null}
      {startOpen && answered ? (
        // Answered: the choice stands until the card's resolution reaches the thread.
        <p className="baton__answered">
          <Icon name="check" size="xs" />
          {answered.label}
        </p>
      ) : startOpen ? (
        <div className="baton__foot">
          {engine ? <ModelChip selection={engine} /> : null}
          <div className="baton__actions" role="group" aria-label={t("synbot:answers")}>
            {options.map((option) => (
              <CapsuleButton
                key={option.id}
                kind={option.tone === "primary" ? "primary" : "normal"}
                compact
                disabled={pending !== null}
                onClick={() => answer(option.id, option.label)}
              >
                {option.label}
              </CapsuleButton>
            ))}
          </div>
        </div>
      ) : engine || (active && side === "from") || other ? (
        // The engine and the capsules share one row, so no row holds a lone button.
        <div className="baton__foot">
          {engine ? <ModelChip selection={engine} /> : null}
          <div className="baton__actions">
            {active && side === "from" ? (
              <CapsuleButton kind="danger" small disabled={stopping} onClick={stop}>
                {t("synbot:stop")}
              </CapsuleButton>
            ) : null}
            {other ? (
              <CapsuleButton kind="card" small onClick={() => openBot(other)}>
                {t("synbot:openBot", { name: other.name })}
                <Icon name="arrow-right" size="xs" />
              </CapsuleButton>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}
