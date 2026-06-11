// FILE: userMessageRow.tsx
// Purpose: Renders one user-message timeline row (media, message bubble, edit form, footer actions).
// Layer: Web chat presentation component
// Exports: UserMessageRow

import { type MessageId } from "@t3tools/contracts";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  memo,
  useEffect,
  useRef,
  useState,
} from "react";
import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "../../appSettings";
import { formatShortTimestamp } from "../../timestampFormat";
import { NewThreadIcon, QueueArrow, Undo2Icon } from "~/lib/icons";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { FileEntryIcon } from "./FileEntryIcon";
import { MessageActionButton, MESSAGE_ACTION_ICON_CLASS_NAME } from "./MessageActionButton";
import { MessageCopyButton } from "./MessageCopyButton";
import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
  USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
} from "./chatTypography";
import { deriveUserMessagePreviewState } from "./userMessagePreview";
import { UserMessageBody, hasOnlyInlineSkillChips } from "./userMessageBody";
import { UserMessageBubbleFrame } from "./messagePrimitives";

type UserMessageTimelineRow = Extract<MessagesTimelineRow, { kind: "message" }>;
type TimelineMessage = UserMessageTimelineRow["message"];

const MESSAGE_HOVER_REVEAL_CLASS_NAME =
  "opacity-0 transition-opacity pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto";

// Keeps the steer marker visually attached to the whole sent-message stack.
function UserDispatchModeChip({
  dispatchMode,
  hasLeadingMedia,
}: {
  dispatchMode: TimelineMessage["dispatchMode"];
  hasLeadingMedia: boolean;
}) {
  if (dispatchMode !== "steer") {
    return null;
  }

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 self-end px-0 text-[11px] font-normal tracking-[0.01em] text-muted-foreground/78",
        hasLeadingMedia ? "mb-3" : "mb-1.5",
      )}
    >
      <QueueArrow className="size-3 shrink-0 text-muted-foreground/75" />
      <span>Steering conversation</span>
    </div>
  );
}

const UserImageAttachmentThumbnail = memo(function UserImageAttachmentThumbnail(props: {
  image: Extract<NonNullable<TimelineMessage["attachments"]>[number], { type: "image" }>;
  userImages: Array<
    Extract<NonNullable<TimelineMessage["attachments"]>[number], { type: "image" }>
  >;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onTimelineImageLoad: () => void;
  resolvedTheme: "light" | "dark";
}) {
  return (
    <button
      type="button"
      className="flex size-15 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-background/82 text-left shadow-[0_1px_0_rgba(255,255,255,0.2)_inset] transition-colors hover:bg-background/94"
      aria-label={`Preview ${props.image.name}`}
      title={props.image.name}
      onClick={() => {
        const preview = buildExpandedImagePreview(props.userImages, props.image.id);
        if (!preview) return;
        props.onImageExpand(preview);
      }}
    >
      {props.image.previewUrl ? (
        <img
          src={props.image.previewUrl}
          alt={props.image.name}
          className="size-full object-cover"
          onLoad={props.onTimelineImageLoad}
          onError={props.onTimelineImageLoad}
        />
      ) : (
        <div className="flex size-full items-center justify-center">
          <FileEntryIcon
            pathValue={props.image.name}
            kind="file"
            theme={props.resolvedTheme}
            className="size-4 opacity-70"
          />
        </div>
      )}
    </button>
  );
});

// Inline editor for replaying a user message after the following assistant turn is rolled back.
const UserMessageEditForm = memo(function UserMessageEditForm(props: {
  initialValue: string;
  disabled: boolean;
  chatTypographyStyle: CSSProperties;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(props.initialValue);
  const canSubmit = draft.trim().length > 0 && !props.disabled;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [draft]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (canSubmit) {
        props.onSubmit(draft);
      }
    }
  };

  return (
    <form
      className={cn(
        "w-full bg-[var(--app-user-message-background)]",
        USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
        USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
      )}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) {
          props.onSubmit(draft);
        }
      }}
    >
      <textarea
        ref={textareaRef}
        value={draft}
        disabled={props.disabled}
        rows={1}
        aria-label="Edit message"
        className="max-h-60 min-h-0 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 font-system-ui text-foreground outline-none placeholder:text-muted-foreground/70 disabled:opacity-70"
        style={props.chatTypographyStyle}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="rounded-full px-2.5"
          style={props.chatTypographyStyle}
          disabled={props.disabled}
          onClick={props.onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="xs"
          className="rounded-full px-2.5"
          style={props.chatTypographyStyle}
          disabled={!canSubmit}
        >
          Send
        </Button>
      </div>
    </form>
  );
});

export interface UserMessageRowProps {
  row: UserMessageTimelineRow;
  resolvedTheme: "light" | "dark";
  normalizedChatFontSizePx: number;
  userMessageTypographyStyle: CSSProperties;
  chatMessageFooterStyle: CSSProperties;
  timestampFormat: TimestampFormat;
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onRevertUserMessage: (messageId: MessageId) => void;
  onEditUserMessage?: (messageId: MessageId, text: string) => boolean | Promise<boolean>;
  editingUserMessageId: MessageId | null;
  submittingEditedUserMessageId: MessageId | null;
  latestEditableUserMessageId: MessageId | null;
  expandedUserMessagesById: Record<string, boolean>;
  setExpandedUserMessagesById: (
    updater: (previous: Record<string, boolean>) => Record<string, boolean>,
  ) => void;
  startUserMessageEdit: (messageId: MessageId) => void;
  cancelUserMessageEdit: () => void;
  submitUserMessageEdit: (messageId: MessageId, text: string) => void | Promise<void>;
  tailContentRowId: string | null;
  scrollTailExpansionToEnd: () => void;
  ignoreTimelineImageLoad: () => void;
}

export function UserMessageRow({
  row,
  resolvedTheme,
  normalizedChatFontSizePx,
  userMessageTypographyStyle,
  chatMessageFooterStyle,
  timestampFormat,
  isWorking,
  isRevertingCheckpoint,
  onImageExpand,
  onRevertUserMessage,
  onEditUserMessage,
  editingUserMessageId,
  submittingEditedUserMessageId,
  latestEditableUserMessageId,
  expandedUserMessagesById,
  setExpandedUserMessagesById,
  startUserMessageEdit,
  cancelUserMessageEdit,
  submitUserMessageEdit,
  tailContentRowId,
  scrollTailExpansionToEnd,
  ignoreTimelineImageLoad,
}: UserMessageRowProps): ReactNode {
  const userImages = (row.message.attachments ?? []).filter(
    (
      attachment,
    ): attachment is Extract<
      NonNullable<TimelineMessage["attachments"]>[number],
      { type: "image" }
    > => attachment.type === "image",
  );
  const assistantSelections = (row.message.attachments ?? []).filter(
    (
      attachment,
    ): attachment is Extract<
      NonNullable<TimelineMessage["attachments"]>[number],
      { type: "assistant-selection" }
    > => attachment.type === "assistant-selection",
  );
  const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text, {
    hideImageOnlyBootstrapPrompt: userImages.length > 0 || assistantSelections.length > 0,
  });
  const renderedAssistantSelections =
    assistantSelections.length > 0
      ? assistantSelections
      : displayedUserMessage.assistantSelections.map((selection, index) => ({
          type: "assistant-selection" as const,
          id: `fallback-selection-${row.message.id}-${index}`,
          assistantMessageId: selection.assistantMessageId,
          text: selection.text,
        }));
  const terminalContexts = displayedUserMessage.contexts;
  const userMessagePreview = deriveUserMessagePreviewState(displayedUserMessage.visibleText, {
    expanded: expandedUserMessagesById[row.message.id] ?? false,
  });
  const userMessageExpanded = expandedUserMessagesById[row.message.id] ?? false;
  const showUserText = userMessagePreview.text.trim().length > 0 || terminalContexts.length > 0;
  const bubbleIsChipOnly =
    showUserText &&
    terminalContexts.length === 0 &&
    hasOnlyInlineSkillChips(userMessagePreview.text);
  const canRevertAgentWork = typeof row.revertTurnCount === "number";
  const isEditingThisMessage = editingUserMessageId === row.message.id;
  const isSubmittingThisEdit = submittingEditedUserMessageId === row.message.id;
  const showEditUserMessage =
    Boolean(onEditUserMessage) &&
    row.message.id === latestEditableUserMessageId &&
    displayedUserMessage.copyText.trim().length > 0;
  const hasLeadingMedia = renderedAssistantSelections.length > 0 || userImages.length > 0;
  const isTailContentRow = row.id === tailContentRowId;
  return (
    <div className="flex w-full justify-end">
      <div
        className={cn(
          "group flex flex-col items-end gap-px",
          isEditingThisMessage ? "w-full max-w-full" : "max-w-[80%]",
        )}
      >
        {/* Keep user-message chrome outside the bubble so the message reads as one simple block. */}
        <UserDispatchModeChip
          dispatchMode={row.message.dispatchMode}
          hasLeadingMedia={hasLeadingMedia}
        />
        {renderedAssistantSelections.length > 0 && (
          <div className="mb-1 flex max-w-[240px] flex-wrap justify-end gap-1.5 self-end">
            <AssistantSelectionsSummaryChip selections={renderedAssistantSelections} />
          </div>
        )}
        {userImages.length > 0 && (
          <div
            className={cn(
              "flex max-w-[240px] flex-wrap justify-end gap-2 self-end",
              showUserText && "mb-1",
            )}
          >
            {userImages.map((image) => (
              <UserImageAttachmentThumbnail
                key={image.id}
                image={image}
                userImages={userImages}
                onImageExpand={onImageExpand}
                onTimelineImageLoad={
                  isTailContentRow ? scrollTailExpansionToEnd : ignoreTimelineImageLoad
                }
                resolvedTheme={resolvedTheme}
              />
            ))}
          </div>
        )}
        {isEditingThisMessage ? (
          <UserMessageEditForm
            key={row.message.id}
            initialValue={displayedUserMessage.copyText}
            disabled={isSubmittingThisEdit || isRevertingCheckpoint}
            chatTypographyStyle={userMessageTypographyStyle}
            onCancel={cancelUserMessageEdit}
            onSubmit={(text) => void submitUserMessageEdit(row.message.id, text)}
          />
        ) : showUserText ? (
          <UserMessageBubbleFrame
            className="w-max max-w-full self-end"
            paddingClassName={bubbleIsChipOnly ? "py-1 px-3.5" : undefined}
          >
            <UserMessageBody
              text={userMessagePreview.text}
              terminalContexts={terminalContexts}
              chatTypographyStyle={userMessageTypographyStyle}
              resolvedTheme={resolvedTheme}
            />
            {userMessagePreview.collapsible && (
              <button
                type="button"
                data-scroll-anchor-ignore
                className="mt-1 block text-muted-foreground/70 transition-colors duration-150 hover:text-foreground/72"
                style={{ fontSize: `${normalizedChatFontSizePx}px` }}
                onClick={() => {
                  setExpandedUserMessagesById((previous) => ({
                    ...previous,
                    [row.message.id]: !(previous[row.message.id] ?? false),
                  }));
                }}
              >
                {userMessageExpanded ? "Show less" : "Show more"}
              </button>
            )}
          </UserMessageBubbleFrame>
        ) : null}
        {!isEditingThisMessage && (
          <div
            className="flex items-center justify-end gap-2 pr-0.5 font-system-ui font-normal text-muted-foreground/70"
            style={chatMessageFooterStyle}
          >
            <p className={cn("tabular-nums", MESSAGE_HOVER_REVEAL_CLASS_NAME)}>
              {formatShortTimestamp(row.message.createdAt, timestampFormat)}
            </p>
            <div className="flex items-center gap-2">
              {displayedUserMessage.copyText && (
                <MessageCopyButton
                  text={displayedUserMessage.copyText}
                  className={MESSAGE_HOVER_REVEAL_CLASS_NAME}
                />
              )}
              {showEditUserMessage && (
                <MessageActionButton
                  label="Edit message"
                  tooltip="Edit and resend"
                  disabled={isRevertingCheckpoint}
                  className="disabled:text-muted-foreground/70"
                  onClick={() => startUserMessageEdit(row.message.id)}
                >
                  <NewThreadIcon className={MESSAGE_ACTION_ICON_CLASS_NAME} />
                </MessageActionButton>
              )}
              {canRevertAgentWork ? (
                <MessageActionButton
                  label="Revert to this message"
                  tooltip="Revert to this message"
                  disabled={isRevertingCheckpoint || isWorking}
                  className="disabled:text-muted-foreground/70"
                  onClick={() => onRevertUserMessage(row.message.id)}
                >
                  <Undo2Icon className={MESSAGE_ACTION_ICON_CLASS_NAME} />
                </MessageActionButton>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
