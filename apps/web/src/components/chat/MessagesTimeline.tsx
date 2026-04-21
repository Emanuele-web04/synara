// FILE: MessagesTimeline.tsx
// Purpose: Renders the chat transcript rows and lets LegendList own scrolling/follow behavior.
// Layer: Web chat presentation component
// Exports: MessagesTimeline

import { type MessageId, ThreadId, type TurnId } from "@t3tools/contracts";
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
  type RefObject,
  type ReactNode,
} from "react";
import { deriveTimelineEntries, formatElapsed } from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  GitHubIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  McpIcon,
  QueueArrow,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  ZapIcon,
} from "~/lib/icons";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { DiffStatLabel } from "./DiffStatLabel";
import { FileEntryIcon } from "./FileEntryIcon";
import { MentionChipIcon } from "./MentionChipIcon";
import { MessageCopyButton } from "./MessageCopyButton";
import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  type MessagesTimelineRow,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  type StableMessagesTimelineRowsState,
} from "./MessagesTimeline.logic";
import { deriveReadableCommandDisplay } from "../../lib/toolCallLabel";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import {
  DEFAULT_CHAT_FONT_SIZE_PX,
  normalizeChatFontSizePx,
  type TimestampFormat,
} from "../../appSettings";
import { formatShortTimestamp } from "../../timestampFormat";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { splitPromptIntoDisplaySegments } from "~/composer-editor-mentions";
import {
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_AGENT_CHIP_CLASS_NAME,
  COMPOSER_INLINE_AGENT_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_MENTION_CHIP_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_ICON_SVG,
  formatComposerSkillChipLabel,
} from "../composerInlineChip";
import { basenameOfPath } from "../../file-icons";
import { getChatTranscriptTextStyle } from "./chatTypography";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { getAppTypographyScale } from "../../lib/appTypography";
import {
  formatSubagentModelLabel,
  humanizeSubagentStatus,
  normalizeSubagentStatusKind,
  resolveSubagentPresentation,
} from "../../lib/subagentPresentation";
import { RiRobot3Line } from "react-icons/ri";
import { deriveUserMessagePreviewState } from "./userMessagePreview";

const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;
const MAX_VISIBLE_INLINE_TOOL_ENTRIES = 4;

const SkillCubeIcon: LucideIcon = (props) => (
  <svg {...props} viewBox="0 0 24 24" fill="none">
    <path
      d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="m3.3 7 8.7 5 8.7-5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M12 22V12"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const AgentTaskIcon: LucideIcon = (props) => (
  <RiRobot3Line className={props.className} style={props.style} />
);

const DEFAULT_AGENT_COLOR = { bg: "rgb(245 158 11 / 0.15)", text: "rgb(245 158 11)" };
const AGENT_COLOR_STYLES: Record<string, { bg: string; text: string }> = {
  violet: { bg: "rgb(139 92 246 / 0.15)", text: "rgb(139 92 246)" },
  fuchsia: { bg: "rgb(217 70 239 / 0.15)", text: "rgb(217 70 239)" },
  teal: { bg: "rgb(20 184 166 / 0.15)", text: "rgb(20 184 166)" },
  cyan: { bg: "rgb(6 182 212 / 0.15)", text: "rgb(6 182 212)" },
  amber: DEFAULT_AGENT_COLOR,
  orange: { bg: "rgb(249 115 22 / 0.15)", text: "rgb(249 115 22)" },
};

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

function basename(value: string): string {
  const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return slash >= 0 ? value.slice(slash + 1) : value;
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
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  nowIso?: string;
  expandedWorkGroups?: Record<string, boolean>;
  onToggleWorkGroup?: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onOpenThread?: (threadId: ThreadId) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
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
}

export const MessagesTimeline = memo(function MessagesTimeline({
  hasMessages,
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  followLiveOutput = false,
  listRef,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  nowIso,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenTurnDiff,
  onOpenThread,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
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
  const [expandedFileChangesByMessageId, setExpandedFileChangesByMessageId] = useState<
    Record<string, boolean>
  >({});
  const [expandedUserMessagesById, setExpandedUserMessagesById] = useState<Record<string, boolean>>(
    {},
  );
  const fallbackListRef = useRef<LegendListRef | null>(null);
  const resolvedListRef = listRef ?? fallbackListRef;

  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
        isWorking,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
      }),
    [
      timelineEntries,
      completionDividerBeforeEntryId,
      isWorking,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
    ],
  );
  const rows = useStableRows(rawRows);
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
  const onTimelineImageLoad = useCallback(() => {}, []);
  const previousRowCountRef = useRef(rows.length);
  useEffect(() => {
    const previousRowCount = previousRowCountRef.current;
    previousRowCountRef.current = rows.length;
    if (previousRowCount > 0 || rows.length === 0 || !followLiveOutput) {
      return;
    }
    onIsAtEndChange?.(true);
    const frameId = window.requestAnimationFrame(() => {
      void resolvedListRef.current?.scrollToEnd?.({ animated: false });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [followLiveOutput, onIsAtEndChange, resolvedListRef, rows.length]);
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
  const toggleFileChangesExpanded = useCallback((messageId: MessageId) => {
    setExpandedFileChangesByMessageId((current) => ({
      ...current,
      [messageId]: !(current[messageId] ?? true),
    }));
  }, []);

  const renderRowContent = (row: MessagesTimelineRow) => (
    <div
      className={cn(
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
                    textFontSizePx={appTypographyScale.uiSmPx}
                    density={prefersCompactWorkEntryRow(workEntry) ? "compact" : "default"}
                    {...(onOpenThread ? { onOpenThread } : {})}
                  />
                ))}
              </div>
              {showOverflowToggle && (
                <div className="mt-1.5 flex items-center justify-start gap-2 px-0.5">
                  <button
                    type="button"
                    className="font-system-ui text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
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
          const showUserText =
            userMessagePreview.text.trim().length > 0 || terminalContexts.length > 0;
          const bubbleIsChipOnly =
            showUserText &&
            terminalContexts.length === 0 &&
            hasOnlyInlineSkillChips(userMessagePreview.text);
          const canRevertAgentWork = typeof row.revertTurnCount === "number";
          const hasLeadingMedia = renderedAssistantSelections.length > 0 || userImages.length > 0;
          return (
            <div className="flex w-full justify-end">
              <div className="group flex max-w-[80%] flex-col items-end gap-px">
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
                        onTimelineImageLoad={onTimelineImageLoad}
                        resolvedTheme={resolvedTheme}
                      />
                    ))}
                  </div>
                )}
                {showUserText && (
                  <div
                    className={cn(
                      "w-max max-w-full min-w-0 self-end rounded-xl bg-secondary px-3.5",
                      bubbleIsChipOnly ? "py-1" : "pt-[5px] pb-[7px]",
                    )}
                  >
                    <UserMessageBody
                      text={userMessagePreview.text}
                      terminalContexts={terminalContexts}
                      chatTypographyStyle={chatTypographyStyle}
                      resolvedTheme={resolvedTheme}
                    />
                  </div>
                )}
                {userMessagePreview.collapsible && (
                  <button
                    type="button"
                    className="pr-0.5 text-right text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/72"
                    style={{ fontSize: `${normalizedChatFontSizePx}px` }}
                    onClick={() => {
                      setExpandedUserMessagesById((previous) => ({
                        ...previous,
                        [row.message.id]: !(previous[row.message.id] ?? false),
                      }));
                    }}
                  >
                    {(expandedUserMessagesById[row.message.id] ?? false)
                      ? "Show less"
                      : "Show more"}
                  </button>
                )}
                <div className="flex items-center justify-end gap-1.5 pr-0.5">
                  <div className="flex items-center gap-1 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                    {displayedUserMessage.copyText && (
                      <MessageCopyButton text={displayedUserMessage.copyText} />
                    )}
                    {canRevertAgentWork && (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        className="size-auto rounded-none border-0 bg-transparent p-0 text-muted-foreground/55 shadow-none hover:bg-transparent hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
                        disabled={isRevertingCheckpoint || isWorking}
                        onClick={() => onRevertUserMessage(row.message.id)}
                        title="Revert to this message"
                        aria-label="Revert to this message"
                      >
                        <Undo2Icon className="size-3" />
                      </Button>
                    )}
                  </div>
                  <p
                    className="font-chat-code text-right text-muted-foreground/45"
                    style={{ fontSize: `${appTypographyScale.uiTimestampPx}px` }}
                  >
                    {formatShortTimestamp(row.message.createdAt, timestampFormat)}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        (() => {
          const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
          const inlineToolEntries = hasOnlyToolToneEntries(row.inlineWorkEntries)
            ? row.inlineWorkEntries
            : [];
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
            inlineToolEntries.length > 0
              ? null
              : formatInlineWorkSummary(row.inlineWorkEntries ?? []);
          const assistantCopyState = resolveAssistantMessageCopyState({
            text: row.message.text ?? null,
            showCopyButton: row.showAssistantCopyButton,
            streaming: row.message.streaming,
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
          return (
            <>
              {row.showCompletionDivider && (
                <div className="my-3 flex items-center gap-3">
                  <span className="h-px flex-1 bg-border" />
                  <span
                    className="text-muted-foreground/80"
                    style={{ fontSize: chatTypographyStyle.fontSize }}
                  >
                    {completionSummary ? `Response • ${completionSummary}` : "Response"}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              <div className="min-w-0 px-1 py-0.5">
                <div data-assistant-message-id={row.message.id}>
                  <ChatMarkdown
                    text={messageText}
                    cwd={markdownCwd}
                    isStreaming={Boolean(row.message.streaming)}
                    style={chatTypographyStyle}
                  />
                </div>
                {visibleRenderableInlineToolEntries.length > 0 && (
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
                            className="text-muted-foreground/50 transition-colors duration-150 hover:text-foreground/72"
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
                {inlineEditedFilesFromTurnSummary.length > 0 && (
                  <div className="mt-2 space-y-0.5">
                    {inlineEditedFilesFromTurnSummary.map((file) => (
                      <button
                        key={`inline-summary-edit:${row.message.id}:${file.path}`}
                        type="button"
                        className="group flex w-full max-w-full items-baseline gap-1 px-0 py-[1px] text-left transition-opacity duration-150 hover:opacity-95"
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
                          className="font-system-ui max-w-[28rem] truncate group-hover:opacity-90"
                          style={{
                            fontSize: `${normalizedChatFontSizePx}px`,
                            color: "var(--info-foreground)",
                          }}
                        >
                          {basename(file.path)}
                        </span>
                        {(file.additions ?? 0) + (file.deletions ?? 0) > 0 ? (
                          <span
                            className="font-chat-code shrink-0 tabular-nums whitespace-nowrap"
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
                {(() => {
                  if (!turnSummary) return null;
                  const checkpointFiles = turnSummary.files;
                  if (checkpointFiles.length === 0) return null;
                  const fileChangesExpanded =
                    expandedFileChangesByMessageId[row.message.id] ?? true;
                  const correspondingUserMessageId = userMessageIdByAssistantMessageId.get(
                    row.message.id,
                  );
                  const canUndo =
                    correspondingUserMessageId != null &&
                    revertTurnCountByUserMessageId.has(correspondingUserMessageId);
                  return (
                    <div className="mt-5 overflow-hidden rounded-lg border border-border bg-neutral-50 dark:bg-neutral-900">
                      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                        <span
                          className="truncate font-normal text-foreground"
                          style={{ fontSize: chatTypographyStyle.fontSize }}
                        >
                          {checkpointFiles.length === 1
                            ? "1 File changed"
                            : `${checkpointFiles.length} Files changed`}
                        </span>
                        <div className="flex items-center gap-4">
                          <button
                            type="button"
                            className="inline-flex items-center justify-center rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-background/60 hover:text-foreground/80"
                            aria-expanded={fileChangesExpanded}
                            aria-label={
                              fileChangesExpanded
                                ? "Collapse changed files list"
                                : "Expand changed files list"
                            }
                            onClick={() => toggleFileChangesExpanded(row.message.id)}
                          >
                            <DisclosureChevron
                              open={fileChangesExpanded}
                              className="dark:text-muted-foreground/50"
                            />
                          </button>
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
                        </div>
                      </div>
                      <div
                        className={cn(
                          "grid transition-[grid-template-rows,opacity] duration-220 ease-out",
                          fileChangesExpanded
                            ? "grid-rows-[1fr] opacity-100"
                            : "grid-rows-[0fr] opacity-0",
                        )}
                      >
                        <div
                          className={cn(
                            "min-h-0 overflow-hidden transition-transform duration-220 ease-out",
                            fileChangesExpanded
                              ? "translate-y-0"
                              : "-translate-y-1 pointer-events-none",
                          )}
                        >
                          <div className="bg-neutral-100 dark:bg-neutral-800/40">
                            {checkpointFiles.map((file) => (
                              <button
                                key={file.path}
                                type="button"
                                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/60"
                                onClick={() => onOpenTurnDiff(turnSummary.turnId, file.path)}
                              >
                                <FileEntryIcon
                                  pathValue={file.path}
                                  kind="file"
                                  theme={resolvedTheme}
                                  className="size-4 shrink-0 opacity-50 dark:opacity-30"
                                />
                                <span
                                  className="font-chat-code truncate font-normal text-neutral-900 dark:text-foreground dark:hover:text-foreground"
                                  style={{ fontSize: `${appTypographyScale.chatCodePx}px` }}
                                >
                                  {file.path}
                                </span>
                                {(file.additions ?? 0) + (file.deletions ?? 0) > 0 && (
                                  <span
                                    className="font-chat-code ml-auto shrink-0 tabular-nums"
                                    style={{ fontSize: `${appTypographyScale.chatMetaPx}px` }}
                                  >
                                    <DiffStatLabel
                                      additions={file.additions ?? 0}
                                      deletions={file.deletions ?? 0}
                                    />
                                  </span>
                                )}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}
                <div className="mt-0.5 flex items-center gap-2">
                  <p
                    className="font-chat-code text-muted-foreground/45"
                    style={{ fontSize: `${appTypographyScale.uiTimestampPx}px` }}
                  >
                    {assistantMeta}
                  </p>
                  {assistantCopyState.visible ? (
                    <div className="flex items-center opacity-0 transition-opacity duration-200 group-hover/assistant:opacity-100 focus-within:opacity-100">
                      <MessageCopyButton
                        text={assistantCopyState.text ?? ""}
                        size="icon-xs"
                        variant="outline"
                        className="border-border/50 bg-background/35 text-muted-foreground/45 shadow-none hover:border-border/70 hover:bg-background/55 hover:text-muted-foreground/70"
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          );
        })()}

      {row.kind === "proposed-plan" && (
        <div className="min-w-0 px-1 py-0.5">
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
          className="flex items-center gap-1 pt-1 pl-1 text-muted-foreground/70 font-system-ui"
          style={{ fontSize: `${appTypographyScale.uiSmPx}px` }}
        >
          <span>
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
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
            <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
            <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
          </span>
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
        <p className="text-sm text-muted-foreground/30">
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
      renderItem={({ item }) => (
        <div
          data-timeline-root="true"
          className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden"
        >
          {renderRowContent(item)}
        </div>
      )}
      estimatedItemSize={90}
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
      className="h-full overflow-x-hidden overscroll-y-contain px-3 py-3 sm:px-5 sm:py-4"
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
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [createdAt]);
  return <>{formatWorkingTimer(createdAt, new Date(nowMs).toISOString()) ?? "0s"}</>;
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
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [durationStart]);

  return (
    <>
      {formatMessageMeta(
        createdAt,
        formatElapsed(durationStart, new Date(nowMs).toISOString()),
        timestampFormat,
      )}
    </>
  );
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

function hasOnlyToolToneEntries<T extends { tone: TimelineWorkEntry["tone"] }>(
  entries: ReadonlyArray<T> | undefined,
): entries is ReadonlyArray<T> {
  if (!entries || entries.length === 0) {
    return false;
  }
  return entries.every((entry) => entry.tone === "tool");
}

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageInlineSkillChip = memo(function UserMessageInlineSkillChip(props: {
  skillName: string;
}) {
  return (
    <span className={COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME}>
      <span
        aria-hidden="true"
        className={COMPOSER_INLINE_SKILL_CHIP_ICON_CLASS_NAME}
        dangerouslySetInnerHTML={{ __html: COMPOSER_INLINE_SKILL_CHIP_ICON_SVG }}
      />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>
        {formatComposerSkillChipLabel(props.skillName)}
      </span>
    </span>
  );
});

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

// Renders read-only user text with the same inline skill pill treatment as the composer.
function renderUserMessageInlineText(
  text: string,
  keyPrefix: string,
  resolvedTheme: "light" | "dark",
): ReactNode[] {
  return splitPromptIntoDisplaySegments(text).flatMap((segment, index) => {
    const key = `${keyPrefix}:${index}`;
    if (segment.type === "text") {
      return segment.text.length > 0 ? [<span key={`${key}:text`}>{segment.text}</span>] : [];
    }
    if (segment.type === "skill") {
      return [<UserMessageInlineSkillChip key={`${key}:skill`} skillName={segment.name} />];
    }
    if (segment.type === "mention") {
      return [
        <UserMessageInlineMentionChip
          key={`${key}:mention`}
          path={segment.path}
          resolvedTheme={resolvedTheme}
        />,
      ];
    }
    if (segment.type === "agent-mention") {
      return [
        <UserMessageInlineAgentChip
          key={`${key}:agent`}
          alias={segment.alias}
          color={segment.color}
        />,
      ];
    }
    return [];
  });
}

const UserMessageInlineMentionChip = memo(function UserMessageInlineMentionChip(props: {
  path: string;
  resolvedTheme: "light" | "dark";
}) {
  const label = basenameOfPath(props.path);
  return (
    <span className={COMPOSER_INLINE_MENTION_CHIP_CLASS_NAME} title={props.path}>
      <MentionChipIcon path={props.path} theme={props.resolvedTheme} />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
    </span>
  );
});

function hasOnlyInlineSkillChips(text: string): boolean {
  const segments = splitPromptIntoDisplaySegments(text);
  let skillCount = 0;

  for (const segment of segments) {
    if (segment.type === "skill") {
      skillCount += 1;
      continue;
    }
    if (segment.type === "text" && segment.text.trim().length === 0) {
      continue;
    }
    return false;
  }

  return skillCount > 0;
}

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  chatTypographyStyle: CSSProperties;
  resolvedTheme: "light" | "dark";
}) {
  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            ...renderUserMessageInlineText(
              props.text.slice(cursor, matchIndex),
              `user-terminal-context-inline-before:${context.header}:${cursor}`,
              props.resolvedTheme,
            ),
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            ...renderUserMessageInlineText(
              props.text.slice(cursor),
              `user-message-terminal-context-inline-rest:${cursor}`,
              props.resolvedTheme,
            ),
          );
        }

        return (
          <div
            className="inline-block max-w-full min-w-0 wrap-break-word whitespace-pre-wrap font-system-ui text-foreground"
            style={props.chatTypographyStyle}
          >
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(
        ...renderUserMessageInlineText(
          props.text,
          "user-message-terminal-context-inline-text",
          props.resolvedTheme,
        ),
      );
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div
        className="inline-block max-w-full min-w-0 wrap-break-word whitespace-pre-wrap font-system-ui text-foreground"
        style={props.chatTypographyStyle}
      >
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  if (props.terminalContexts.length === 0 && hasOnlyInlineSkillChips(props.text)) {
    return (
      <div
        className="flex max-w-full min-w-0 items-center leading-none text-foreground [&>span]:translate-y-0"
        style={props.chatTypographyStyle}
      >
        {renderUserMessageInlineText(
          props.text,
          "user-message-inline-chip-only",
          props.resolvedTheme,
        )}
      </div>
    );
  }

  return (
    <div
      className="inline-block max-w-full min-w-0 whitespace-pre-wrap break-words font-system-ui text-foreground"
      style={props.chatTypographyStyle}
    >
      {renderUserMessageInlineText(props.text, "user-message-inline", props.resolvedTheme)}
    </div>
  );
});

const UserMessageInlineAgentChip = memo(function UserMessageInlineAgentChip(props: {
  alias: string;
  color: string;
}) {
  const colors = AGENT_COLOR_STYLES[props.color] ?? DEFAULT_AGENT_COLOR;

  return (
    <span
      className={COMPOSER_INLINE_AGENT_CHIP_CLASS_NAME}
      style={{
        backgroundColor: colors.bg,
        color: colors.text,
      }}
    >
      <RiRobot3Line className={COMPOSER_INLINE_AGENT_CHIP_ICON_CLASS_NAME} />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{`@${props.alias}`}</span>
    </span>
  );
});

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-muted-foreground/50",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-muted-foreground/40",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-muted-foreground/50",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-muted-foreground/45",
  };
}

/**
 * Try to extract a clean file path from a detail string that may contain JSON.
 * Handles patterns like:
 *   Read {"file_path":"/Users/foo/bar.ts","offset":10}
 *   {"file_path":"/path/to/file.ts"}
 */
function extractFilePathFromDetail(detail: string): string | null {
  // Try to find a JSON-like object in the detail
  const jsonStart = detail.indexOf("{");
  if (jsonStart < 0) return null;
  const jsonEnd = detail.lastIndexOf("}");
  if (jsonEnd <= jsonStart) return null;
  try {
    const parsed = JSON.parse(detail.slice(jsonStart, jsonEnd + 1));
    const filePath = parsed.file_path ?? parsed.filePath ?? parsed.path ?? parsed.filename ?? null;
    if (typeof filePath === "string" && filePath.trim().length > 0) {
      return filePath.trim();
    }
  } catch {
    // Not valid JSON — try regex fallback
    const match = /"(?:file_path|filePath|path|filename)"\s*:\s*"([^"]+)"/i.exec(detail);
    if (match?.[1]) return match[1];
  }
  return null;
}

function workEntryPreview(
  workEntry: Pick<
    TimelineWorkEntry,
    | "detail"
    | "command"
    | "changedFiles"
    | "requestKind"
    | "itemType"
    | "subagents"
    | "subagentAction"
  >,
): string | null {
  const isFileRelated =
    workEntry.requestKind === "file-read" ||
    workEntry.requestKind === "file-change" ||
    workEntry.itemType === "file_change";

  // Prefer clean basenames from changedFiles
  if (workEntry.changedFiles && workEntry.changedFiles.length > 0) {
    const names = workEntry.changedFiles.map((p) => basename(p));
    if (names.length === 1) return names[0]!;
    return `${names.length} files`;
  }

  // Command rows stay human-readable inline and keep the raw invocation for hover details.
  if (workEntry.command) return deriveReadableCommandDisplay(workEntry.command).target;

  if (workEntry.itemType === "collab_agent_tool_call" && (workEntry.subagents?.length ?? 0) > 0) {
    if (workEntry.subagentAction?.summaryText) {
      return workEntry.subagentAction.summaryText;
    }
    const labels = workEntry.subagents!.map((subagent) => {
      const presentation = subagentPrimaryLabel(subagent);
      return presentation.nickname ?? presentation.primaryLabel ?? basename(subagent.threadId);
    });
    return labels.length === 1 ? labels[0]! : `${labels.length} subagents`;
  }

  // For detail, try to extract a clean file path first
  if (workEntry.detail) {
    const filePath = extractFilePathFromDetail(workEntry.detail);
    if (filePath) return basename(filePath);

    // For file-related entries, the heading alone is enough — don't show raw JSON
    if (isFileRelated) return null;

    // For other entries, if the detail looks like raw JSON, skip it
    const trimmedDetail = workEntry.detail.trim();
    if (trimmedDetail.startsWith("{") || trimmedDetail.startsWith("[")) return null;

    // Clean, non-JSON detail — show it
    return trimmedDetail;
  }

  return null;
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return TerminalIcon;
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return SkillCubeIcon;
    case "dynamic_tool_call":
      return HammerIcon;
    case "collab_agent_tool_call":
      return AgentTaskIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

function isGitHubMcpToolCall(workEntry: TimelineWorkEntry): boolean {
  const toolName = workEntry.toolName?.trim().toLowerCase();
  return Boolean(toolName?.startsWith("mcp__codex_apps__github"));
}

// Keep command, agent-task, and file-change rows visually compact so their icon can trail the label.
function prefersCompactWorkEntryRow(workEntry: TimelineWorkEntry): boolean {
  const EntryIcon = workEntryIcon(workEntry);
  return (
    EntryIcon === TerminalIcon ||
    EntryIcon === HammerIcon ||
    EntryIcon === AgentTaskIcon ||
    EntryIcon === SquarePenIcon ||
    EntryIcon === SkillCubeIcon
  );
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

function isFileChangeWorkEntry(workEntry: TimelineWorkEntry): boolean {
  return (
    workEntry.requestKind === "file-change" ||
    workEntry.itemType === "file_change" ||
    (workEntry.changedFiles?.length ?? 0) > 0
  );
}

function subagentPrimaryLabel(
  subagent: NonNullable<TimelineWorkEntry["subagents"]>[number],
): ReturnType<typeof resolveSubagentPresentation> {
  return resolveSubagentPresentation({
    nickname: subagent.nickname,
    role: subagent.role,
    title: subagent.title,
    fallbackId: subagent.threadId,
  });
}

function subagentSecondaryLabel(
  subagent: NonNullable<TimelineWorkEntry["subagents"]>[number],
  primaryLabel: string,
): string | null {
  const parts = [subagent.title, formatSubagentModelLabel(subagent.model)]
    .filter((value): value is string => Boolean(value))
    .filter((value) => value !== primaryLabel);
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" • ");
}

function subagentStatusClasses(
  statusLabel: string | undefined,
  rawStatus: string | undefined,
  isActive: boolean | undefined,
): string {
  switch (normalizeSubagentStatusKind(statusLabel ?? rawStatus, isActive)) {
    case "running":
      return "border-sky-500/18 bg-sky-500/8 text-sky-200/90";
    case "completed":
      return "border-emerald-500/18 bg-emerald-500/8 text-emerald-200/90";
    case "failed":
      return "border-rose-500/18 bg-rose-500/8 text-rose-200/90";
    case "stopped":
      return "border-amber-500/18 bg-amber-500/8 text-amber-200/90";
    case "queued":
      return "border-violet-500/18 bg-violet-500/8 text-violet-200/90";
    case "idle":
    default:
      return "border-border/45 bg-background/85 text-muted-foreground/68";
  }
}

function subagentCardSummary(workEntry: TimelineWorkEntry): string {
  return (
    workEntry.subagentAction?.summaryText ??
    workEntryPreview(workEntry) ??
    toolWorkEntryHeading(workEntry)
  );
}

function subagentCardMeta(workEntry: TimelineWorkEntry): string | null {
  const modelLabel = formatSubagentModelLabel(workEntry.subagentAction?.model);
  if (modelLabel && workEntry.subagentAction?.prompt) {
    return `${modelLabel} • ${workEntry.subagentAction.prompt}`;
  }
  return modelLabel ?? workEntry.subagentAction?.prompt ?? null;
}

function commandTooltipContent(command: string, displayText: string) {
  return (
    <div className="max-w-96 whitespace-pre-wrap leading-tight">
      <div className="space-y-2">
        <div className="space-y-0.5">
          <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
            Summary
          </div>
          <div>{displayText}</div>
        </div>
        <div className="space-y-0.5">
          <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
            Raw call
          </div>
          <code className="block whitespace-pre-wrap break-words font-chat-code text-[11px] text-foreground/92">
            {command}
          </code>
        </div>
      </div>
    </div>
  );
}

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  chatMetaFontSizePx: number;
  textFontSizePx?: number;
  density?: "default" | "compact";
  fileDiffStatByPath?: ReadonlyMap<string, { additions: number; deletions: number }>;
  turnId?: TurnId;
  onOpenTurnDiff?: (turnId: TurnId, filePath?: string) => void;
  onOpenThread?: (threadId: ThreadId) => void;
}) {
  const {
    workEntry,
    chatMetaFontSizePx,
    textFontSizePx = chatMetaFontSizePx,
    density = "default",
    fileDiffStatByPath,
    turnId,
    onOpenTurnDiff,
    onOpenThread,
  } = props;
  const compact = density === "compact";
  const EntryIcon = workEntryIcon(workEntry);
  const usesTrailingCompactIcon =
    EntryIcon === TerminalIcon || EntryIcon === HammerIcon || EntryIcon === AgentTaskIcon;
  const showIconRight = compact && usesTrailingCompactIcon;
  const showIconLeft = !compact;
  const showInlineWebSearchIcon = compact && workEntry.itemType === "web_search";
  const showInlineGitHubIcon = compact && isGitHubMcpToolCall(workEntry);
  const showInlineMcpIcon =
    compact && workEntry.itemType === "mcp_tool_call" && !showInlineGitHubIcon;
  const heading = toolWorkEntryHeading(workEntry);
  const preview = workEntryPreview(workEntry);
  const displayText = preview ? `${heading} ${preview}` : heading;
  const hoverText = workEntry.command ?? displayText;
  const changedFiles = workEntry.changedFiles ?? [];
  const showEditedRows = isFileChangeWorkEntry(workEntry) && changedFiles.length > 0;
  const showSubagentRows =
    workEntry.itemType === "collab_agent_tool_call" &&
    ((workEntry.subagents?.length ?? 0) > 0 || Boolean(workEntry.subagentAction));
  const visibleSubagents = workEntry.subagents?.slice(0, 3) ?? [];
  const hiddenSubagentCount = Math.max(
    0,
    (workEntry.subagents?.length ?? 0) - visibleSubagents.length,
  );
  const subagentSummary = subagentCardSummary(workEntry);
  const subagentMeta = subagentCardMeta(workEntry);

  // Use the text font size (matching the UI settings) for tool call rows
  const rowFontSizePx = textFontSizePx;

  return (
    <div className={cn(compact ? "py-0.5" : "rounded-lg py-1")}>
      {showEditedRows ? (
        <div className="space-y-0.5">
          {changedFiles.map((changedFilePath) => {
            const changedFileStat = fileDiffStatByPath?.get(changedFilePath);
            const canOpenEditedDiff = Boolean(turnId && onOpenTurnDiff);
            return (
              <button
                key={`${workEntry.id}:${changedFilePath}`}
                type="button"
                className={cn(
                  "group flex w-full max-w-full items-baseline gap-1 text-left transition-opacity duration-150",
                  compact
                    ? "px-0 py-[1px] hover:opacity-95"
                    : "rounded-md border border-border/45 bg-background/65 px-2 py-1 hover:bg-background/80",
                  canOpenEditedDiff ? "cursor-pointer" : "cursor-default",
                )}
                title={changedFilePath}
                disabled={!canOpenEditedDiff}
                onClick={() => {
                  if (!turnId || !onOpenTurnDiff) return;
                  onOpenTurnDiff(turnId, changedFilePath);
                }}
              >
                <span
                  className="font-system-ui shrink-0 text-muted-foreground/60"
                  style={{ fontSize: `${rowFontSizePx}px` }}
                >
                  Edited
                </span>
                <span
                  className="font-system-ui max-w-[28rem] truncate group-hover:opacity-90"
                  style={{
                    fontSize: `${rowFontSizePx}px`,
                    color: "var(--info-foreground)",
                  }}
                >
                  {basename(changedFilePath)}
                </span>
                {changedFileStat ? (
                  <span
                    className="font-chat-code shrink-0 tabular-nums whitespace-nowrap"
                    style={{ fontSize: `${rowFontSizePx}px` }}
                  >
                    <DiffStatLabel
                      additions={changedFileStat.additions}
                      deletions={changedFileStat.deletions}
                    />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : showSubagentRows ? (
        <div className="space-y-1.5">
          <div
            className={cn(
              "flex items-center transition-[opacity,translate] duration-200",
              compact ? "gap-1.5" : "gap-2",
            )}
          >
            <span
              className={cn(
                "flex shrink-0 items-center justify-center text-muted-foreground/40",
                compact ? "size-4" : "size-5",
              )}
            >
              <EntryIcon className={compact ? "size-2.5" : "size-3"} />
            </span>
            <div className="min-w-0 flex-1 overflow-hidden">
              <p
                className={cn(
                  compact ? "truncate leading-5" : "truncate leading-6",
                  "font-medium text-foreground/72",
                )}
                style={{ fontSize: `${rowFontSizePx}px` }}
                title={hoverText}
              >
                <span>{subagentSummary}</span>
              </p>
              {subagentMeta ? (
                <p
                  className="truncate leading-4 text-muted-foreground/32"
                  style={{ fontSize: `${Math.max(11, rowFontSizePx - 1)}px` }}
                  title={subagentMeta}
                >
                  {subagentMeta}
                </p>
              ) : null}
            </div>
          </div>
          {visibleSubagents.length > 0 || hiddenSubagentCount > 0 ? (
            <div
              className={cn(
                "space-y-[5px] rounded-[14px] border border-border/45 bg-background/50 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]",
                compact ? "px-2.5 py-2" : "px-3 py-[9px]",
              )}
            >
              {visibleSubagents.map((subagent) => {
                const presentation = subagentPrimaryLabel(subagent);
                const primaryLabel = presentation.primaryLabel;
                const secondaryLabel = subagentSecondaryLabel(subagent, primaryLabel);
                const displayStatusLabel =
                  subagent.statusLabel ??
                  humanizeSubagentStatus(subagent.rawStatus, subagent.isActive);
                const canOpenThread = Boolean(onOpenThread);
                return (
                  <div
                    key={`${workEntry.id}:${subagent.threadId}`}
                    className="flex items-start gap-2.5 rounded-xl border border-border/28 bg-background/82 px-[11px] py-2"
                  >
                    <span
                      className={cn(
                        "mt-1.5 size-1.5 shrink-0 rounded-full",
                        subagent.isActive ? "bg-sky-300/95" : "bg-muted-foreground/22",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate font-semibold leading-[18px] text-foreground/90"
                        style={{ fontSize: `${rowFontSizePx}px` }}
                        title={presentation.fullLabel}
                      >
                        <span style={{ color: presentation.accentColor }}>
                          {presentation.nickname ?? primaryLabel}
                        </span>
                        {presentation.role ? (
                          <span className="ml-1 text-[11px] font-medium text-muted-foreground/48">
                            ({presentation.role})
                          </span>
                        ) : null}
                      </div>
                      {secondaryLabel ? (
                        <div
                          className="truncate pt-0.5 leading-4 text-muted-foreground/56"
                          style={{ fontSize: `${Math.max(11, rowFontSizePx - 1)}px` }}
                          title={secondaryLabel}
                        >
                          {secondaryLabel}
                        </div>
                      ) : null}
                      {subagent.latestUpdate ? (
                        <div
                          className="flex items-baseline gap-1.5 pt-1 text-muted-foreground/42"
                          style={{ fontSize: `${Math.max(10, rowFontSizePx - 2)}px` }}
                          title={subagent.latestUpdate}
                        >
                          <span className="shrink-0 uppercase tracking-[0.14em] text-muted-foreground/30">
                            Latest
                          </span>
                          <span className="truncate">{subagent.latestUpdate}</span>
                        </div>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {displayStatusLabel ? (
                        <span
                          className={cn(
                            "shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-medium tracking-[0.08em]",
                            subagentStatusClasses(
                              displayStatusLabel,
                              subagent.rawStatus,
                              subagent.isActive,
                            ),
                          )}
                        >
                          {displayStatusLabel}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className={cn(
                          "shrink-0 rounded-full border border-border/45 px-2.5 py-1 text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground/62 transition-colors",
                          canOpenThread
                            ? "hover:border-foreground/15 hover:text-foreground/84"
                            : "cursor-default opacity-50",
                        )}
                        disabled={!canOpenThread}
                        onClick={() =>
                          onOpenThread?.(
                            ThreadId.makeUnsafe(subagent.resolvedThreadId ?? subagent.threadId),
                          )
                        }
                      >
                        Open thread
                      </button>
                    </div>
                  </div>
                );
              })}
              {hiddenSubagentCount > 0 ? (
                <div className="pl-4 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/46">
                  +{hiddenSubagentCount} more
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        (() => {
          const rowContent = (
            <div
              className={cn(
                "flex items-center transition-[opacity,translate] duration-200",
                compact ? "gap-1.5" : "gap-2",
              )}
              title={hoverText}
            >
              {showIconLeft && (
                <span
                  className={cn(
                    "flex shrink-0 items-center justify-center text-muted-foreground/40",
                    compact ? "size-4" : "size-5",
                  )}
                >
                  <EntryIcon className={compact ? "size-2.5" : "size-3"} />
                </span>
              )}
              <div className="min-w-0 flex-1 overflow-hidden">
                <p
                  className={cn(
                    compact ? "truncate leading-5" : "truncate leading-6",
                    "text-muted-foreground/50",
                  )}
                  style={{ fontSize: `${rowFontSizePx}px` }}
                >
                  {showInlineWebSearchIcon || showInlineGitHubIcon || showInlineMcpIcon ? (
                    <span
                      className="mr-1 inline-flex align-[-0.125em] text-muted-foreground/38"
                      data-inline-tool-icon={
                        showInlineGitHubIcon ? "github" : showInlineMcpIcon ? "mcp" : "web-search"
                      }
                    >
                      {showInlineGitHubIcon ? (
                        <GitHubIcon
                          style={{
                            width: `${rowFontSizePx}px`,
                            height: `${rowFontSizePx}px`,
                          }}
                        />
                      ) : null}
                      {showInlineMcpIcon ? (
                        <McpIcon
                          style={{
                            width: `${rowFontSizePx}px`,
                            height: `${rowFontSizePx}px`,
                          }}
                        />
                      ) : null}
                      {showInlineWebSearchIcon ? (
                        <GlobeIcon
                          style={{
                            width: `${rowFontSizePx}px`,
                            height: `${rowFontSizePx}px`,
                          }}
                        />
                      ) : null}
                    </span>
                  ) : null}
                  <span className="text-muted-foreground/50">{heading}</span>
                  {preview && <span className="text-muted-foreground/25"> {preview}</span>}
                </p>
              </div>
              {showIconRight && (
                <span
                  className="flex shrink-0 items-center justify-center text-muted-foreground/40"
                  style={{ width: rowFontSizePx, height: rowFontSizePx }}
                >
                  <EntryIcon style={{ width: rowFontSizePx, height: rowFontSizePx }} />
                </span>
              )}
            </div>
          );

          if (!workEntry.command) {
            return rowContent;
          }

          return (
            <Tooltip>
              <TooltipTrigger render={rowContent} />
              <TooltipPopup side="top" align="start" className="max-w-96 whitespace-normal">
                {commandTooltipContent(workEntry.command, displayText)}
              </TooltipPopup>
            </Tooltip>
          );
        })()
      )}
    </div>
  );
});
