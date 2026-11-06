// FILE: SynbotCards.tsx
// Purpose: SynBot's cards in a bot's thread: choice cards (suggestions, proposals, Start / Not
//          now, git init) answered through bots.cardAction; a hand-off as a baton card in both
//          bots' threads (BatonCard); the report that stands in for the requester's wake-up
//          message, as a timeline of its hand-offs; and the quiet "From <bot>" line in a chat a
//          bot wrote to. The same cards render in Synara's transcript when a bot thread opens
//          there (SynbotNoticeRow).
// Layer: SynBot thread UI
// Exports: SynbotCard, MessageFromRow, delegationStartCard, delegationTone, isLineCard

import {
  BOT_DELEGATION_TERMINAL_STATES,
  BotCard,
  BotControlNotice,
  BotDelegationNotice,
  BotReportNotice,
  type BotDelegationState,
  type ProjectId,
  type ThreadId,
} from "@synara/contracts";
import { Option, Schema } from "effect";

import { useTranslation } from "~/i18n";
import { formatRelativeTimeAgo } from "~/lib/relativeTime";
import { botById, delegationById } from "~/synbot/synbotState.logic";
import { useSynbotStore } from "~/synbot/synbotStore";
import type { WorkLogSynbotNotice } from "~/workLog";

import { BotFace, delegationMood } from "../BotFace";
import { IconButton } from "../kit/controls";
import { Icon } from "../kit/Icon";
import { useOpenBot } from "../synbotNav";
import { BatonCard, delegationTone, type BatonStart } from "./BatonCard";
import { CARD_FACE, CardHead, StatusChip } from "./CardParts";
import { ChoiceRows, InlineText, Pair, type ChoiceRow } from "./ChoiceParts";
import { useCardAnswer } from "./useCardAnswer";

const decodeCard = Schema.decodeUnknownOption(BotCard);
const decodeDelegationNotice = Schema.decodeUnknownOption(BotDelegationNotice);
const decodeReportNotice = Schema.decodeUnknownOption(BotReportNotice);
const decodeControlNotice = Schema.decodeUnknownOption(BotControlNotice);

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
  const { pending, answered, answer } = useCardAnswer(card, threadId);
  const chosen = resolution ?? answered;
  const open = chosen === null && threadId !== null;
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

/**
 * In the target's thread (and in Synara's transcript): the hand-off another bot sent, as a
 * baton. `start` is the delegation's start card when the thread shows it here instead.
 */
export function MessageFromRow({
  delegationId,
  brief,
  start,
}: {
  readonly delegationId: string;
  readonly brief: string;
  readonly start?: BatonStart | null;
}) {
  return (
    <div className="row row--group row--bot">
      <BatonCard delegationId={delegationId} brief={brief} side="to" start={start ?? null} />
    </div>
  );
}

/** A delegation's start card on its own (no hand-off message yet): the hand-off's baton, its
 * brief from the live delegation (the card's own text once the delegation is gone). */
function StartBaton({
  card,
  delegationId,
  threadId,
  resolution,
}: {
  readonly card: BotCard;
  readonly delegationId: string;
  readonly threadId: ThreadId | null;
  readonly resolution: WorkLogSynbotNotice["resolution"];
}) {
  const brief = useSynbotStore(
    (store) => delegationById(store.data, delegationId)?.brief ?? card.body ?? card.title,
  );
  return (
    <BatonCard
      delegationId={delegationId}
      toBotId={card.botId}
      brief={brief}
      side="to"
      start={{ card, threadId, resolution }}
    />
  );
}

/** A `synbot.card` that is a delegation's Start / Not now, with the delegation it belongs to. */
export function delegationStartCard(notice: WorkLogSynbotNotice): BotCard | null {
  if (notice.kind !== "synbot.card") return null;
  const decoded = decodeCard(notice.payload);
  if (Option.isNone(decoded)) return null;
  const card = decoded.value;
  return card.kind === "delegation-start" && card.delegationId ? card : null;
}

// ── Reports ──────────────────────────────────────────────────────────

/** One hand-off in a report: who asked (unknown once it left the snapshot), who did it, how it
 * ended and its result. */
interface ReportLine {
  readonly id: string;
  readonly fromBotId: ProjectId | null;
  readonly toBotId: ProjectId;
  readonly state: BotDelegationState;
  readonly resultSummary: string | null;
}

/** How a report's hand-offs ended: all done, some failed, or some still going. */
function reportOutcome(states: readonly BotDelegationState[]): "done" | "failed" | "going" {
  if (states.some((state) => !BOT_DELEGATION_TERMINAL_STATES.has(state))) return "going";
  return states.some((state) => state === "failed") ? "failed" : "done";
}

/** The report that woke the requester: a head (the asking bot, "Report · 2 delegations", when,
 * and the outcome), then a timeline of each hand-off's bot, how it ended and its result, then
 * the outcome. Live delegations first; the notice's own copy covers ones that left the
 * snapshot. */
function ReportCard({ notice }: { readonly notice: BotReportNotice }) {
  const { t } = useTranslation();
  const openBot = useOpenBot();
  const data = useSynbotStore((store) => store.data);
  const delegations = notice.delegationIds.flatMap((id): ReportLine[] => {
    const live = delegationById(data, id);
    if (live) {
      return [
        {
          id,
          fromBotId: live.fromBotId,
          toBotId: live.toBotId,
          state: live.state,
          resultSummary: live.resultSummary,
        },
      ];
    }
    const kept = notice.entries?.find((entry) => entry.delegationId === id);
    return kept
      ? [
          {
            id,
            fromBotId: null,
            toBotId: kept.toBotId,
            state: kept.state,
            resultSummary: kept.resultSummary,
          },
        ]
      : [];
  });
  const outcome = reportOutcome(delegations.map((delegation) => delegation.state));
  const failed = delegations.filter((delegation) => delegation.state === "failed").length;
  const asker = botById(
    data,
    delegations.find((delegation) => delegation.fromBotId)?.fromBotId ?? null,
  );
  const outcomeLabel =
    outcome === "done"
      ? t("synbot:reportAllDone")
      : outcome === "failed"
        ? t("synbot:reportFailed", { count: failed })
        : t("synbot:reportGoing");
  return (
    <article className="report">
      <CardHead
        faces={<BotFace bot={asker} size={CARD_FACE} mood="idle" />}
        title={t("synbot:reportHandoffs", { count: notice.delegationIds.length })}
        sub={formatRelativeTimeAgo(notice.createdAt)}
        status={
          <StatusChip
            tone={outcome === "done" ? "good" : outcome === "failed" ? "bad" : "active"}
            label={outcomeLabel}
          />
        }
      />
      <ol className="timeline">
        {delegations.map((delegation) => {
          const bot = botById(data, delegation.toBotId);
          return (
            <li key={delegation.id} className="timeline__item">
              <span className="timeline__rail" aria-hidden>
                <BotFace bot={bot} size={22} mood={delegationMood(delegation.state)} />
                <span className="timeline__line" />
              </span>
              <div className="timeline__body">
                <p className="timeline__head">
                  {bot ? (
                    <button
                      type="button"
                      className="timeline__name"
                      title={t("synbot:openBot", { name: bot.name })}
                      onClick={() => openBot(bot)}
                    >
                      {bot.name}
                    </button>
                  ) : (
                    <span>{t("synbot:removedBot")}</span>
                  )}
                  <span
                    className={`timeline__state timeline__state--${delegationTone(delegation.state)}`}
                  >
                    {t(`synbot:delegation_${delegation.state}`)}
                  </span>
                </p>
                {delegation.resultSummary ? (
                  <p className="timeline__text">
                    <InlineText text={delegation.resultSummary} />
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
        <li className="timeline__item timeline__item--end">
          <span className="timeline__rail" aria-hidden>
            <span className={`timeline__outcome timeline__outcome--${outcome}`}>
              {outcome === "going" ? null : (
                <Icon name={outcome === "done" ? "check" : "close"} size="xs" />
              )}
            </span>
          </span>
          <div className="timeline__body">
            <p className="timeline__head timeline__head--end">{outcomeLabel}</p>
          </div>
        </li>
      </ol>
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
      return Option.isSome(decoded) ? (
        <BatonCard
          delegationId={decoded.value.delegationId}
          fromBotId={decoded.value.fromBotId}
          toBotId={decoded.value.toBotId}
          brief={decoded.value.brief}
          side="from"
        />
      ) : null;
    }
    case "synbot.card": {
      const decoded = decodeCard(notice.payload);
      if (Option.isNone(decoded)) return null;
      const card = decoded.value;
      // A hand-off waiting for its Start reaches the receiving bot as this card alone: it is
      // drawn as that hand-off's baton, with Start / Not now on it.
      if (card.kind === "delegation-start" && card.delegationId) {
        return (
          <StartBaton
            card={card}
            delegationId={card.delegationId}
            threadId={threadId}
            resolution={notice.resolution}
          />
        );
      }
      return <BotChoiceCard card={card} threadId={threadId} resolution={notice.resolution} />;
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
