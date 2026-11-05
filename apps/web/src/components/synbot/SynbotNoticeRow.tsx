// FILE: SynbotNoticeRow.tsx
// Purpose: SynBot cards inside a bot's transcript (HoloBot's thread cards): the delegation line
//          ("→ Frontend is on it", live state, result, Stop), choice cards with lettered answers
//          (suggestions, proposals, Start / Not now, git init), the report card that stands in for
//          the requester's wake-up message, and the "From <bot>" label in chats a bot wrote to.
//          Also the "Message from <bot>" row that replaces a delegation's prompt in the target chat.
// Layer: SynBot UI (rendered by MessagesTimeline)
// Exports: SynbotNoticeRow, SynbotMessageFromRow, isSynbotDelegationMessageId

import {
  BOT_DELEGATION_MESSAGE_PREFIX,
  BOT_DELEGATION_TERMINAL_STATES,
  BotCard,
  BotDelegationNotice,
  BotReportNotice,
  BotControlNotice,
  type Bot,
  type BotDelegation,
  type ThreadId,
} from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import { useState } from "react";

import { useTranslation } from "~/i18n";
import { readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import { botById, delegationById } from "~/synbot/synbotState.logic";
import { useSynbotStore } from "~/synbot/synbotStore";
import type { WorkLogSynbotNotice } from "~/workLog";

import { Button } from "../ui/button";
import { StatusChip } from "../ui/status-chip";
import { toastManager } from "../ui/toast";
import { BotMascot, botMascotMood } from "./BotMascot";

const decodeCard = Schema.decodeUnknownOption(BotCard);
const decodeDelegationNotice = Schema.decodeUnknownOption(BotDelegationNotice);
const decodeReportNotice = Schema.decodeUnknownOption(BotReportNotice);
const decodeControlNotice = Schema.decodeUnknownOption(BotControlNotice);

export const isSynbotDelegationMessageId = (id: string) =>
  id.startsWith(BOT_DELEGATION_MESSAGE_PREFIX);

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const STATE_TONE: Record<BotDelegation["state"], string> = {
  "awaiting-start": "text-amber-600 dark:text-amber-400",
  sent: "text-sky-600 dark:text-sky-400",
  working: "text-sky-600 dark:text-sky-400",
  waiting: "text-amber-600 dark:text-amber-400",
  completed: "text-emerald-600 dark:text-emerald-400",
  failed: "text-red-600 dark:text-red-400",
  cancelled: "text-muted-foreground",
};

function useOpenBot() {
  const navigate = useNavigate();
  return (bot: Bot) =>
    void navigate({ to: "/synbot", search: bot.kind === "main" ? {} : { bot: bot.id } });
}

function BotChip({ bot }: { readonly bot: Bot | null }) {
  const { t } = useTranslation();
  const openBot = useOpenBot();
  if (!bot) return <span className="text-muted-foreground">{t("synbot:removedBot")}</span>;
  return (
    <button
      type="button"
      onClick={() => openBot(bot)}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-full hover:underline"
    >
      <BotMascot mascot={bot.mascot} size="inline" mood={botMascotMood(bot.status)} seed={bot.id} />
      <span className="truncate font-medium text-foreground">{bot.name}</span>
    </button>
  );
}

function DelegationLine({ notice }: { readonly notice: BotDelegationNotice }) {
  const { t } = useTranslation();
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
  return (
    <div className="flex w-full flex-col gap-1 rounded-xl border border-border/60 bg-card px-3 py-2 text-ui-sm">
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="text-muted-foreground">
          →
        </span>
        <BotChip bot={target} />
        <StatusChip className={STATE_TONE[state]} pulse={state === "working" || state === "sent"}>
          {t(`synbot:delegation_${state}`)}
        </StatusChip>
        {active ? (
          <Button size="xs" variant="ghost" className="ml-auto" disabled={stopping} onClick={stop}>
            {t("synbot:stop")}
          </Button>
        ) : null}
      </div>
      <p className="line-clamp-2 text-muted-foreground">{notice.brief}</p>
      {delegation?.resultSummary && !active ? (
        <p className="whitespace-pre-wrap text-foreground/85">{delegation.resultSummary}</p>
      ) : null}
    </div>
  );
}

const LETTERS = "ABCDEFGH";

function ChoiceCard({
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
  const answer = (optionId: string, label: string) => {
    const api = readNativeApi();
    if (!api || !threadId) return;
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
  const choices = card.options.filter((option) => option.tone !== "dismiss");
  const dismiss = card.options.find((option) => option.tone === "dismiss");
  return (
    <div
      className={cn(
        "flex w-full max-w-xl flex-col gap-1.5 rounded-xl border border-border/60 bg-card px-3 py-2.5",
        chosen && "opacity-70",
      )}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-ui font-medium text-foreground">{card.title}</span>
        {dismiss && !chosen ? (
          <button
            type="button"
            aria-label={dismiss.label}
            title={dismiss.label}
            disabled={pending !== null}
            onClick={() => answer(dismiss.id, dismiss.label)}
            className="rounded-full px-1.5 text-ui text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            ×
          </button>
        ) : null}
      </div>
      {card.body ? <p className="text-ui-sm text-muted-foreground">{card.body}</p> : null}
      {chosen ? (
        <span className="text-ui-sm text-muted-foreground">
          {t("synbot:answered", { label: chosen.label })}
        </span>
      ) : (
        <div className="flex flex-col gap-1">
          {choices.map((option, index) => (
            <button
              key={option.id}
              type="button"
              disabled={pending !== null}
              onClick={() => answer(option.id, option.label)}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui hover:bg-accent/60 disabled:opacity-60",
                option.tone === "danger" && "text-red-600 dark:text-red-400",
                option.tone === "primary" && "font-medium",
              )}
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-ui-xs text-foreground/80">
                {LETTERS[index] ?? "•"}
              </span>
              <span className="min-w-0 truncate">{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ReportCard({ notice }: { readonly notice: BotReportNotice }) {
  const { t } = useTranslation();
  const data = useSynbotStore((store) => store.data);
  const delegations = notice.delegationIds
    .map((id) => delegationById(data, id))
    .filter((delegation): delegation is BotDelegation => delegation !== null);
  return (
    <div className="flex w-full flex-col gap-1.5 rounded-xl border border-border/60 bg-card px-3 py-2 text-ui-sm">
      <span className="text-ui-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("synbot:reportTitle")}
      </span>
      {delegations.length === 0 ? (
        <span className="text-muted-foreground">
          {t("synbot:reportCount", { count: notice.delegationIds.length })}
        </span>
      ) : (
        delegations.map((delegation) => (
          <div key={delegation.id} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <BotChip bot={botById(data, delegation.toBotId)} />
              <StatusChip className={STATE_TONE[delegation.state]}>
                {t(`synbot:delegation_${delegation.state}`)}
              </StatusChip>
            </div>
            {delegation.resultSummary ? (
              <p className="line-clamp-4 whitespace-pre-wrap text-foreground/85">
                {delegation.resultSummary}
              </p>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}

function ControlLabel({ notice }: { readonly notice: BotControlNotice }) {
  const { t } = useTranslation();
  const bot = useSynbotStore((store) => botById(store.data, notice.botId));
  return (
    <div className="flex items-center gap-1.5 text-ui-sm text-muted-foreground">
      {bot ? <BotMascot mascot={bot.mascot} size="inline" still /> : null}
      <span>
        {notice.action === "interrupt"
          ? t("synbot:controlInterrupted", { name: notice.botName })
          : t("synbot:controlMessage", { name: notice.botName })}
      </span>
    </div>
  );
}

/** One SynBot card for a `synbot.*` work-log entry (activity id in `entryId`). */
export function SynbotNoticeRow({
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
      return Option.isSome(decoded) ? <DelegationLine notice={decoded.value} /> : null;
    }
    case "synbot.card": {
      const decoded = decodeCard(notice.payload);
      return Option.isSome(decoded) ? (
        <ChoiceCard card={decoded.value} threadId={threadId} resolution={notice.resolution} />
      ) : null;
    }
    case "synbot.report": {
      const decoded = decodeReportNotice(notice.payload);
      return Option.isSome(decoded) ? <ReportCard notice={decoded.value} /> : null;
    }
    case "synbot.control": {
      const decoded = decodeControlNotice(notice.payload);
      return Option.isSome(decoded) ? <ControlLabel notice={decoded.value} /> : null;
    }
    default:
      return null;
  }
}

/** Replaces a delegation's long prompt in the target bot's chat with who asked and the brief. */
export function SynbotMessageFromRow({ messageId }: { readonly messageId: string }) {
  const { t } = useTranslation();
  const data = useSynbotStore((store) => store.data);
  const delegation = data.delegations.find(
    (entry) => entry.id === messageId.slice(BOT_DELEGATION_MESSAGE_PREFIX.length),
  );
  const from = delegation ? botById(data, delegation.fromBotId) : null;
  return (
    <div className="flex w-full flex-col gap-1 py-1 text-ui-sm">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <span>{t("synbot:messageFrom")}</span>
        <BotChip bot={from} />
      </div>
      {delegation ? (
        <p className="whitespace-pre-wrap text-ui text-foreground">{delegation.brief}</p>
      ) : null}
    </div>
  );
}
