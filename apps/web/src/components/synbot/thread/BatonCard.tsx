// FILE: BatonCard.tsx
// Purpose: A hand-off between two bots, drawn as "passing the baton": the asking bot's face, a
//          dashed arrow, the receiving bot's face, "SynBot → QA", the brief, then where it
//          stands. In the asking bot's thread it carries Open and Stop (and the result once
//          done); in the receiving bot's thread it carries the Start / Not now answer of the
//          delegation's start card, so the brief shows once. Left-aligned like the bot's bubbles.
// Layer: SynBot thread UI
// Exports: BatonCard, BatonStart, delegationTone

import {
  BOT_DELEGATION_TERMINAL_STATES,
  type BotCard,
  type BotDelegationState,
  type ProjectId,
  type ThreadId,
} from "@synara/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { useTranslation } from "~/i18n";
import { readNativeApi } from "~/nativeApi";
import { botById, delegationById } from "~/synbot/synbotState.logic";
import { useSynbotStore } from "~/synbot/synbotStore";
import type { WorkLogSynbotNotice } from "~/workLog";

import { toastManager } from "../../ui/toast";
import { BotFace } from "../BotFace";
import type { Tone } from "../kit/controls";
import { Icon } from "../kit/Icon";
import { useOpenBot } from "../synbotNav";
import { useLetterKeys } from "./cardKeys";
import { InlineText } from "./ChoiceParts";
import { useCardAnswer } from "./useCardAnswer";

const FACE = 30;

/** The delegation's start card, answered from the baton in the receiving bot's thread. */
export interface BatonStart {
  readonly card: BotCard;
  readonly threadId: ThreadId | null;
  readonly resolution: WorkLogSynbotNotice["resolution"];
}

/** A delegation's tone: amber while it waits for the user, then working, done, failed. */
export function delegationTone(state: BotDelegationState): Tone {
  switch (state) {
    case "awaiting-start":
    case "waiting":
      return "attention";
    case "sent":
    case "working":
      return "active";
    case "completed":
      return "good";
    case "failed":
      return "bad";
    case "cancelled":
      return "muted";
  }
}

/** Not now, then Start: the start card's answers as Synara buttons, A / B from the keyboard. */
function StartAnswers({ start }: { readonly start: BatonStart }) {
  const { pending, answered, answer } = useCardAnswer(start.card, start.threadId);
  // The primary answer (Start) goes last, on the right.
  const options = start.card.options.toSorted(
    (left, right) => Number(left.tone === "primary") - Number(right.tone === "primary"),
  );
  useLetterKeys(pending === null && !answered ? options.length : 0, (index) => {
    const option = options[index];
    if (option) answer(option.id, option.label);
  });
  // Answered: the choice stands until the card's resolution reaches the thread.
  if (answered) {
    return (
      <p className="baton__status baton__status--muted">
        <Icon name="check" size="xs" />
        {answered.label}
      </p>
    );
  }
  return (
    <div className="baton__answers">
      {options.map((option) => (
        <Button
          key={option.id}
          variant={option.tone === "primary" ? "default" : "outline"}
          size="sm"
          className="baton__answer"
          disabled={pending !== null}
          onClick={() => answer(option.id, option.label)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

export function BatonCard({
  delegationId,
  fromBotId,
  toBotId,
  brief,
  side,
  start,
}: {
  readonly delegationId: string;
  readonly fromBotId?: ProjectId | null;
  readonly toBotId?: ProjectId | null;
  readonly brief: string;
  /** Whose thread it sits in: the asking bot's or the receiving bot's. */
  readonly side: "from" | "to";
  readonly start?: BatonStart | null;
}) {
  const { t } = useTranslation();
  const openBot = useOpenBot();
  const data = useSynbotStore((store) => store.data);
  const delegation = delegationById(data, delegationId);
  const from = botById(data, fromBotId ?? delegation?.fromBotId ?? null);
  const to = botById(data, toBotId ?? delegation?.toBotId ?? null);
  const [stopping, setStopping] = useState(false);
  const startOpen = side === "to" && start != null && !start.resolution;
  // Without the live delegation: waiting while its Start is open, the answer once given.
  const state: BotDelegationState | null =
    delegation?.state ?? (startOpen ? "awaiting-start" : start?.resolution ? null : "sent");
  const active = state !== null && !BOT_DELEGATION_TERMINAL_STATES.has(state);
  const tone: Tone = state ? delegationTone(state) : "muted";
  const statusLabel = state ? t(`synbot:delegation_${state}`) : (start?.resolution?.label ?? "");
  const result = !active && side === "from" ? (delegation?.resultSummary ?? null) : null;
  const stop = () => {
    setStopping(true);
    void readNativeApi()
      ?.bots.cancelDelegation({ delegationId })
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: t("synbot:stopFailed"),
          description: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setStopping(false));
  };
  const other = side === "from" ? to : from;
  return (
    <article className={tone === "attention" ? "baton baton--attention" : "baton"}>
      <div className="baton__path" aria-hidden>
        <BotFace bot={from} size={FACE} still />
        <svg className="baton__arrow" width="56" height="12" viewBox="0 0 56 12" fill="none">
          <path d="M2 6h46" strokeWidth="1.5" strokeDasharray="3 4" strokeLinecap="round" />
          <path d="m47 2 5 4-5 4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <BotFace bot={to} size={FACE} still />
      </div>
      <div className="baton__body">
        <p className="baton__title">
          {t("synbot:batonTitle", {
            from: from?.name ?? t("synbot:removedBot"),
            to: to?.name ?? t("synbot:removedBot"),
          })}
        </p>
        <p className="baton__brief">
          <InlineText text={brief} />
        </p>
      </div>
      {result ? (
        <p className="baton__result">
          <InlineText text={result} />
        </p>
      ) : null}
      {startOpen && start ? (
        <>
          <p className="baton__status baton__status--attention">
            {t("synbot:delegation_awaiting-start")}
          </p>
          <StartAnswers start={start} />
        </>
      ) : (
        <div className="baton__foot">
          <p className={`baton__status baton__status--${tone}`}>
            {tone === "active" ? (
              <span className="baton__pulse" />
            ) : tone === "good" ? (
              <Icon name="check" size="xs" />
            ) : tone === "bad" ? (
              <Icon name="close" size="xs" />
            ) : null}
            {statusLabel}
          </p>
          <div className="baton__actions">
            {active && side === "from" ? (
              <Button variant="ghost" size="xs" disabled={stopping} onClick={stop}>
                {t("synbot:stop")}
              </Button>
            ) : null}
            {other ? (
              <Button variant="ghost" size="xs" onClick={() => openBot(other)}>
                {t("synbot:openBot", { name: other.name })}
                <Icon name="arrow-right" size="xs" />
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </article>
  );
}
