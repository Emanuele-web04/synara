// FILE: MessagesTimeline.tsx
// Purpose: Renders the chat transcript rows and lets LegendList own scrolling/follow behavior.
// Layer: Web chat presentation component
// Exports: MessagesTimeline

import { type MessageId, type ThreadId, type ThreadMarker, type TurnId } from "@t3tools/contracts";
import { resolveLatestTailUserMessageEditTarget } from "@t3tools/shared/conversationEdit";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
  type ReactNode,
} from "react";
import { deriveTimelineEntries } from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ExpandedImagePreview } from "./ExpandedImagePreview";
import { AssistantMessageRow } from "./assistantMessageRow";
import { UserMessageRow } from "./userMessageRow";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  type MessagesTimelineRow,
  type StableMessagesTimelineRowsState,
} from "./MessagesTimeline.logic";
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
import {
  getChatMessageFooterTextStyle,
  getChatTranscriptTextStyle,
  getChatTranscriptUserMessageTextStyle,
} from "./chatTypography";
import { getAppTypographyScale } from "../../lib/appTypography";
import { SimpleWorkEntryRow, prefersCompactWorkEntryRow } from "./workEntryRow";

// The composer overlaps the transcript by design, so the list needs extra tail
// space beyond the overlap to keep final cards from sitting flush against it.
const MIN_BOTTOM_CONTENT_INSET_PX = 64;

export interface MessagesTimelineController {
  scrollToMessage: (messageId: MessageId) => void;
  scrollToMarker: (marker: ThreadMarker) => void;
}

function getTimelineScrollRoot(
  listRef: RefObject<LegendListRef | null>,
): HTMLElement | Document | null {
  const scrollNode = listRef.current?.getScrollableNode?.();
  return scrollNode instanceof HTMLElement ? scrollNode : document;
}

function findElementByDataAttribute(
  root: HTMLElement | Document,
  attributeName: string,
  value: string,
): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>(`[${attributeName}]`)) {
    if (element.getAttribute(attributeName) === value) {
      return element;
    }
  }
  return null;
}

function findThreadMarkerElement(
  root: HTMLElement | Document,
  markerId: string,
): HTMLElement | null {
  return findElementByDataAttribute(root, "data-thread-marker-id", markerId);
}

function findMessageElement(root: HTMLElement | Document, messageId: string): HTMLElement | null {
  return findElementByDataAttribute(root, "data-message-id", messageId);
}

interface MessagesTimelineProps {
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  followLiveOutput?: boolean;
  emptyStateContent?: ReactNode;
  listRef?: RefObject<LegendListRef | null>;
  controllerRef?: RefObject<MessagesTimelineController | null>;
  pinnedMessageIds?: ReadonlySet<MessageId>;
  onTogglePinMessage?: (messageId: MessageId) => void;
  threadMarkers?: readonly ThreadMarker[];
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  nowIso?: string;
  expandedWorkGroups?: Record<string, boolean>;
  onToggleWorkGroup?: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onOpenThread?: (threadId: ThreadId) => void;
  onOpenAgentActivity?: (threadId: ThreadId) => void;
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
  controllerRef,
  threadMarkers,
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
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const activeMarkerElementRef = useRef<HTMLElement | null>(null);
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
  const markersByMessageId = useMemo(() => {
    const map = new Map<MessageId, ThreadMarker[]>();
    for (const marker of threadMarkers ?? []) {
      const current = map.get(marker.messageId) ?? [];
      current.push(marker);
      map.set(marker.messageId, current);
    }
    return map;
  }, [threadMarkers]);
  useImperativeHandle(
    controllerRef,
    () => ({
      scrollToMessage: (messageId) => {
        const root = timelineRootRef.current ?? getTimelineScrollRoot(resolvedListRef);
        const target = root ? findMessageElement(root, messageId) : null;
        target?.scrollIntoView({ block: "center", behavior: "smooth" });
      },
      scrollToMarker: (marker) => {
        const root = timelineRootRef.current ?? getTimelineScrollRoot(resolvedListRef);
        const target = root ? findThreadMarkerElement(root, marker.id) : null;
        activeMarkerElementRef.current?.classList.remove("thread-marker-active");
        if (!target) {
          return;
        }
        target.classList.add("thread-marker-active");
        activeMarkerElementRef.current = target;
        target.scrollIntoView({ block: "center", behavior: "smooth" });
      },
    }),
    [controllerRef, resolvedListRef],
  );
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

      {row.kind === "message" && row.message.role === "user" && (
        <UserMessageRow
          row={row}
          resolvedTheme={resolvedTheme}
          normalizedChatFontSizePx={normalizedChatFontSizePx}
          userMessageTypographyStyle={userMessageTypographyStyle}
          chatMessageFooterStyle={chatMessageFooterStyle}
          timestampFormat={timestampFormat}
          isWorking={isWorking}
          isRevertingCheckpoint={isRevertingCheckpoint}
          onImageExpand={onImageExpand}
          onRevertUserMessage={onRevertUserMessage}
          editingUserMessageId={editingUserMessageId}
          submittingEditedUserMessageId={submittingEditedUserMessageId}
          latestEditableUserMessageId={latestEditableUserMessageId}
          expandedUserMessagesById={expandedUserMessagesById}
          setExpandedUserMessagesById={setExpandedUserMessagesById}
          startUserMessageEdit={startUserMessageEdit}
          cancelUserMessageEdit={cancelUserMessageEdit}
          submitUserMessageEdit={submitUserMessageEdit}
          tailContentRowId={tailContentRowId}
          scrollTailExpansionToEnd={scrollTailExpansionToEnd}
          ignoreTimelineImageLoad={ignoreTimelineImageLoad}
          {...(onEditUserMessage ? { onEditUserMessage } : {})}
        />
      )}

      {row.kind === "message" && row.message.role === "assistant" && (
        <AssistantMessageRow
          row={row}
          nowIso={nowIso}
          timestampFormat={timestampFormat}
          expandedWorkGroupsState={expandedWorkGroupsState}
          activeTurnInProgress={activeTurnInProgress}
          appTypographyScale={appTypographyScale}
          normalizedChatFontSizePx={normalizedChatFontSizePx}
          chatTypographyStyle={chatTypographyStyle}
          chatMessageFooterStyle={chatMessageFooterStyle}
          markdownCwd={markdownCwd}
          resolvedTheme={resolvedTheme}
          onOpenTurnDiff={onOpenTurnDiff}
          onImageExpand={onImageExpand}
          onRevertUserMessage={onRevertUserMessage}
          revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
          userMessageIdByAssistantMessageId={userMessageIdByAssistantMessageId}
          expandedCollapsedWork={expandedCollapsedWork}
          setCollapsedWorkExpanded={setCollapsedWorkExpanded}
          expandedFileChangesByTurnId={expandedFileChangesByTurnId}
          toggleFileChangesExpanded={toggleFileChangesExpanded}
          handleToggleWorkGroup={handleToggleWorkGroup}
          tailContentRowId={tailContentRowId}
          scrollTailExpansionToEnd={scrollTailExpansionToEnd}
          markers={markersByMessageId.get(row.message.id)}
          {...(onOpenThread ? { onOpenThread } : {})}
        />
      )}

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
    <div ref={timelineRootRef} className="h-full min-h-0">
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
    </div>
  );
});

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
