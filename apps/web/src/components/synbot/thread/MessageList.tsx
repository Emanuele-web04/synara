// FILE: MessageList.tsx
// Purpose: The bot thread's rows in its transcript (HoloBot's thread/MessageList.tsx,
//          MessageRow.tsx and Typing.tsx): date separators, the user's bubble on the right in
//          the bot's color (gray in SynBot's own thread) with its images (they open in the
//          chat's image viewer), the bot's gray bubbles on the left (no face or name: it is the
//          bot you are talking to; Copy shows on hover), SynBot cards, task cards, hand-offs as
//          baton cards (their Start / Not now on the baton), worker notices as in Synara's own
//          transcript, failed turns with Continue; at the end the pending approval and question
//          cards (ChatView's own pending interactions), then the typing row (three dots and what
//          the bot is doing) while it answers. The thread's error shows under the top strip
//          (`bannerTarget`). Until the thread's history has loaded, an empty thread shows the
//          loading state, not the first-use intro. ChatView draws this in its transcript's
//          place, under Synara's own composer.
// Layer: SynBot thread UI
// Exports: MessageList

import type { Bot, TurnId } from "@synara/contracts";
import { memo, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { useAppSettings } from "~/appSettings";
import { useTranslation } from "~/i18n";
import { getAppTypographyScale } from "~/lib/appTypography";
import type { BotThreadRow } from "~/synbot/botThread.logic";
import { formatDayAwareTimestamp } from "~/timestampFormat";
import type { ChatAttachment, ChatMessage } from "~/types";

import { BotFace } from "../BotFace";
import { Text } from "../kit/controls";
import { useOpenTask } from "../synbotNav";
import { ChatText } from "./ChatText";
import { ApprovalCard, QuestionCard } from "./PendingCards";
import type { BatonStart } from "./BatonCard";
import { MessageFromRow, SynbotCard, delegationStartCard, isLineCard } from "./SynbotCards";
import { TaskCard } from "./TaskCard";
import { Transcript, type TranscriptEdges } from "./Transcript";
import { useBotThread, type BotThread } from "./useBotThread";
import type { ChatTranscriptSlotInput } from "../../chat/chatTranscriptSlot";
import {
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "../../chat/ExpandedImagePreview";
import { MessageCopyButton } from "../../chat/MessageCopyButton";
import { ThreadDetailHydrationState } from "../../chat/ThreadDetailHydrationState";
import { ThreadErrorBanner } from "../../chat/ThreadErrorBanner";
import { UsageLimitPauseDivider } from "../../chat/UsageLimitPauseDivider";
import { UserMessageCollapsibleText } from "../../chat/UserMessageCollapsibleText";
import { WorkerMonitorNoticePill } from "../../chat/WorkerMonitorNoticePill";

type ImageAttachment = Extract<ChatAttachment, { type: "image" }>;

function imagesOf(message: ChatMessage): readonly ImageAttachment[] {
  return (message.attachments ?? []).filter(
    (attachment): attachment is ImageAttachment =>
      attachment.type === "image" && Boolean(attachment.previewUrl),
  );
}

/** The user's words: a bubble of the bot's color, gray in SynBot's thread; images above it,
 * each opening the chat's image viewer. */
function UserBubble({
  message,
  tint,
  onExpandImage,
}: {
  readonly message: ChatMessage;
  readonly tint: string | null;
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
}) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const [expanded, setExpanded] = useState(false);
  const images = imagesOf(message);
  const style = tint ? ({ ["--bubble-tint" as string]: tint } as CSSProperties) : undefined;
  // thread.css sets the bubble's text at --hb-text-chat (chat size + 1px) on a 1.43 leading.
  const lineHeightPx = (getAppTypographyScale(settings.chatFontSizePx).chatPx + 1) * 1.43;
  const bubble = message.text.trim() ? (
    <div
      className={tint ? "bubble bubble--user bubble--tinted" : "bubble bubble--user"}
      style={style}
    >
      {/* A long message folds to twelve lines with Show more, as in every Synara chat. */}
      <UserMessageCollapsibleText
        text={message.text}
        expanded={expanded}
        lineHeightPx={lineHeightPx}
        toggleClassName="bubble__more"
        onToggle={() => setExpanded((value) => !value)}
      >
        <ChatText text={message.text} tone="user" />
      </UserMessageCollapsibleText>
    </div>
  ) : null;
  if (images.length === 0) return bubble;
  return (
    <div className="user-stack">
      <div className="message-images" data-count={images.length > 1 ? "many" : "one"}>
        {images.map((image) => (
          <button
            key={image.id}
            type="button"
            className="message-image"
            aria-label={t("chat:preview", { value0: image.name })}
            title={image.name}
            onClick={() => {
              const preview = buildExpandedImagePreview(images, image.id);
              if (preview) onExpandImage(preview);
            }}
          >
            <img src={image.previewUrl} alt={image.name} />
          </button>
        ))}
      </div>
      {bubble}
    </div>
  );
}

/** What a failed turn's row can do: Continue the latest one, change the model first. */
interface Recovery {
  readonly recoverableTurnId: TurnId | null;
  readonly disabled: boolean;
  readonly onContinue: (turnId: TurnId) => Promise<boolean>;
  readonly onChangeModel: () => void;
}

const Row = memo(function Row({
  row,
  bot,
  thread,
  tint,
  start,
  recovery,
  onExpandImage,
}: {
  readonly row: BotThreadRow;
  readonly bot: Bot;
  readonly thread: BotThread["threadId"];
  readonly tint: string | null;
  readonly start: BatonStart | null;
  readonly recovery: Recovery;
  readonly onExpandImage: (preview: ExpandedImagePreview) => void;
}) {
  const { t } = useTranslation();
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
      const notice = row.entry.synaraWorkerNotice;
      if (!notice) return null;
      // As in Synara's own coordinator transcript: each worker linked (it opens in the task
      // pane here), its outcome, and Retry / Stop / Open when it needs you.
      return (
        <div className="row row--group row--bot">
          <div className="bubble bubble--bot worker-note">
            <WorkerMonitorNoticePill entry={row.entry} notice={notice} onOpenThread={openTask} />
          </div>
        </div>
      );
    }
    case "failure": {
      const failure = row.entry.turnFailure;
      if (!failure) return null;
      const turnId = row.entry.turnId ?? null;
      const recoverable = turnId !== null && turnId === recovery.recoverableTurnId;
      return (
        <div className="row row--group failure-row">
          {failure.usageLimit ? (
            <UsageLimitPauseDivider
              provider={failure.provider}
              createdAt={row.entry.createdAt}
              cause={failure.cause}
              timestampFormat={settings.timestampFormat}
              onContinue={recoverable ? () => void recovery.onContinue(turnId) : undefined}
              continueDisabled={recovery.disabled}
            />
          ) : (
            <ThreadErrorBanner
              title={t("chat:taskInterrupted")}
              error={failure.message}
              {...(recoverable
                ? {
                    onContinue: () => void recovery.onContinue(turnId),
                    onChangeModel: recovery.onChangeModel,
                  }
                : {})}
              recoveryDisabled={recovery.disabled}
            />
          )}
        </div>
      );
    }
    case "from":
      return (
        <MessageFromRow
          delegationId={row.delegationId}
          brief={row.brief}
          createdAt={row.at}
          start={start}
        />
      );
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
            <UserBubble message={row.message} tint={tint} onExpandImage={onExpandImage} />
          </div>
        );
      }
      const settled = !row.message.streaming && row.message.text.trim().length > 0;
      return (
        <div className={`${spacing} row--bot`} data-message={row.message.id}>
          <div className="bot bot--reply">
            <div className="bubble bubble--bot">
              <ChatText
                text={row.message.text}
                threadId={thread}
                streaming={row.message.streaming}
              />
            </div>
            {settled ? (
              <div className="bot__actions">
                <MessageCopyButton text={row.message.text} />
              </div>
            ) : null}
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
  const starts = new Map<string, BatonStart>();
  const mergedCardKeys = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "card") continue;
    const card = delegationStartCard(row.notice);
    if (!card?.delegationId || !fromIds.has(card.delegationId)) continue;
    starts.set(card.delegationId, { card, threadId, resolution: row.notice.resolution });
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
  bannerTarget,
  onEdges,
}: {
  readonly bot: Bot;
  readonly slot: ChatTranscriptSlotInput;
  /** Where the thread's error banner goes (under the pane's top strip). */
  readonly bannerTarget: HTMLElement | null;
  readonly onEdges: (edges: TranscriptEdges) => void;
}) {
  const { rows, answering, step, threadId } = useBotThread(bot);
  // The user's bubbles take the bot's color; SynBot's own thread keeps the app's gray.
  const tint = bot.kind === "main" ? null : bot.mascot.color;
  const approval = slot.pendingApprovals[0] ?? null;
  const asking = slot.pendingUserInput.input !== null;
  const { starts, mergedCardKeys } = useMemo(() => threadShape(rows, threadId), [rows, threadId]);
  const { recoverableTurnId, turnRecoveryDisabled, onContinueFailedTurn, onChangeRecoveryModel } =
    slot;
  const recovery = useMemo<Recovery>(
    () => ({
      recoverableTurnId,
      disabled: turnRecoveryDisabled,
      onContinue: onContinueFailedTurn,
      onChangeModel: onChangeRecoveryModel,
    }),
    [recoverableTurnId, turnRecoveryDisabled, onContinueFailedTurn, onChangeRecoveryModel],
  );
  const hydrated = slot.threadDetailHydration === "ready";
  // A failed turn already drawn in the rows carries the error: no second banner for it.
  const errorInRows =
    slot.threadError !== null &&
    rows.some((row) => row.kind === "failure" && row.entry.turnFailure?.cause === slot.threadError);
  const banner =
    slot.threadError && !errorInRows && bannerTarget
      ? createPortal(
          <div className="thread-banner">
            <ThreadErrorBanner
              error={slot.threadError}
              unblocking={slot.unblockingThread}
              onDismiss={slot.onDismissThreadError}
              onUnblock={slot.onUnblockThread}
            />
          </div>,
          bannerTarget,
        )
      : null;
  return (
    <>
      {banner}
      <Transcript
        opens={threadId}
        watch={[rows, answering, step, approval, asking, hydrated]}
        followKey={newestUserMessageId(rows)}
        bottomInsetPx={slot.contentInsetBottomPx}
        onEdges={onEdges}
      >
        {rows.length === 0 && !answering ? (
          hydrated ? (
            <FirstUse bot={bot} />
          ) : (
            <div className="first-use">
              <ThreadDetailHydrationState
                state={slot.threadDetailHydration === "failed" ? "failed" : "loading"}
                onRetry={slot.onRetryThreadDetailSync}
              />
            </div>
          )
        ) : null}
        {rows.map((row) => {
          if (mergedCardKeys.has(row.key)) return null;
          const start = row.kind === "from" ? (starts.get(row.delegationId) ?? null) : null;
          return (
            <Row
              key={row.key}
              row={row}
              bot={bot}
              thread={threadId}
              tint={tint}
              start={start}
              recovery={recovery}
              onExpandImage={slot.onExpandImage}
            />
          );
        })}
        {approval ? (
          <div className="row row--group row--bot">
            <div className="bot bot--card">
              <ApprovalCard
                key={approval.requestId}
                approval={approval}
                pendingCount={slot.pendingApprovals.length}
                pending={slot}
              />
            </div>
          </div>
        ) : null}
        {asking ? (
          <div className="row row--group row--bot">
            <div className="bot bot--card">
              <QuestionCard pending={slot.pendingUserInput} />
            </div>
          </div>
        ) : null}
        {answering && approval === null && !asking ? <Typing bot={bot} step={step} /> : null}
      </Transcript>
    </>
  );
}
