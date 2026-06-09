// FILE: MessagesTimeline.tsx
// Purpose: Renders the chat transcript rows and lets LegendList own scrolling/follow behavior.
// Layer: Web chat presentation component
// Exports: MessagesTimeline

import { type MessageId, ThreadId, type TurnId } from "@t3tools/contracts";
import { resolveLatestTailUserMessageEditTarget } from "@t3tools/shared/conversationEdit";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps,
  type KeyboardEvent,
  type RefObject,
  type ReactNode,
} from "react";
import { deriveTimelineEntries, formatElapsed } from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { ChangesIcon, NewThreadIcon, QueueArrow, Undo2Icon } from "~/lib/icons";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel } from "./DiffStatLabel";
import { FileEntryIcon } from "./FileEntryIcon";
import { MessageActionButton, MESSAGE_ACTION_ICON_CLASS_NAME } from "./MessageActionButton";
import { MessageCopyButton } from "./MessageCopyButton";
import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  type MessagesTimelineRow,
  resolveAssistantMessageCopyState,
  type StableMessagesTimelineRowsState,
} from "./MessagesTimeline.logic";
import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import {
  DEFAULT_CHAT_FONT_SIZE_PX,
  normalizeChatFontSizePx,
  type TimestampFormat,
} from "../../appSettings";
import {
  CHAT_COLUMN_FRAME_CLASS_NAME,
  CHAT_COLUMN_GUTTER_CLASS_NAME,
} from "./composerPickerStyles";
import { formatShortTimestamp } from "../../timestampFormat";
import {
  getChatMessageFooterTextStyle,
  getChatTranscriptTextStyle,
  getChatTranscriptUserMessageTextStyle,
  USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
  USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
} from "./chatTypography";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { disclosureContentClassName } from "~/lib/disclosureMotion";
import { getAppTypographyScale } from "../../lib/appTypography";
import { deriveUserMessagePreviewState } from "./userMessagePreview";
import {
  SimpleWorkEntryRow,
  basename,
  isFileChangeWorkEntry,
  prefersCompactWorkEntryRow,
} from "./workEntryRow";
import { UserMessageBody, hasOnlyInlineSkillChips } from "./userMessageBody";

const MAX_VISIBLE_INLINE_TOOL_ENTRIES = 4;
// The composer overlaps the transcript by design, so the list needs extra tail
// space beyond the overlap to keep final cards from sitting flush against it.
const MIN_BOTTOM_CONTENT_INSET_PX = 64;
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

interface MessagesTimelineProps {
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  followLiveOutput?: boolean;
  emptyStateContent?: ReactNode;
  listRef?: RefObject<LegendListRef | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  nowIso?: string;
  expandedWorkGroups?: Record<string, boolean>;
  onToggleWorkGroup?: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onOpenThread?: (threadId: ThreadId) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  onEditUserMessage?: (messageId: MessageId, text: string) => boolean | Promise<boolean>;
  activeTurnId?: TurnId | null;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onIsAtEndChange?: (isAtEnd: boolean) => void;
  onMessagesClickCapture?: ComponentProps<typeof LegendList>["onClickCapture"];
  onMessagesMouseUp?: ComponentProps<typeof LegendList>["onMouseUp"];
  onMessagesPointerCancel?: ComponentProps<typeof LegendList>["onPointerCancel"];
  onMessagesPointerDown?: ComponentProps<typeof LegendList>["onPointerDown"];
  onMessagesPointerUp?: ComponentProps<typeof LegendList>["onPointerUp"];
  onMessagesScroll?: ComponentProps<typeof LegendList>["onScroll"];
  onMessagesTouchEnd?: ComponentProps<typeof LegendList>["onTouchEnd"];
  onMessagesTouchMove?: ComponentProps<typeof LegendList>["onTouchMove"];
  onMessagesTouchStart?: ComponentProps<typeof LegendList>["onTouchStart"];
  onMessagesWheel?: ComponentProps<typeof LegendList>["onWheel"];
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  chatFontSizePx?: number;
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  bottomContentInsetPx?: number | undefined;
}

export const MessagesTimeline = memo(function MessagesTimeline({
  hasMessages,
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  followLiveOutput = false,
  listRef,
  timelineEntries,
  turnDiffSummaryByAssistantMessageId,
  nowIso,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenTurnDiff,
  onOpenThread,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  onEditUserMessage,
  activeTurnId,
  isRevertingCheckpoint,
  onImageExpand,
  onIsAtEndChange,
  onMessagesClickCapture,
  onMessagesMouseUp,
  onMessagesPointerCancel,
  onMessagesPointerDown,
  onMessagesPointerUp,
  onMessagesScroll,
  onMessagesTouchEnd,
  onMessagesTouchMove,
  onMessagesTouchStart,
  onMessagesWheel,
  markdownCwd,
  resolvedTheme,
  chatFontSizePx = DEFAULT_CHAT_FONT_SIZE_PX,
  timestampFormat,
  workspaceRoot,
  emptyStateContent,
  bottomContentInsetPx,
}: MessagesTimelineProps) {
  const normalizedChatFontSizePx = normalizeChatFontSizePx(chatFontSizePx);
  const appTypographyScale = useMemo(
    () => getAppTypographyScale(normalizedChatFontSizePx),
    [normalizedChatFontSizePx],
  );
  const chatTypographyStyle = useMemo(
    () => getChatTranscriptTextStyle(normalizedChatFontSizePx),
    [normalizedChatFontSizePx],
  );
  const userMessageTypographyStyle = useMemo(
    () => getChatTranscriptUserMessageTextStyle(normalizedChatFontSizePx),
    [normalizedChatFontSizePx],
  );
  const chatMessageFooterStyle = useMemo(
    () => getChatMessageFooterTextStyle(normalizedChatFontSizePx),
    [normalizedChatFontSizePx],
  );
  const [localExpandedWorkGroups, setLocalExpandedWorkGroups] = useState<Record<string, boolean>>(
    {},
  );
  const expandedWorkGroupsState = expandedWorkGroups ?? localExpandedWorkGroups;
  const handleToggleWorkGroup = useCallback(
    (groupId: string) => {
      if (onToggleWorkGroup) {
        onToggleWorkGroup(groupId);
        return;
      }
      setLocalExpandedWorkGroups((current) => ({
        ...current,
        [groupId]: !(current[groupId] ?? false),
      }));
    },
    [onToggleWorkGroup],
  );
  const [expandedCollapsedWork, setExpandedCollapsedWork] = useState<Record<string, boolean>>({});
  const setCollapsedWorkExpanded = useCallback((messageId: string, open: boolean) => {
    setExpandedCollapsedWork((current) => ({
      ...current,
      [messageId]: open,
    }));
  }, []);
  const [expandedFileChangesByTurnId, setExpandedFileChangesByTurnId] = useState<
    Record<string, boolean>
  >({});
  const [expandedUserMessagesById, setExpandedUserMessagesById] = useState<Record<string, boolean>>(
    {},
  );
  const [editingUserMessageId, setEditingUserMessageId] = useState<MessageId | null>(null);
  const [submittingEditedUserMessageId, setSubmittingEditedUserMessageId] =
    useState<MessageId | null>(null);
  const timelineExtraData = useMemo(
    () => ({
      editingUserMessageId,
      expandedCollapsedWork,
      expandedFileChangesByTurnId,
      expandedUserMessagesById,
      expandedWorkGroupsState,
      submittingEditedUserMessageId,
    }),
    [
      editingUserMessageId,
      expandedCollapsedWork,
      expandedFileChangesByTurnId,
      expandedUserMessagesById,
      expandedWorkGroupsState,
      submittingEditedUserMessageId,
    ],
  );
  const fallbackListRef = useRef<LegendListRef | null>(null);
  const resolvedListRef = listRef ?? fallbackListRef;
  const bottomSpacerHeightPx = Math.max(bottomContentInsetPx ?? 0, MIN_BOTTOM_CONTENT_INSET_PX);
  const listFooter = useMemo(
    () => <div aria-hidden="true" style={{ height: bottomSpacerHeightPx }} />,
    [bottomSpacerHeightPx],
  );

  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        isWorking,
        activeTurnInProgress,
        activeTurnId,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
      }),
    [
      timelineEntries,
      isWorking,
      activeTurnInProgress,
      activeTurnId,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
    ],
  );
  const rows = useStableRows(rawRows);
  const tailContentRowId = useMemo(() => {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (row.kind !== "working") return row.id;
    }
    return null;
  }, [rows]);
  const tailScrollFrameRef = useRef<number | null>(null);
  const tailScrollTimeoutsRef = useRef<number[]>([]);
  const clearTailExpansionScrollTimers = useCallback(() => {
    if (tailScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(tailScrollFrameRef.current);
      tailScrollFrameRef.current = null;
    }
    for (const timeoutId of tailScrollTimeoutsRef.current) {
      window.clearTimeout(timeoutId);
    }
    tailScrollTimeoutsRef.current = [];
  }, []);
  const scrollTailExpansionToEnd = useCallback(() => {
    clearTailExpansionScrollTimers();
    const scrollToEnd = () => {
      void resolvedListRef.current?.scrollToEnd?.({ animated: false });
    };
    tailScrollFrameRef.current = window.requestAnimationFrame(() => {
      tailScrollFrameRef.current = null;
      scrollToEnd();
    });
    for (const delay of [80, 180, 260]) {
      const timeoutId = window.setTimeout(scrollToEnd, delay);
      tailScrollTimeoutsRef.current.push(timeoutId);
    }
  }, [clearTailExpansionScrollTimers, resolvedListRef]);
  useEffect(() => clearTailExpansionScrollTimers, [clearTailExpansionScrollTimers]);
  const ignoreTimelineImageLoad = useCallback(() => {}, []);
  const latestEditableUserMessageId = useMemo(() => {
    const messages = rows.flatMap((row) => (row.kind === "message" ? [row.message] : []));
    const editTarget = resolveLatestTailUserMessageEditTarget({
      messages,
      activeTurnId,
    });
    return editTarget.editable ? (editTarget.messageId as MessageId) : null;
  }, [activeTurnId, rows]);
  const userMessageIdByAssistantMessageId = useMemo(() => {
    const map = new Map<MessageId, MessageId>();
    let lastUserMessageId: MessageId | null = null;
    for (const row of rows) {
      if (row.kind !== "message") continue;
      if (row.message.role === "user") {
        lastUserMessageId = row.message.id;
      } else if (row.message.role === "assistant" && lastUserMessageId) {
        map.set(row.message.id, lastUserMessageId);
      }
    }
    return map;
  }, [rows]);
  const previousRowCountRef = useRef(rows.length);
  useEffect(() => {
    const previousRowCount = previousRowCountRef.current;
    previousRowCountRef.current = rows.length;
    if (previousRowCount > 0 || rows.length === 0) {
      return;
    }
    onIsAtEndChange?.(true);
    const frameId = window.requestAnimationFrame(() => {
      void resolvedListRef.current?.scrollToEnd?.({ animated: false });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [onIsAtEndChange, resolvedListRef, rows.length]);
  const handleListScroll = useCallback<NonNullable<MessagesTimelineProps["onMessagesScroll"]>>(
    (event) => {
      onMessagesScroll?.(event);
      const state = resolvedListRef.current?.getState?.();
      if (state) {
        onIsAtEndChange?.(state.isAtEnd);
      }
    },
    [onIsAtEndChange, onMessagesScroll, resolvedListRef],
  );
  const toggleFileChangesExpanded = useCallback((turnId: TurnId) => {
    setExpandedFileChangesByTurnId((current) => ({
      ...current,
      [turnId]: !(current[turnId] ?? true),
    }));
  }, []);
  const cancelUserMessageEdit = useCallback(() => {
    setEditingUserMessageId(null);
  }, []);
  const startUserMessageEdit = useCallback((messageId: MessageId) => {
    setEditingUserMessageId(messageId);
  }, []);
  const submitUserMessageEdit = useCallback(
    async (messageId: MessageId, text: string) => {
      if (!onEditUserMessage) {
        return;
      }
      const nextText = text.trim();
      if (!nextText) {
        return;
      }
      setSubmittingEditedUserMessageId(messageId);
      try {
        const saved = await onEditUserMessage(messageId, nextText);
        if (saved) {
          cancelUserMessageEdit();
        }
      } finally {
        setSubmittingEditedUserMessageId(null);
      }
    },
    [cancelUserMessageEdit, onEditUserMessage],
  );

  const renderRowContent = (row: MessagesTimelineRow) => (
    <div
      className={cn(
        CHAT_COLUMN_FRAME_CLASS_NAME,
        "px-1",
        row.kind === "work" || (row.kind === "message" && row.message.role === "assistant")
          ? "pb-2"
          : "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" &&
        (() => {
          const groupId = row.id;
          const groupedEntries = row.groupedEntries;
          const isExpanded = expandedWorkGroupsState[groupId] ?? false;
          const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
          const visibleEntries =
            hasOverflow && !isExpanded
              ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
              : groupedEntries;
          const hiddenCount = groupedEntries.length - visibleEntries.length;
          const showOverflowToggle = hasOverflow;

          return (
            <div>
              <div className="space-y-0.5">
                {visibleEntries.map((workEntry) => (
                  <SimpleWorkEntryRow
                    key={`work-row:${workEntry.id}`}
                    workEntry={workEntry}
                    chatMetaFontSizePx={appTypographyScale.chatMetaPx}
                    textFontSizePx={normalizedChatFontSizePx}
                    density={prefersCompactWorkEntryRow(workEntry) ? "compact" : "default"}
                    {...(onOpenThread ? { onOpenThread } : {})}
                  />
                ))}
              </div>
              {showOverflowToggle && (
                <div className="mt-1.5 flex items-center justify-start gap-2 px-0.5">
                  <button
                    type="button"
                    className="font-system-ui text-muted-foreground/70 transition-colors duration-150 hover:text-foreground/75"
                    style={{ fontSize: `${appTypographyScale.uiSmPx}px` }}
                    onClick={() => handleToggleWorkGroup(groupId)}
                  >
                    {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
                  </button>
                </div>
              )}
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
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
          const userMessagePreview = deriveUserMessagePreviewState(
            displayedUserMessage.visibleText,
            {
              expanded: expandedUserMessagesById[row.message.id] ?? false,
            },
          );
          const userMessageExpanded = expandedUserMessagesById[row.message.id] ?? false;
          const showUserText =
            userMessagePreview.text.trim().length > 0 || terminalContexts.length > 0;
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
                  <div
                    className={cn(
                      "w-max max-w-full min-w-0 self-end bg-[var(--app-user-message-background)]",
                      USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
                      bubbleIsChipOnly
                        ? "py-1 px-3.5"
                        : USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
                    )}
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
                  </div>
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
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        (() => {
          const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
          const inlineWorkEntries = row.inlineWorkEntries ?? [];
          const inlineToolEntries = inlineWorkEntries.filter((entry) => entry.tone === "tool");
          const inlineStatusEntries = inlineWorkEntries.filter((entry) => entry.tone !== "tool");
          const inlineToolGroupId =
            inlineToolEntries.length > 0 ? (row.inlineWorkGroupId ?? null) : null;
          const inlineToolExpanded =
            inlineToolGroupId !== null
              ? (expandedWorkGroupsState[inlineToolGroupId] ?? false)
              : false;
          const visibleInlineToolEntries =
            inlineToolExpanded || inlineToolEntries.length <= MAX_VISIBLE_INLINE_TOOL_ENTRIES
              ? inlineToolEntries
              : activeTurnInProgress
                ? inlineToolEntries.slice(-MAX_VISIBLE_INLINE_TOOL_ENTRIES)
                : inlineToolEntries.slice(0, MAX_VISIBLE_INLINE_TOOL_ENTRIES);
          const hiddenInlineToolCount = inlineToolEntries.length - visibleInlineToolEntries.length;
          const inlineWorkSummary =
            inlineToolEntries.length > 0 ? null : formatInlineWorkSummary(inlineStatusEntries);
          const assistantCopyState = resolveAssistantMessageCopyState({
            text: row.message.text ?? null,
            showCopyButton: row.showAssistantCopyButton,
            streaming: row.assistantCopyStreaming,
          });
          const turnSummary = row.assistantTurnDiffSummary;
          const fileDiffStatByPath = new Map(
            (turnSummary?.files ?? []).map((file) => [
              file.path,
              {
                additions: file.additions ?? 0,
                deletions: file.deletions ?? 0,
              },
            ]),
          );
          const hasGenericInlineFileChangeEntry = inlineToolEntries.some(
            (workEntry) =>
              isFileChangeWorkEntry(workEntry) && (workEntry.changedFiles?.length ?? 0) === 0,
          );
          const visibleRenderableInlineToolEntries = visibleInlineToolEntries.filter(
            (workEntry) =>
              !(
                hasGenericInlineFileChangeEntry &&
                isFileChangeWorkEntry(workEntry) &&
                (workEntry.changedFiles?.length ?? 0) === 0
              ),
          );
          const inlineEditedFilesFromTurnSummary =
            hasGenericInlineFileChangeEntry && (turnSummary?.files.length ?? 0) > 0
              ? turnSummary!.files
              : [];
          const inlineFileChangeDetailsAlreadyVisible =
            inlineEditedFilesFromTurnSummary.length > 0 ||
            visibleRenderableInlineToolEntries.some(
              (workEntry) =>
                isFileChangeWorkEntry(workEntry) && (workEntry.changedFiles?.length ?? 0) > 0,
            );
          const assistantMeta = row.message.streaming ? (
            nowIso ? (
              [
                formatMessageMeta(
                  row.message.createdAt,
                  formatElapsed(row.durationStart, nowIso),
                  timestampFormat,
                ),
                inlineWorkSummary,
              ]
                .filter((value): value is string => Boolean(value))
                .join(" • ")
            ) : (
              <>
                <LiveMessageMeta
                  createdAt={row.message.createdAt}
                  durationStart={row.durationStart}
                  timestampFormat={timestampFormat}
                />
                {inlineWorkSummary ? <> • {inlineWorkSummary}</> : null}
              </>
            )
          ) : (
            [
              formatMessageMeta(
                row.message.createdAt,
                formatElapsed(row.durationStart, row.message.completedAt),
                timestampFormat,
              ),
              inlineWorkSummary,
            ]
              .filter((value): value is string => Boolean(value))
              .join(" • ")
          );
          const collapsedTurnItems = row.collapsedTurnItems;
          const hasCollapsedWork = Boolean(collapsedTurnItems && collapsedTurnItems.length > 0);
          const isCollapsedWorkExpanded = hasCollapsedWork
            ? (expandedCollapsedWork[row.message.id] ?? false)
            : false;
          const isTailContentRow = row.id === tailContentRowId;
          return (
            <>
              {hasCollapsedWork && (
                <div className="mb-3">
                  <Collapsible
                    className="group/collapsed-work"
                    open={isCollapsedWorkExpanded}
                    onOpenChange={(open) => {
                      setCollapsedWorkExpanded(row.message.id, open);
                      if (open && isTailContentRow) {
                        scrollTailExpansionToEnd();
                      }
                    }}
                  >
                    <CollapsibleTrigger
                      data-scroll-anchor-ignore={isTailContentRow ? true : undefined}
                      // -ml-0.5 optically aligns the leading "W" with the reply
                      // text below: the box is already flush, but the W glyph
                      // carries a left side-bearing that reads as an inset.
                      className="-ml-0.5 inline-flex items-center gap-1 pb-2 text-left text-muted-foreground/70 transition-colors duration-200 hover:text-muted-foreground/90"
                      style={{ fontSize: chatTypographyStyle.fontSize }}
                    >
                      <span>
                        {row.collapsedWorkElapsed
                          ? `Worked for ${row.collapsedWorkElapsed}`
                          : "Details"}
                      </span>
                      <DisclosureChevron
                        open={isCollapsedWorkExpanded}
                        className="text-muted-foreground/70"
                      />
                    </CollapsibleTrigger>
                    <CollapsiblePanel>
                      <div
                        className={disclosureContentClassName(
                          isCollapsedWorkExpanded,
                          "mb-2.5 space-y-1.5",
                        )}
                      >
                        {collapsedTurnItems!.map((item) =>
                          item.kind === "work" ? (
                            <SimpleWorkEntryRow
                              key={`collapsed-work:${row.message.id}:${item.id}`}
                              workEntry={item.entry}
                              chatMetaFontSizePx={appTypographyScale.chatMetaPx}
                              textFontSizePx={normalizedChatFontSizePx}
                              density={
                                prefersCompactWorkEntryRow(item.entry) ? "compact" : "default"
                              }
                              {...(onOpenThread ? { onOpenThread } : {})}
                            />
                          ) : (
                            <div
                              key={`collapsed-narration:${row.message.id}:${item.id}`}
                              className="text-muted-foreground/80"
                            >
                              <ChatMarkdown
                                text={item.message.text}
                                cwd={markdownCwd}
                                isStreaming={false}
                                style={chatTypographyStyle}
                                onImageExpand={onImageExpand}
                              />
                            </div>
                          ),
                        )}
                      </div>
                    </CollapsiblePanel>
                  </Collapsible>
                  <div className="h-px w-full bg-border" />
                </div>
              )}
              <div className="group min-w-0 py-0.5">
                <div data-assistant-message-id={row.message.id}>
                  <ChatMarkdown
                    text={messageText}
                    cwd={markdownCwd}
                    isStreaming={Boolean(row.message.streaming)}
                    style={chatTypographyStyle}
                    onImageExpand={onImageExpand}
                  />
                </div>
                {!hasCollapsedWork && visibleRenderableInlineToolEntries.length > 0 && (
                  <div className="mt-2.5">
                    <div className="space-y-px">
                      {visibleRenderableInlineToolEntries.map((workEntry) => (
                        <SimpleWorkEntryRow
                          key={`inline-tool-row:${row.message.id}:${workEntry.id}`}
                          workEntry={workEntry}
                          chatMetaFontSizePx={appTypographyScale.chatMetaPx}
                          textFontSizePx={normalizedChatFontSizePx}
                          density="compact"
                          fileDiffStatByPath={fileDiffStatByPath}
                          onOpenTurnDiff={onOpenTurnDiff}
                          {...(onOpenThread ? { onOpenThread } : {})}
                          {...(turnSummary?.turnId ? { turnId: turnSummary.turnId } : {})}
                        />
                      ))}
                    </div>
                    {inlineToolGroupId &&
                      inlineToolEntries.length > MAX_VISIBLE_INLINE_TOOL_ENTRIES && (
                        <div className="py-0.5">
                          <button
                            type="button"
                            className="text-muted-foreground/70 transition-colors duration-150 hover:text-foreground/72"
                            style={{ fontSize: `${normalizedChatFontSizePx}px` }}
                            onClick={() => handleToggleWorkGroup(inlineToolGroupId)}
                          >
                            {inlineToolExpanded
                              ? "Show less"
                              : `+${hiddenInlineToolCount} more tool calls`}
                          </button>
                        </div>
                      )}
                  </div>
                )}
                {!hasCollapsedWork && inlineStatusEntries.length > 0 && (
                  <div className="mt-2 space-y-0.5">
                    {inlineStatusEntries.map((workEntry) => (
                      <SimpleWorkEntryRow
                        key={`inline-status-row:${row.message.id}:${workEntry.id}`}
                        workEntry={workEntry}
                        chatMetaFontSizePx={appTypographyScale.chatMetaPx}
                        textFontSizePx={normalizedChatFontSizePx}
                        density={prefersCompactWorkEntryRow(workEntry) ? "compact" : "default"}
                        {...(onOpenThread ? { onOpenThread } : {})}
                      />
                    ))}
                  </div>
                )}
                {inlineEditedFilesFromTurnSummary.length > 0 && (
                  <div className="mt-2 space-y-0.5">
                    {inlineEditedFilesFromTurnSummary.map((file) => (
                      <button
                        key={`inline-summary-edit:${row.message.id}:${file.path}`}
                        type="button"
                        className="group/file-row flex w-full max-w-full items-baseline gap-1 px-0 py-1.5 text-left transition-opacity duration-150 hover:opacity-95"
                        title={file.path}
                        onClick={() => onOpenTurnDiff(turnSummary!.turnId, file.path)}
                      >
                        <span
                          className="font-system-ui shrink-0 text-[#7b7b84]"
                          style={{ fontSize: `${normalizedChatFontSizePx}px` }}
                        >
                          Edited
                        </span>
                        <span
                          className="font-system-ui max-w-[28rem] truncate text-[var(--color-text-foreground)] underline-offset-2 group-hover/file-row:underline group-focus-visible/file-row:underline"
                          style={{
                            fontSize: `${normalizedChatFontSizePx}px`,
                          }}
                        >
                          {basename(file.path)}
                        </span>
                        {(file.additions ?? 0) + (file.deletions ?? 0) > 0 ? (
                          <span
                            className="font-system-ui shrink-0 tabular-nums whitespace-nowrap"
                            style={{ fontSize: `${normalizedChatFontSizePx}px` }}
                          >
                            <DiffStatLabel
                              additions={file.additions ?? 0}
                              deletions={file.deletions ?? 0}
                            />
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                )}
                <div
                  className="mt-0.5 flex items-center gap-2 font-system-ui font-normal text-muted-foreground/70"
                  style={chatMessageFooterStyle}
                >
                  {assistantCopyState.visible ? (
                    <MessageCopyButton
                      text={assistantCopyState.text ?? ""}
                      className={MESSAGE_HOVER_REVEAL_CLASS_NAME}
                    />
                  ) : null}
                  <p className={cn("tabular-nums", MESSAGE_HOVER_REVEAL_CLASS_NAME)}>
                    {assistantMeta}
                  </p>
                </div>
                {(() => {
                  if (!turnSummary) return null;
                  const checkpointFiles = turnSummary.files;
                  if (checkpointFiles.length === 0) return null;
                  const fileChangesExpanded =
                    expandedFileChangesByTurnId[turnSummary.turnId] ?? true;
                  const correspondingUserMessageId = userMessageIdByAssistantMessageId.get(
                    row.message.id,
                  );
                  const canUndo =
                    correspondingUserMessageId != null &&
                    revertTurnCountByUserMessageId.has(correspondingUserMessageId);
                  const totalAdditions = checkpointFiles.reduce(
                    (sum, file) => sum + (file.additions ?? 0),
                    0,
                  );
                  const totalDeletions = checkpointFiles.reduce(
                    (sum, file) => sum + (file.deletions ?? 0),
                    0,
                  );
                  const editedFilesLabel =
                    checkpointFiles.length === 1
                      ? "Edited 1 file"
                      : `Edited ${checkpointFiles.length} files`;
                  return (
                    <div className="mt-4 overflow-hidden rounded-[0.65rem] border border-[color:var(--color-border-light)]">
                      <div
                        className={cn(
                          "flex items-center justify-between gap-3 bg-[var(--app-user-message-background)] px-3 py-1.5",
                          fileChangesExpanded &&
                            "border-b border-[color:var(--color-border-light)]",
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <ChangesIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                          <div className="min-w-0">
                            <div
                              className="truncate font-normal text-foreground/92"
                              style={{ fontSize: chatTypographyStyle.fontSize }}
                            >
                              {editedFilesLabel}
                            </div>
                            {totalAdditions + totalDeletions > 0 ? (
                              <div
                                className="font-system-ui tabular-nums"
                                style={{ fontSize: chatTypographyStyle.fontSize }}
                              >
                                <DiffStatLabel
                                  additions={totalAdditions}
                                  deletions={totalDeletions}
                                />
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {canUndo && (
                            <button
                              type="button"
                              className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
                              style={{ fontSize: chatTypographyStyle.fontSize }}
                              onClick={() => onRevertUserMessage(correspondingUserMessageId)}
                            >
                              Undo
                              <Undo2Icon className="size-3" />
                            </button>
                          )}
                          <button
                            type="button"
                            className="rounded-md border border-[color:var(--color-border-light)] px-2.5 py-0.5 text-foreground/90 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground"
                            style={{ fontSize: chatTypographyStyle.fontSize }}
                            onClick={() => onOpenTurnDiff(turnSummary.turnId)}
                          >
                            Review
                          </button>
                          <button
                            type="button"
                            className="inline-flex items-center justify-center rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground/80"
                            aria-expanded={fileChangesExpanded}
                            aria-label={
                              fileChangesExpanded
                                ? "Collapse changed files list"
                                : "Expand changed files list"
                            }
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              if (!fileChangesExpanded && isTailContentRow) {
                                scrollTailExpansionToEnd();
                              }
                              toggleFileChangesExpanded(turnSummary.turnId);
                            }}
                            data-scroll-anchor-ignore={isTailContentRow ? true : undefined}
                          >
                            <DisclosureChevron
                              open={fileChangesExpanded}
                              className="dark:text-muted-foreground/70"
                            />
                          </button>
                        </div>
                      </div>
                      <DisclosureRegion open={fileChangesExpanded}>
                        {inlineFileChangeDetailsAlreadyVisible ? (
                          <div className="px-3 py-2">
                            <ChangedFilesTree
                              turnId={turnSummary.turnId}
                              files={checkpointFiles}
                              allDirectoriesExpanded
                              resolvedTheme={resolvedTheme}
                              onOpenTurnDiff={onOpenTurnDiff}
                            />
                          </div>
                        ) : (
                          checkpointFiles.map((file) => (
                            <button
                              key={file.path}
                              type="button"
                              className="group/file-row flex w-full items-center gap-2 border-t border-[color:var(--color-border-light)] bg-transparent px-3 py-2.5 text-left first:border-t-0 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] dark:bg-transparent dark:hover:bg-transparent"
                              onClick={() => onOpenTurnDiff(turnSummary.turnId, file.path)}
                            >
                              <FileEntryIcon
                                pathValue={file.path}
                                kind="file"
                                theme={resolvedTheme}
                                className="size-4 shrink-0 text-[var(--color-text-foreground)] opacity-70 dark:opacity-80"
                              />
                              <span
                                className="font-system-ui truncate font-normal text-[var(--color-text-foreground)] underline-offset-2 group-hover/file-row:underline group-focus-visible/file-row:underline"
                                style={{
                                  fontSize: chatTypographyStyle.fontSize,
                                }}
                              >
                                {file.path}
                              </span>
                              {(file.additions ?? 0) + (file.deletions ?? 0) > 0 && (
                                <span
                                  className="font-system-ui ml-auto shrink-0 tabular-nums"
                                  style={{ fontSize: chatTypographyStyle.fontSize }}
                                >
                                  <DiffStatLabel
                                    additions={file.additions ?? 0}
                                    deletions={file.deletions ?? 0}
                                  />
                                </span>
                              )}
                            </button>
                          ))
                        )}
                      </DisclosureRegion>
                    </div>
                  );
                })()}
              </div>
            </>
          );
        })()}

      {row.kind === "proposed-plan" && (
        <div className="min-w-0 py-0.5">
          <ProposedPlanCard
            planMarkdown={row.proposedPlan.planMarkdown}
            cwd={markdownCwd}
            workspaceRoot={workspaceRoot}
            chatTypographyStyle={chatTypographyStyle}
          />
        </div>
      )}

      {row.kind === "working" && (
        <div
          className="pt-0.5 text-muted-foreground/70 font-system-ui"
          style={{ fontSize: `${appTypographyScale.chatPx}px` }}
        >
          {row.createdAt ? (
            <>
              Working for{" "}
              {nowIso ? (
                (formatWorkingTimer(row.createdAt, nowIso) ?? "0s")
              ) : (
                <WorkingTimer createdAt={row.createdAt} />
              )}
            </>
          ) : (
            "Working..."
          )}
        </div>
      )}
    </div>
  );

  if (!hasMessages && !isWorking) {
    if (emptyStateContent) {
      return <div className="flex h-full items-center justify-center">{emptyStateContent}</div>;
    }
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/70">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <LegendList<MessagesTimelineRow>
      ref={resolvedListRef}
      data={rows}
      keyExtractor={(row) => row.id}
      renderItem={({ item }) => renderRowContent(item)}
      estimatedItemSize={90}
      // LegendList caches rendered rows, so every local expansion map that changes row content
      // has to be surfaced through extraData.
      extraData={timelineExtraData}
      initialScrollAtEnd
      maintainScrollAtEnd={followLiveOutput}
      maintainScrollAtEndThreshold={0.1}
      maintainVisibleContentPosition
      onClickCapture={onMessagesClickCapture}
      onMouseUp={onMessagesMouseUp}
      onPointerCancel={onMessagesPointerCancel}
      onPointerDown={onMessagesPointerDown}
      onPointerUp={onMessagesPointerUp}
      onScroll={handleListScroll}
      onTouchEnd={onMessagesTouchEnd}
      onTouchMove={onMessagesTouchMove}
      onTouchStart={onMessagesTouchStart}
      onWheel={onMessagesWheel}
      data-chat-scroll-container="true"
      ListFooterComponent={listFooter}
      className={cn(
        "h-full overflow-x-hidden overscroll-y-contain py-3 [scrollbar-gutter:stable] sm:py-4",
        CHAT_COLUMN_GUTTER_CLASS_NAME,
      )}
    />
  );
});

type TimelineMessage = Extract<MessagesTimelineRow, { kind: "message" }>["message"];
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];

// Reuse stable row references so streaming updates only force React work for
// rows whose visible content actually changed.
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const previousStateRef = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });

  return useMemo(() => {
    const nextState = computeStableMessagesTimelineRows(rows, previousStateRef.current);
    previousStateRef.current = nextState;
    return nextState.result;
  }, [rows]);
}

// Keep the live clock scoped to tiny leaf components so active Claude turns do
// not force the full transcript tree to re-render every second.
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt);
      }
    };
    updateText();
    const id = window.setInterval(updateText, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [createdAt]);

  return <span ref={textRef}>{initialText}</span>;
}

function LiveMessageMeta({
  createdAt,
  durationStart,
  timestampFormat,
}: {
  createdAt: string;
  durationStart: string;
  timestampFormat: TimestampFormat;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatLiveMessageMetaNow(createdAt, durationStart, timestampFormat);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatLiveMessageMetaNow(
          createdAt,
          durationStart,
          timestampFormat,
        );
      }
    };
    updateText();
    const id = window.setInterval(updateText, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [createdAt, durationStart, timestampFormat]);

  return <span ref={textRef}>{initialText}</span>;
}

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}

function formatLiveMessageMetaNow(
  createdAt: string,
  durationStart: string,
  timestampFormat: TimestampFormat,
): string {
  return formatMessageMeta(
    createdAt,
    formatElapsed(durationStart, new Date().toISOString()),
    timestampFormat,
  );
}

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatShortTimestamp(createdAt, timestampFormat);
  return `${formatShortTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

function formatInlineWorkSummary(_groupedEntries: TimelineWorkEntry[]): string | null {
  return null;
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
