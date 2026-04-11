// FILE: MessagesTimeline.tsx
// Purpose: Renders the virtualized chat transcript, including user bubbles, assistant markdown, and work logs.
// Layer: Web chat presentation component
// Exports: MessagesTimeline

import { type MessageId, type TurnId } from "@t3tools/contracts";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  measureElement as measureVirtualElement,
  type VirtualItem,
  useVirtualizer,
} from "@tanstack/react-virtual";
import { deriveTimelineEntries, formatElapsed } from "../../session-logic";
import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX } from "../../chat-scroll";
import { type TurnDiffSummary } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "~/lib/icons";
import { Button } from "../ui/button";
import { clamp } from "effect/Number";
import { estimateTimelineMessageHeight, estimateTimelineWorkGroupHeight } from "../timelineHeight";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { DiffStatLabel } from "./DiffStatLabel";
import { VscodeEntryIcon } from "./VscodeEntryIcon";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  computeMessageDurationStart,
  deriveTerminalAssistantMessageIds,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
} from "./MessagesTimeline.logic";
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
  COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_ICON_SVG,
  formatComposerSkillChipLabel,
} from "../composerInlineChip";
import { getChatTranscriptLineHeightPx, getChatTranscriptTextStyle } from "./chatTypography";

const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;
const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;

interface MessagesTimelineProps {
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  emptyStateContent?: ReactNode;
  scrollContainer: HTMLDivElement | null;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  nowIso: string;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onTimelineHeightChange?: () => void;
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
  scrollContainer,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  nowIso,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  onTimelineHeightChange,
  markdownCwd,
  resolvedTheme,
  chatFontSizePx = DEFAULT_CHAT_FONT_SIZE_PX,
  timestampFormat,
  workspaceRoot,
  emptyStateContent,
}: MessagesTimelineProps) {
  const normalizedChatFontSizePx = normalizeChatFontSizePx(chatFontSizePx);
  const chatTypographyStyle = useMemo(
    () => getChatTranscriptTextStyle(normalizedChatFontSizePx),
    [normalizedChatFontSizePx],
  );
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const [timelineWidthPx, setTimelineWidthPx] = useState<number | null>(null);

  useLayoutEffect(() => {
    const timelineRoot = timelineRootRef.current;
    if (!timelineRoot) return;

    let lastHeight = -1;
    const syncRootSize = () => {
      const { width: nextWidth, height: nextHeight } = timelineRoot.getBoundingClientRect();
      setTimelineWidthPx((previousWidth) => {
        if (previousWidth !== null && Math.abs(previousWidth - nextWidth) < 0.5) {
          return previousWidth;
        }
        return nextWidth;
      });

      // Notify ChatView when async row measurement changes the rendered height so
      // stick-to-bottom can settle again after images or virtual rows expand.
      const heightChanged = lastHeight >= 0 && Math.abs(nextHeight - lastHeight) >= 0.5;
      lastHeight = nextHeight;
      if (heightChanged) {
        onTimelineHeightChange?.();
      }
    };

    syncRootSize();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      syncRootSize();
    });
    observer.observe(timelineRoot);
    return () => {
      observer.disconnect();
    };
  }, [hasMessages, isWorking, onTimelineHeightChange]);

  const rows = useMemo<TimelineRow[]>(() => {
    const nextRows: TimelineRow[] = [];
    const timelineMessages = timelineEntries.flatMap((entry) =>
      entry.kind === "message" ? [entry.message] : [],
    );
    const durationStartByMessageId = computeMessageDurationStart(timelineMessages);
    const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(timelineMessages);
    let pendingWorkGroup: Extract<TimelineRow, { kind: "work" }> | null = null;

    const appendWorkEntriesToPreviousAssistant = (groupedEntries: TimelineWorkEntry[]): boolean => {
      const previousRow = nextRows.at(-1);
      if (
        !previousRow ||
        previousRow.kind !== "message" ||
        previousRow.message.role !== "assistant"
      ) {
        return false;
      }

      previousRow.inlineWorkEntries = [...(previousRow.inlineWorkEntries ?? []), ...groupedEntries];
      return true;
    };

    const flushPendingWorkGroup = () => {
      if (!pendingWorkGroup) return;
      if (!appendWorkEntriesToPreviousAssistant(pendingWorkGroup.groupedEntries)) {
        nextRows.push(pendingWorkGroup);
      }
      pendingWorkGroup = null;
    };

    for (let index = 0; index < timelineEntries.length; index += 1) {
      const timelineEntry = timelineEntries[index];
      if (!timelineEntry) {
        continue;
      }

      if (timelineEntry.kind === "work") {
        const groupedEntries = [timelineEntry.entry];
        let cursor = index + 1;
        while (cursor < timelineEntries.length) {
          const nextEntry = timelineEntries[cursor];
          if (!nextEntry || nextEntry.kind !== "work") break;
          groupedEntries.push(nextEntry.entry);
          cursor += 1;
        }
        flushPendingWorkGroup();
        pendingWorkGroup = {
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries,
        };
        index = cursor - 1;
        continue;
      }

      if (timelineEntry.kind === "proposed-plan") {
        flushPendingWorkGroup();
        nextRows.push({
          kind: "proposed-plan",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          proposedPlan: timelineEntry.proposedPlan,
        });
        continue;
      }

      const inlineWorkEntries =
        timelineEntry.message.role === "assistant" ? pendingWorkGroup?.groupedEntries : undefined;
      if (timelineEntry.message.role === "assistant") {
        pendingWorkGroup = null;
      } else {
        flushPendingWorkGroup();
      }

      nextRows.push({
        kind: "message",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        message: timelineEntry.message,
        inlineWorkEntries,
        durationStart:
          durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
        showCompletionDivider:
          timelineEntry.message.role === "assistant" &&
          completionDividerBeforeEntryId === timelineEntry.id,
        showAssistantCopyButton:
          timelineEntry.message.role === "assistant" &&
          terminalAssistantMessageIds.has(timelineEntry.message.id),
      });
    }

    flushPendingWorkGroup();

    if (isWorking) {
      nextRows.push({
        kind: "working",
        id: "working-indicator-row",
        createdAt: activeTurnStartedAt,
      });
    }

    return nextRows;
  }, [timelineEntries, completionDividerBeforeEntryId, isWorking, activeTurnStartedAt]);

  const firstUnvirtualizedRowIndex = useMemo(() => {
    const firstTailRowIndex = Math.max(rows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS, 0);
    if (!activeTurnInProgress) return firstTailRowIndex;

    // We intentionally keep a small live tail outside virtualization so the
    // currently active turn can expand without the user seeing rows jump in and
    // out of measurement. If this area ever becomes the next perf bottleneck,
    // this is the pivot point to shrink first.
    const turnStartedAtMs =
      typeof activeTurnStartedAt === "string" ? Date.parse(activeTurnStartedAt) : Number.NaN;
    let firstCurrentTurnRowIndex = -1;
    if (!Number.isNaN(turnStartedAtMs)) {
      firstCurrentTurnRowIndex = rows.findIndex((row) => {
        if (row.kind === "working") return true;
        if (!row.createdAt) return false;
        const rowCreatedAtMs = Date.parse(row.createdAt);
        return !Number.isNaN(rowCreatedAtMs) && rowCreatedAtMs >= turnStartedAtMs;
      });
    }

    if (firstCurrentTurnRowIndex < 0) {
      firstCurrentTurnRowIndex = rows.findIndex(
        (row) => row.kind === "message" && row.message.streaming,
      );
    }

    if (firstCurrentTurnRowIndex < 0) return firstTailRowIndex;

    for (let index = firstCurrentTurnRowIndex - 1; index >= 0; index -= 1) {
      const previousRow = rows[index];
      if (!previousRow || previousRow.kind !== "message") continue;
      if (previousRow.message.role === "user") {
        return Math.min(index, firstTailRowIndex);
      }
      if (previousRow.message.role === "assistant" && !previousRow.message.streaming) {
        break;
      }
    }

    return Math.min(firstCurrentTurnRowIndex, firstTailRowIndex);
  }, [activeTurnInProgress, activeTurnStartedAt, rows]);

  const virtualizedRowCount = clamp(firstUnvirtualizedRowIndex, {
    minimum: 0,
    maximum: rows.length,
  });
  const [allDirectoriesExpandedByTurnId] = useState<Record<string, boolean>>({});
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

  const rowVirtualizer = useVirtualizer({
    count: virtualizedRowCount,
    getScrollElement: () => scrollContainer,
    // Use stable row ids so virtual measurements do not leak across thread switches.
    getItemKey: (index: number) => rows[index]?.id ?? index,
    // Keep pre-measure placements close to the final layout so fast scrolls do not visually stack rows.
    estimateSize: (index: number) => {
      const row = rows[index];
      if (!row) return 96;
      if (row.kind === "work") {
        return estimateTimelineWorkGroupHeight(row.groupedEntries, {
          expanded: expandedWorkGroups[row.id] ?? false,
          maxVisibleEntries: MAX_VISIBLE_WORK_LOG_ENTRIES,
        });
      }
      if (row.kind === "proposed-plan") {
        return estimateTimelineProposedPlanHeight(row.proposedPlan, normalizedChatFontSizePx);
      }
      if (row.kind === "working") return 40;
      const turnSummary =
        row.message.role === "assistant"
          ? turnDiffSummaryByAssistantMessageId.get(row.message.id)
          : undefined;
      const messageHeightInput = {
        ...row.message,
        showCompletionDivider: row.showCompletionDivider,
      };
      if (turnSummary) {
        Object.assign(messageHeightInput, {
          diffSummaryFiles: turnSummary.files,
          diffSummaryAllDirectoriesExpanded:
            allDirectoriesExpandedByTurnId[turnSummary.turnId] ?? true,
        });
      }
      return estimateTimelineMessageHeight(messageHeightInput, {
        timelineWidthPx,
        chatFontSizePx: normalizedChatFontSizePx,
      });
    },
    // We still dynamically measure rows because assistant markdown, images and
    // diff cards do not have stable heights. If we revisit the virtualizer
    // strategy, this ref is the main seam where we can switch to fixed or
    // selectively measured rows.
    measureElement: measureVirtualElement,
    useAnimationFrameWithResizeObserver: true,
    overscan: 4,
  });
  const pendingMeasureFrameRef = useRef<number | null>(null);
  // Coalesce all local "please remeasure" triggers into one RAF. The hot path
  // here is less about any single measure and more about several observers
  // firing back-to-back while the user is scrolling.
  const scheduleVirtualizerMeasure = useCallback(() => {
    if (pendingMeasureFrameRef.current !== null) return;
    pendingMeasureFrameRef.current = window.requestAnimationFrame(() => {
      pendingMeasureFrameRef.current = null;
      rowVirtualizer.measure();
    });
  }, [rowVirtualizer]);
  useEffect(() => {
    if (timelineWidthPx === null) return;
    scheduleVirtualizerMeasure();
  }, [scheduleVirtualizerMeasure, timelineWidthPx]);
  useLayoutEffect(() => {
    if (!scrollContainer || typeof ResizeObserver === "undefined") return;

    let lastViewportWidth = -1;
    let lastViewportHeight = -1;
    // Re-measure when the scroll viewport changes because composer/panel chrome
    // can steal vertical space without remounting the timeline.
    const syncViewportSize = () => {
      const nextViewportWidth = scrollContainer.clientWidth;
      const nextViewportHeight = scrollContainer.clientHeight;
      if (
        Math.abs(nextViewportWidth - lastViewportWidth) < 0.5 &&
        Math.abs(nextViewportHeight - lastViewportHeight) < 0.5
      ) {
        return;
      }
      lastViewportWidth = nextViewportWidth;
      lastViewportHeight = nextViewportHeight;
      scheduleVirtualizerMeasure();
    };

    syncViewportSize();
    const observer = new ResizeObserver(() => {
      syncViewportSize();
    });
    observer.observe(scrollContainer);
    return () => {
      observer.disconnect();
    };
  }, [scheduleVirtualizerMeasure, scrollContainer]);
  useEffect(() => {
    scheduleVirtualizerMeasure();
  }, [
    expandedWorkGroups,
    allDirectoriesExpandedByTurnId,
    normalizedChatFontSizePx,
    scheduleVirtualizerMeasure,
  ]);
  useEffect(() => {
    // TanStack can compensate for late measurements by shifting scroll
    // position. This keeps the bottom anchored, but it is also one of the
    // places to revisit if future "scroll fights the user" regressions appear.
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (_item, _delta, instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0;
      const scrollOffset = instance.scrollOffset ?? 0;
      const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight);
      return remainingDistance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    };
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);
  const onTimelineImageLoad = useCallback(() => {
    scheduleVirtualizerMeasure();
  }, [scheduleVirtualizerMeasure]);
  useEffect(() => {
    return () => {
      const frame = pendingMeasureFrameRef.current;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const nonVirtualizedRows = rows.slice(virtualizedRowCount);

  const renderRowContent = (row: TimelineRow) => (
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
          const isExpanded = expandedWorkGroups[groupId] ?? false;
          const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
          const visibleEntries =
            hasOverflow && !isExpanded
              ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
              : groupedEntries;
          const hiddenCount = groupedEntries.length - visibleEntries.length;
          const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
          const showHeader = hasOverflow || !onlyToolEntries;
          const groupLabel = onlyToolEntries ? "Tool calls" : "Work log";

          return (
            <div>
              {showHeader && (
                <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
                  <p className="font-chat-code text-[9px] text-muted-foreground/55">
                    {groupLabel} ({groupedEntries.length})
                  </p>
                  {hasOverflow && (
                    <button
                      type="button"
                      className="font-chat-code text-[9px] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
                      onClick={() => onToggleWorkGroup(groupId)}
                    >
                      {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
                    </button>
                  )}
                </div>
              )}
              <div className="space-y-0.5">
                {visibleEntries.map((workEntry) => (
                  <SimpleWorkEntryRow key={`work-row:${workEntry.id}`} workEntry={workEntry} />
                ))}
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
          const userImages = row.message.attachments ?? [];
          const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
          const terminalContexts = displayedUserMessage.contexts;
          const showUserText =
            displayedUserMessage.visibleText.trim().length > 0 || terminalContexts.length > 0;
          const canRevertAgentWork = revertTurnCountByUserMessageId.has(row.message.id);
          return (
            <div className="flex w-full justify-end">
              <div className="group flex max-w-[80%] flex-col items-end gap-0.5">
                {/* Keep user-message chrome outside the bubble so the message reads as one simple block. */}
                {userImages.length > 0 && (
                  <div
                    className={cn(
                      "flex max-w-[240px] flex-wrap justify-end gap-2 self-end",
                      showUserText && "mb-1",
                    )}
                  >
                    {userImages.map(
                      (image: NonNullable<TimelineMessage["attachments"]>[number]) => (
                        <UserImageAttachmentThumbnail
                          key={image.id}
                          image={image}
                          userImages={userImages}
                          onImageExpand={onImageExpand}
                          onTimelineImageLoad={onTimelineImageLoad}
                          resolvedTheme={resolvedTheme}
                        />
                      ),
                    )}
                  </div>
                )}
                {showUserText && (
                  <div className="w-max max-w-full min-w-0 self-end rounded-xl border border-border/70 bg-secondary px-[14px] py-1.5">
                    <UserMessageBody
                      text={displayedUserMessage.visibleText}
                      terminalContexts={terminalContexts}
                      chatTypographyStyle={chatTypographyStyle}
                    />
                  </div>
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
                  <p className="font-chat-code text-right text-[10px] text-muted-foreground/45">
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
          const inlineWorkSummary = formatInlineWorkSummary(row.inlineWorkEntries ?? []);
          const assistantCopyState = resolveAssistantMessageCopyState({
            text: row.message.text ?? null,
            showCopyButton: row.showAssistantCopyButton,
            streaming: row.message.streaming,
          });
          const assistantMeta = [
            formatMessageMeta(
              row.message.createdAt,
              row.message.streaming
                ? formatElapsed(row.durationStart, nowIso)
                : formatElapsed(row.durationStart, row.message.completedAt),
              timestampFormat,
            ),
            inlineWorkSummary,
          ]
            .filter((value): value is string => Boolean(value))
            .join(" • ");
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
                <ChatMarkdown
                  text={messageText}
                  cwd={markdownCwd}
                  isStreaming={Boolean(row.message.streaming)}
                  style={chatTypographyStyle}
                />
                {(() => {
                  const turnSummary = turnDiffSummaryByAssistantMessageId.get(row.message.id);
                  if (!turnSummary) return null;
                  const checkpointFiles = turnSummary.files;
                  if (checkpointFiles.length === 0) return null;
                  const correspondingUserMessageId = userMessageIdByAssistantMessageId.get(
                    row.message.id,
                  );
                  const canUndo =
                    correspondingUserMessageId != null &&
                    revertTurnCountByUserMessageId.has(correspondingUserMessageId);
                  return (
                    <div className="mt-5 overflow-hidden rounded-lg border border-border bg-neutral-50 dark:bg-neutral-900">
                      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                        <span className="text-[13px] font-normal text-foreground">
                          {checkpointFiles.length === 1
                            ? "1 File changed"
                            : `${checkpointFiles.length} Files changed`}
                        </span>
                        <div className="flex items-center gap-4">
                          {canUndo && (
                            <button
                              type="button"
                              className="flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
                              onClick={() => onRevertUserMessage(correspondingUserMessageId)}
                            >
                              Undo
                              <Undo2Icon className="size-3" />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="bg-neutral-100 dark:bg-neutral-900/60">
                        {checkpointFiles.map((file) => (
                          <button
                            key={file.path}
                            type="button"
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/60"
                            onClick={() => onOpenTurnDiff(turnSummary.turnId, file.path)}
                          >
                            <VscodeEntryIcon
                              pathValue={file.path}
                              kind="file"
                              theme={resolvedTheme}
                              className="size-4 shrink-0 opacity-50"
                            />
                            <span className="font-chat-code truncate text-[12px] text-neutral-900 dark:text-foreground/80 dark:hover:text-foreground">
                              {file.path}
                            </span>
                            {(file.additions ?? 0) + (file.deletions ?? 0) > 0 && (
                              <span className="font-chat-code ml-auto shrink-0 text-[11px] tabular-nums">
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
                  );
                })()}
                <div className="mt-1 flex items-center gap-2">
                  <p className="font-chat-code text-[10px] text-muted-foreground/45">
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
        <div className="py-0.5 pl-1.5">
          <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70">
            <span className="inline-flex items-center gap-[3px]">
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
            </span>
            <span>
              {row.createdAt
                ? `Working for ${formatWorkingTimer(row.createdAt, nowIso) ?? "0s"}`
                : "Working..."}
            </span>
          </div>
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
    <div
      ref={timelineRootRef}
      data-timeline-root="true"
      className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden"
    >
      {virtualizedRowCount > 0 && (
        <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {virtualRows.map((virtualRow: VirtualItem) => {
            const row = rows[virtualRow.index];
            if (!row) return null;

            return (
              <div
                key={`virtual-row:${row.id}`}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderRowContent(row)}
              </div>
            );
          })}
        </div>
      )}

      {nonVirtualizedRows.map((row) => (
        <div key={`non-virtual-row:${row.id}`}>{renderRowContent(row)}</div>
      ))}
    </div>
  );
});

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineProposedPlan = Extract<TimelineEntry, { kind: "proposed-plan" }>["proposedPlan"];
type TimelineWorkEntry = Extract<TimelineEntry, { kind: "work" }>["entry"];
type TimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: TimelineWorkEntry[];
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: TimelineMessage;
      inlineWorkEntries?: TimelineWorkEntry[];
      durationStart: string;
      showCompletionDivider: boolean;
      showAssistantCopyButton: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: TimelineProposedPlan;
    }
  | { kind: "working"; id: string; createdAt: string | null };

function estimateTimelineProposedPlanHeight(
  proposedPlan: TimelineProposedPlan,
  chatFontSizePx: number,
): number {
  const estimatedLines = Math.max(1, Math.ceil(proposedPlan.planMarkdown.length / 72));
  return 120 + Math.min(estimatedLines * getChatTranscriptLineHeightPx(chatFontSizePx), 880);
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

function formatInlineWorkSummary(groupedEntries: TimelineWorkEntry[]): string | null {
  if (groupedEntries.length === 0) return null;

  const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
  const groupLabel = onlyToolEntries ? "Tool calls" : "Work log";
  if (groupedEntries.length === 1) {
    return `${toolWorkEntryHeading(groupedEntries[0])} • ${groupLabel}`;
  }

  return `${groupLabel} (${groupedEntries.length})`;
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
  image: NonNullable<TimelineMessage["attachments"]>[number];
  userImages: NonNullable<TimelineMessage["attachments"]>;
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
          <VscodeEntryIcon
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
function renderUserMessageInlineText(text: string, keyPrefix: string): ReactNode[] {
  return splitPromptIntoDisplaySegments(text).flatMap((segment, index) => {
    const key = `${keyPrefix}:${index}`;
    if (segment.type === "text") {
      return segment.text.length > 0 ? [<span key={`${key}:text`}>{segment.text}</span>] : [];
    }
    if (segment.type === "skill") {
      return [<UserMessageInlineSkillChip key={`${key}:skill`} skillName={segment.name} />];
    }
    if (segment.type === "mention") {
      return [<span key={`${key}:mention`}>{`@${segment.path}`}</span>];
    }
    return [];
  });
}

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
        ...renderUserMessageInlineText(props.text, "user-message-terminal-context-inline-text"),
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
      <div className="flex max-w-full min-w-0 items-center leading-none text-foreground">
        {renderUserMessageInlineText(props.text, "user-message-inline-chip-only")}
      </div>
    );
  }

  return (
    <div
      className="inline-block max-w-full min-w-0 whitespace-pre-wrap break-words font-system-ui text-foreground"
      style={props.chatTypographyStyle}
    >
      {renderUserMessageInlineText(props.text, "user-message-inline")}
    </div>
  );
});

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground/92",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  return workEntry.changedFiles!.length === 1
    ? firstPath
    : `${firstPath} +${workEntry.changedFiles!.length - 1} more`;
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
      return WrenchIcon;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return HammerIcon;
  }

  return workToneIcon(workEntry.tone).icon;
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

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
}) {
  const { workEntry } = props;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const preview = workEntryPreview(workEntry);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;

  return (
    <div className="rounded-lg px-1 py-1">
      <div className="flex items-center gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <p
            className={cn(
              "truncate text-[11px] leading-5",
              workToneClass(workEntry.tone),
              preview ? "text-muted-foreground/70" : "",
            )}
            title={displayText}
          >
            <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
              {heading}
            </span>
            {preview && <span className="text-muted-foreground/55"> - {preview}</span>}
          </p>
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className="mt-1 flex flex-wrap gap-1 pl-6">
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => (
            <span
              key={`${workEntry.id}:${filePath}`}
              className="font-chat-code rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 text-[10px] text-muted-foreground/75"
              title={filePath}
            >
              {filePath}
            </span>
          ))}
          {(workEntry.changedFiles?.length ?? 0) > 4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +{(workEntry.changedFiles?.length ?? 0) - 4}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
