// FILE: BatonCard.tsx
// Purpose: A hand-off between two bots, "passing the baton": the head (the asking bot's face,
//          a dashed arrow, the receiving bot's face, "SynBot → QA", when, and where it stands),
//          the brief, the engine the receiving bot works on, then small capsules at the foot.
//          In the asking bot's thread it carries Stop and Open (and the result once done); in
//          the receiving bot's thread it carries the Start / Not now answer of the delegation's
//          start card, so the brief shows once. Once done it folds to one line (the chevron
//          opens it again). Left-aligned like the bot's bubbles.
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

import { useTranslation } from "~/i18n";
import { formatRelativeTimeAgo } from "~/lib/relativeTime";
import { readNativeApi } from "~/nativeApi";
import { botById, delegationById } from "~/synbot/synbotState.logic";
import { useSynbotStore } from "~/synbot/synbotStore";
import type { WorkLogSynbotNotice } from "~/workLog";

import { toastManager } from "../../ui/toast";
import { delegationMood } from "../BotFace";
import { CapsuleButton, type Tone } from "../kit/controls";
import { Icon } from "../kit/Icon";
import { useOpenBot } from "../synbotNav";
import { CardHead, FacePath, FoldToggle, ModelChip, StatusChip } from "./CardParts";
import { useLetterKeys } from "./cardKeys";
import { InlineText } from "./ChoiceParts";
import { useCardAnswer } from "./useCardAnswer";

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

/** Not now, then Start: the start card's answers as small capsules at the card's foot (Start
 * in the liquid-metal ring), A / B from the keyboard. */
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
      <p className="baton__answered">
        <Icon name="check" size="xs" />
        {answered.label}
      </p>
    );
  }
  return (
    <div className="baton__foot baton__foot--answers">
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
  const [unfolded, setUnfolded] = useState(false);
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
  const title = t("synbot:batonTitle", {
    from: from?.name ?? t("synbot:removedBot"),
    to: to?.name ?? t("synbot:removedBot"),
  });
  const when = delegation ? formatRelativeTimeAgo(delegation.createdAt) : null;
  const faces = <FacePath from={from} to={to} toMood={state ? delegationMood(state) : "idle"} />;
  const status = statusLabel ? <StatusChip tone={tone} label={statusLabel} /> : null;
  // Done: one line, its chevron opens the rest.
  if (state === "completed" && !unfolded) {
    return (
      <article className="baton baton--folded">
        <CardHead faces={faces} title={title} sub={when} status={status} />
        <FoldToggle open={false} onToggle={() => setUnfolded(true)} />
      </article>
    );
  }
  const engine = to ? (to.taskModelSelection ?? to.modelSelection) : null;
  return (
    <article className="baton">
      <div className="baton__top">
        <CardHead faces={faces} title={title} sub={when} status={status} />
        {state === "completed" ? <FoldToggle open onToggle={() => setUnfolded(false)} /> : null}
      </div>
      <p className="baton__brief">
        <InlineText text={brief} />
      </p>
      {result ? (
        <p className="baton__result">
          <InlineText text={result} />
        </p>
      ) : null}
      {engine ? (
        <div className="card-chips">
          <ModelChip selection={engine} />
        </div>
      ) : null}
      {startOpen && start ? (
        <StartAnswers start={start} />
      ) : (active && side === "from") || other ? (
        <div className="baton__foot">
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
      ) : null}
    </article>
  );
}
