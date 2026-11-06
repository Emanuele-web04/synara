// FILE: MessageList.tsx
// Purpose: The bot thread's rows in its transcript (HoloBot's thread/MessageList.tsx,
//          MessageRow.tsx and Typing.tsx): date separators, the user's bubble on the right in
//          the bot's color (gray in SynBot's own thread), the bot's gray bubbles on the left
//          (no face or name: it is the bot you are talking to), SynBot cards,
//          task cards, hand-offs as baton cards (their Start / Not now on the baton), quiet
//          system lines; at the end the
//          pending approval and question cards (ChatView's own pending interactions), then the
//          typing row (three dots and what the bot is doing) while it answers. The newest open
//          ask takes the A, B, C… keys. ChatView draws this in its transcript's place, under
//          Synara's own composer.
// Layer: SynBot thread UI
// Exports: MessageList

import { ThreadId, type Bot } from "@synara/contracts";
import { memo, useMemo, type CSSProperties } from "react";

import { useAppSettings } from "~/appSettings";
import { useTranslation } from "~/i18n";
import type { BotThreadRow } from "~/synbot/botThread.logic";
import { formatDayAwareTimestamp } from "~/timestampFormat";
import type { ChatAttachment, ChatMessage } from "~/types";

import { BotFace } from "../BotFace";
import { Text } from "../kit/controls";
import { useOpenTask } from "../synbotNav";
import { CardFocus } from "./cardKeys";
import { ChatText } from "./ChatText";
import { ApprovalCard, QuestionCard } from "./PendingCards";
import type { BatonStart } from "./BatonCard";
import { MessageFromRow, SynbotCard, delegationStartCard, isLineCard } from "./SynbotCards";
import { TaskCard } from "./TaskCard";
import { Transcript, type TranscriptEdges } from "./Transcript";
import { useBotThread, type BotThread } from "./useBotThread";
import type { ChatTranscriptSlotInput } from "../../chat/chatTranscriptSlot";

function imagesOf(message: ChatMessage): readonly ChatAttachment[] {
  return (message.attachments ?? []).filter(
    (attachment) => attachment.type === "image" && attachment.previewUrl,
  );
}

/** The user's words: a bubble of the bot's color, gray in SynBot's thread; images above it. */
function UserBubble({
  message,
  tint,
}: {
  readonly message: ChatMessage;
  readonly tint: string | null;
}) {
  const images = imagesOf(message);
  const style = tint ? ({ ["--bubble-tint" as string]: tint } as CSSProperties) : undefined;
  const bubble = message.text.trim() ? (
    <div
      className={tint ? "bubble bubble--user bubble--tinted" : "bubble bubble--user"}
      style={style}
    >
      <ChatText text={message.text} tone="user" />
    </div>
  ) : null;
  if (images.length === 0) return bubble;
  return (
    <div className="user-stack">
      <div className="message-images">
        {images.map((image) =>
          image.type === "image" && image.previewUrl ? (
            <img key={image.id} className="message-image" src={image.previewUrl} alt={image.name} />
          ) : null,
        )}
      </div>
      {bubble}
    </div>
  );
}

const Row = memo(function Row({
  row,
  bot,
  thread,
  tint,
  start,
}: {
  readonly row: BotThreadRow;
  readonly bot: Bot;
  readonly thread: BotThread["threadId"];
  readonly tint: string | null;
  readonly start: BatonStart | null;
}) {
  const { settings } = useAppSettings();
  const openTask = useOpenTask();
  switch (row.kind) {
    case "separator":
      return (
        <div className="separator" role="separator">
          {formatDayAwareTimestamp(row.at, settings.timestampFormat)}
        </div>
      );
    case "system": {
      const target = row.entry.synaraWorkerNotice?.threads[0];
      return (
        <p className="system-line">
          {target ? (
            <button type="button" onClick={() => openTask(ThreadId.makeUnsafe(target.threadId))}>
              {row.entry.label}
            </button>
          ) : (
            <span className="system-line__text">{row.entry.label}</span>
          )}
        </p>
      );
    }
    case "from":
      return <MessageFromRow delegationId={row.delegationId} brief={row.brief} start={start} />;
    case "card":
      return isLineCard(row.notice) ? (
        <SynbotCard entryId={row.entryId} notice={row.notice} threadId={thread} />
      ) : (
        <div className="row row--group row--bot">
          <div className="bot bot--card">
            <SynbotCard entryId={row.entryId} notice={row.notice} threadId={thread} />
          </div>
        </div>
      );
    case "task":
      return (
        <div className="row row--group row--bot">
          <TaskCard task={row.task} bot={bot} />
        </div>
      );
    case "message": {
      const spacing = row.groupStart ? "row row--group" : "row";
      if (row.message.role === "user") {
        return (
          <div className={`${spacing} row--user`} data-message={row.message.id}>
            <UserBubble message={row.message} tint={tint} />
          </div>
        );
      }
      return (
        <div className={`${spacing} row--bot`} data-message={row.message.id}>
          <div className="bot">
            <div className="bubble bubble--bot">
              <ChatText
                text={row.message.text}
                threadId={thread}
                streaming={row.message.streaming}
              />
            </div>
          </div>
        </div>
      );
    }
  }
});

/** While the bot answers: a bubble of three dots and, under it, its face at work and what it
 * is doing ("Thinking" until the first step). */
function Typing({ bot, step }: { readonly bot: Bot; readonly step: string | null }) {
  const { t } = useTranslation();
  const doing = step ?? t("synbot:thinking");
  return (
    <div className="row row--group row--bot typing" role="status" aria-label={doing}>
      <div className="typing__body">
        <div className="typing__bubble" aria-hidden>
          <span className="typing__dot" />
          <span className="typing__dot" />
          <span className="typing__dot" />
        </div>
        <p className="typing__step">
          <BotFace bot={bot} size={14} mood="working" />
          <span className="typing__doing">{doing}</span>
        </p>
      </div>
    </div>
  );
}

function FirstUse({ bot }: { readonly bot: Bot }) {
  const { t } = useTranslation();
  return (
    <div className="first-use">
      <BotFace bot={bot} size={72} mood="idle" />
      <Text variant="title" as="h1">
        {bot.name}
      </Text>
      <Text variant="small" tone="muted">
        {bot.kind === "main" ? t("synbot:firstUseMain") : bot.role || t("synbot:firstUseBot")}
      </Text>
    </div>
  );
}

/**
 * Each hand-off's Start card, drawn on the hand-off's baton (so the brief shows once) and
 * hidden as its own card.
 */
function threadShape(rows: readonly BotThreadRow[], threadId: BotThread["threadId"]) {
  const fromIds = new Set<string>();
  for (const row of rows) {
    if (row.kind === "from") fromIds.add(row.delegationId);
  }
  const starts = new Map<string, BatonStart & { readonly key: string }>();
  const mergedCardKeys = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "card") continue;
    const card = delegationStartCard(row.notice);
    if (!card?.delegationId || !fromIds.has(card.delegationId)) continue;
    starts.set(card.delegationId, {
      key: row.key,
      card,
      threadId,
      resolution: row.notice.resolution,
    });
    mergedCardKeys.add(row.key);
  }
  return { starts, mergedCardKeys };
}

/** The user's newest message (not a bot's delegation): a new one is a send. */
function newestUserMessageId(rows: readonly BotThreadRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === "message" && row.message.role === "user") return row.message.id;
  }
  return null;
}

/** Drawn by ChatView in its transcript's place: the composer above them is Synara's own. */
export function MessageList({
  bot,
  slot,
  onEdges,
}: {
  readonly bot: Bot;
  readonly slot: ChatTranscriptSlotInput;
  readonly onEdges: (edges: TranscriptEdges) => void;
}) {
  const { rows, answering, step, threadId } = useBotThread(bot);
  // The user's bubbles take the bot's color; SynBot's own thread keeps the app's gray.
  const tint = bot.kind === "main" ? null : bot.mascot.color;
  const approvals = slot.pendingApprovals;
  const asking = slot.pendingUserInput.input !== null;
  const { starts, mergedCardKeys } = useMemo(() => threadShape(rows, threadId), [rows, threadId]);
  // The newest open ask takes the letter keys: a pending question, else the first approval.
  const focusApproval = !asking && approvals.length > 0;
  // Else the newest unanswered SynBot choice card (a Start drawn on its baton counts).
  const focusCardKey =
    focusApproval || asking
      ? null
      : (rows.findLast(
          (row) =>
            row.kind === "card" && row.notice.kind === "synbot.card" && !row.notice.resolution,
        )?.key ?? null);
  return (
    <Transcript
      opens={threadId}
      watch={[rows, answering, step, approvals, asking]}
      followKey={newestUserMessageId(rows)}
      bottomInsetPx={slot.contentInsetBottomPx}
      onEdges={onEdges}
    >
      {rows.length === 0 && !answering ? <FirstUse bot={bot} /> : null}
      {rows.map((row) => {
        if (mergedCardKeys.has(row.key)) return null;
        const start = row.kind === "from" ? (starts.get(row.delegationId) ?? null) : null;
        const focused = row.key === focusCardKey || (start !== null && start.key === focusCardKey);
        return (
          <CardFocus.Provider key={row.key} value={focused}>
            <Row row={row} bot={bot} thread={threadId} tint={tint} start={start} />
          </CardFocus.Provider>
        );
      })}
      {approvals.map((approval, index) => (
        <CardFocus.Provider key={approval.requestId} value={focusApproval && index === 0}>
          <div className="row row--group row--bot">
            <div className="bot bot--card">
              <ApprovalCard approval={approval} pending={slot} />
            </div>
          </div>
        </CardFocus.Provider>
      ))}
      {asking ? (
        <CardFocus.Provider value>
          <div className="row row--group row--bot">
            <div className="bot bot--card">
              <QuestionCard pending={slot.pendingUserInput} />
            </div>
          </div>
        </CardFocus.Provider>
      ) : null}
      {answering && approvals.length === 0 && !asking ? <Typing bot={bot} step={step} /> : null}
    </Transcript>
  );
}
