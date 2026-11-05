// FILE: SynbotCards.tsx
// Purpose: SynBot's cards in a bot's thread, drawn as HoloBot's thread cards: choice cards
//          (suggestions, proposals, Start / Not now, git init) answered through bots.cardAction;
//          the delegation as a task card ("Frontend · On it", its brief, its result, Open and
//          Stop through bots.cancelDelegation); the report that stands in for the requester's
//          wake-up message; and the quiet "From <bot>" line in a chat a bot wrote to. The same
//          cards render in Synara's transcript when a bot thread opens there (SynbotNoticeRow).
// Layer: SynBot thread UI
// Exports: SynbotCard, MessageFromRow, delegationTone

import {
  BOT_DELEGATION_TERMINAL_STATES,
  BotCard,
  BotControlNotice,
  BotDelegationNotice,
  BotReportNotice,
  type Bot,
  type BotDelegationState,
  type ThreadId,
} from "@synara/contracts";
import { Option, Schema } from "effect";
import { useState } from "react";

import { useTranslation } from "~/i18n";
import { readNativeApi } from "~/nativeApi";
import { botById, delegationById } from "~/synbot/synbotState.logic";
import { useSynbotStore } from "~/synbot/synbotStore";
import type { WorkLogSynbotNotice } from "~/workLog";

import { toastManager } from "../../ui/toast";
import { BotFace, botMood } from "../BotFace";
import { CapsuleButton, Chip, IconButton, type Tone } from "../kit/controls";
import { Icon } from "../kit/Icon";
import { useOpenBot } from "../synbotNav";
import { ChatText } from "./ChatText";
import { ChoiceRows, InlineText, Pair, type ChoiceRow } from "./ChoiceParts";

const decodeCard = Schema.decodeUnknownOption(BotCard);
const decodeDelegationNotice = Schema.decodeUnknownOption(BotDelegationNotice);
const decodeReportNotice = Schema.decodeUnknownOption(BotReportNotice);
const decodeControlNotice = Schema.decodeUnknownOption(BotControlNotice);

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A delegation's chip tone. */
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

/** A bot named in a card: its face and name; a click opens its thread. */
function BotName({ bot, size = "card" }: { readonly bot: Bot | null; readonly size?: "card" }) {
  const { t } = useTranslation();
  const openBot = useOpenBot();
  if (!bot) {
    return (
      <span className="mention">
        <BotFace bot={null} size={size} />
        {t("synbot:removedBot")}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="mention"
      title={t("synbot:openBot", { name: bot.name })}
      onClick={(event) => {
        event.stopPropagation();
        openBot(bot);
      }}
    >
      <BotFace bot={bot} size={size} mood={botMood(bot.status)} />
      {bot.name}
    </button>
  );
}

// ── Choice cards ─────────────────────────────────────────────────────

function BotChoiceCard({
  card,
  threadId,
  resolution,
}: {
  readonly card: BotCard;
  readonly threadId: ThreadId | null;
  readonly resolution: WorkLogSynbotNotice["resolution"];
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<string | null>(null);
  const [answered, setAnswered] = useState<{ optionId: string; label: string } | null>(null);
  const chosen = resolution ?? answered;
  const open = chosen === null && threadId !== null;
  const answer = (optionId: string, label: string) => {
    const api = readNativeApi();
    if (!api || !threadId || pending !== null) return;
    setPending(optionId);
    void api.bots
      .cardAction({ threadId, cardId: card.id, optionId })
      .then(() => setAnswered({ optionId, label }))
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: t("synbot:answerFailed"),
          description: messageOf(error),
        }),
      )
      .finally(() => setPending(null));
  };
  const close = card.options.find((option) => option.tone === "dismiss");
  const choices = card.options.filter((option) => option.tone !== "dismiss");
  const rows: ChoiceRow[] = (open ? choices : card.options)
    .filter((option) => open || option.id === chosen?.optionId)
    .map((option) => ({
      id: option.id,
      label: option.label,
      danger: option.tone === "danger",
      primary: option.tone === "primary",
      picked: option.id === chosen?.optionId,
    }));
  const pick = (row: ChoiceRow) => answer(row.id, row.label);
  // Two answers and no ×: two small buttons under the question (HoloBot's pair).
  const pair = open && !close && choices.length === 2;
  return (
    <div className={open ? (pair ? "choice choice--pair" : "choice") : "choice choice--done"}>
      <div className="choice__head">
        <p className="choice__title">
          <InlineText text={card.title} />
        </p>
        {close && open ? (
          <IconButton
            icon="close"
            kind="ghost"
            className="choice__close"
            label={close.label}
            disabled={pending !== null}
            onClick={() => answer(close.id, close.label)}
          />
        ) : null}
      </div>
      {card.body ? (
        <p className="choice__body">
          <InlineText text={card.body} />
        </p>
      ) : null}
      {pair ? (
        <Pair buttons={rows} disabled={pending !== null} onPick={pick} />
      ) : rows.length > 0 ? (
        <ChoiceRows rows={rows} open={open} disabled={pending !== null} onPick={pick} />
      ) : chosen ? (
        <p className="choice__chosen">
          <Icon name="check" size="sm" />
          {chosen.label}
        </p>
      ) : null}
    </div>
  );
}

// ── Delegations ──────────────────────────────────────────────────────

/** In the requester's thread: the work handed to another bot, as a task card. */
function DelegationCard({ notice }: { readonly notice: BotDelegationNotice }) {
  const { t } = useTranslation();
  const openBot = useOpenBot();
  const data = useSynbotStore((store) => store.data);
  const delegation = delegationById(data, notice.delegationId);
  const target = botById(data, notice.toBotId);
  const [stopping, setStopping] = useState(false);
  const state = delegation?.state ?? "sent";
  const active = !BOT_DELEGATION_TERMINAL_STATES.has(state);
  const stop = () => {
    setStopping(true);
    void readNativeApi()
      ?.bots.cancelDelegation({ delegationId: notice.delegationId })
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: t("synbot:stopFailed"),
          description: messageOf(error),
        }),
      )
      .finally(() => setStopping(false));
  };
  const result = delegation?.resultSummary ?? null;
  return (
    <article className="task-card">
      <button
        type="button"
        className="task-card__head"
        title={target ? t("synbot:openBot", { name: target.name }) : undefined}
        disabled={!target}
        onClick={() => target && openBot(target)}
      >
        <BotFace
          bot={target}
          size="card"
          mood={active && state !== "awaiting-start" ? "working" : "idle"}
        />
        <span className="task-card__title">{target?.name ?? t("synbot:removedBot")}</span>
        <Chip tone={delegationTone(state)}>{t(`synbot:delegation_${state}`)}</Chip>
      </button>
      {active && (state === "sent" || state === "working") ? (
        <p className="task-card__live">
          <span className="task-card__pulse" />
          <span className="task-card__text">
            <InlineText text={notice.brief} />
          </span>
        </p>
      ) : (
        <p className="task-card__text">
          <InlineText text={result && !active ? result : notice.brief} />
        </p>
      )}
      <div className="task-card__actions">
        {target ? (
          <CapsuleButton kind="ghost" small onClick={() => openBot(target)}>
            {t("synbot:open")}
            <Icon name="arrow-right" size="xs" />
          </CapsuleButton>
        ) : null}
        {active ? (
          <CapsuleButton kind="ghost" small disabled={stopping} onClick={stop}>
            {t("synbot:stop")}
          </CapsuleButton>
        ) : null}
      </div>
    </article>
  );
}

/** In the target's thread: "Message from <bot>", then the brief as that bot's message. */
export function MessageFromRow({
  delegationId,
  brief,
}: {
  readonly delegationId: string;
  readonly brief: string;
}) {
  const { t } = useTranslation();
  const openBot = useOpenBot();
  const data = useSynbotStore((store) => store.data);
  const delegation = delegationById(data, delegationId);
  const from = delegation ? botById(data, delegation.fromBotId) : null;
  return (
    <div>
      <button
        type="button"
        className="from-line"
        title={t("synbot:openExchange")}
        disabled={!from}
        onClick={() => from && openBot(from)}
      >
        {t("synbot:messageFrom")}
        <BotFace bot={from} size="card" />
        <span className="from-line__name">{from?.name ?? t("synbot:removedBot")}</span>
      </button>
      <div className="row row--bot">
        <div className="bot">
          <div className="bubble bubble--bot">
            <ChatText text={brief} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Reports ──────────────────────────────────────────────────────────

/** The report that woke the requester: each delegation's bot, state and result. Live
 * delegations first; the notice's own copy covers ones that left the snapshot. */
function ReportCard({ notice }: { readonly notice: BotReportNotice }) {
  const { t } = useTranslation();
  const data = useSynbotStore((store) => store.data);
  const delegations = notice.delegationIds.flatMap((id) => {
    const live = delegationById(data, id);
    if (live) {
      return [{ id, toBotId: live.toBotId, state: live.state, resultSummary: live.resultSummary }];
    }
    const kept = notice.entries?.find((entry) => entry.delegationId === id);
    return kept ? [{ id, ...kept }] : [];
  });
  return (
    <article className="task-card">
      <p className="task-card__meta">{t("synbot:reportTitle")}</p>
      {delegations.length === 0 ? (
        <p className="task-card__text">
          {t("synbot:reportCount", { count: notice.delegationIds.length })}
        </p>
      ) : (
        <div className="task-card__entries">
          {delegations.map((delegation) => (
            <div key={delegation.id} className="task-card__entry">
              <div className="task-card__entry-head">
                <BotName bot={botById(data, delegation.toBotId)} />
                <Chip tone={delegationTone(delegation.state)}>
                  {t(`synbot:delegation_${delegation.state}`)}
                </Chip>
              </div>
              {delegation.resultSummary ? (
                <p className="task-card__text">
                  <InlineText text={delegation.resultSummary} />
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

// ── Control lines ────────────────────────────────────────────────────

/** "From <bot>" or "Stopped by <bot>" in a chat a bot wrote to or stopped. */
export function ControlLine({ notice }: { readonly notice: BotControlNotice }) {
  const { t } = useTranslation();
  const bot = useSynbotStore((store) => botById(store.data, notice.botId));
  return (
    <p className="system-line">
      <BotFace bot={bot} size="card" still />
      <span className="system-line__text">
        {notice.action === "interrupt"
          ? t("synbot:controlInterrupted", { name: notice.botName })
          : t("synbot:controlMessage", { name: notice.botName })}
      </span>
    </p>
  );
}

/** One SynBot card for a `synbot.*` work-log entry (activity id in `entryId`). */
export function SynbotCard({
  entryId,
  notice,
  threadId,
}: {
  readonly entryId: string;
  readonly notice: WorkLogSynbotNotice;
  readonly threadId: ThreadId | null;
}) {
  switch (notice.kind) {
    case "synbot.delegation": {
      // The target chat shows the delegation as its "Message from" row instead.
      if (entryId.endsWith(":to")) return null;
      const decoded = decodeDelegationNotice(notice.payload);
      return Option.isSome(decoded) ? <DelegationCard notice={decoded.value} /> : null;
    }
    case "synbot.card": {
      const decoded = decodeCard(notice.payload);
      return Option.isSome(decoded) ? (
        <BotChoiceCard card={decoded.value} threadId={threadId} resolution={notice.resolution} />
      ) : null;
    }
    case "synbot.report": {
      const decoded = decodeReportNotice(notice.payload);
      return Option.isSome(decoded) ? <ReportCard notice={decoded.value} /> : null;
    }
    case "synbot.control": {
      const decoded = decodeControlNotice(notice.payload);
      return Option.isSome(decoded) ? <ControlLine notice={decoded.value} /> : null;
    }
    default:
      return null;
  }
}

/** Card kinds that are a quiet line, not a card in the bot's column. */
export function isLineCard(notice: WorkLogSynbotNotice): boolean {
  return notice.kind === "synbot.control";
}
