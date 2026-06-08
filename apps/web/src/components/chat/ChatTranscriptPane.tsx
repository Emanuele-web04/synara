// FILE: ChatTranscriptPane.tsx
// Purpose: Isolate the transcript shell so composer state changes do not re-render it unnecessarily.
// Layer: Chat transcript shell
// Depends on: MessagesTimeline and ChatView's list-owned scroll contract.

import { type MessageId, type ThreadId, type ThreadMarker, type TurnId } from "@t3tools/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import {
  memo,
  type ComponentProps,
  type CSSProperties,
  type MouseEventHandler,
  type PointerEventHandler,
  type RefObject,
  type TouchEventHandler,
  type WheelEventHandler,
} from "react";
import { type TimestampFormat } from "../../appSettings";
import { type TurnDiffSummary } from "../../types";
import { ArrowDownIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import { ChatEmptyStateHero } from "./ChatEmptyStateHero";
import { MessagesTimeline, type MessagesTimelineController } from "./MessagesTimeline";
import { AgentActivityDetailView } from "./AgentActivityDetailView";
import type { AgentActivityDetail } from "./agentActivity.logic";

interface ChatTranscriptPaneProps {
  activeThreadId: string;
  activeTurnId?: TurnId | null;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  agentActivityDetail?: AgentActivityDetail | null;
  bottomContentInsetPx?: ComponentProps<typeof MessagesTimeline>["bottomContentInsetPx"];
  contentInsetRightPx?: ComponentProps<typeof MessagesTimeline>["contentInsetRightPx"];
  chatFontSizePx: number;
  emptyStateProjectName: string | undefined;
  expandedWorkGroups?: Record<string, boolean>;
  hasMessages: boolean;
  isRevertingCheckpoint: boolean;
  isWorking: boolean;
  followLiveOutput: boolean;
  listRef: RefObject<LegendListRef | null>;
  timelineControllerRef?: RefObject<MessagesTimelineController | null>;
  pinnedMessageIds?: ReadonlySet<MessageId>;
  onTogglePinMessage?: (messageId: MessageId) => void;
  threadMarkers?: readonly ThreadMarker[];
  markdownCwd: string | undefined;
  onExpandTimelineImage: (preview: ExpandedImagePreview) => void;
  onMessagesClickCapture: MouseEventHandler<HTMLDivElement>;
  onMessagesMouseUp: MouseEventHandler<HTMLDivElement>;
  onMessagesPointerCancel: PointerEventHandler<HTMLDivElement>;
  onMessagesPointerDown: PointerEventHandler<HTMLDivElement>;
  onMessagesPointerUp: PointerEventHandler<HTMLDivElement>;
  onMessagesScroll: ComponentProps<typeof MessagesTimeline>["onMessagesScroll"];
  onMessagesTouchEnd: TouchEventHandler<HTMLDivElement>;
  onMessagesTouchMove: TouchEventHandler<HTMLDivElement>;
  onMessagesTouchStart: TouchEventHandler<HTMLDivElement>;
  onMessagesWheel: WheelEventHandler<HTMLDivElement>;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  onCloseAgentActivityDetail?: () => void;
  onOpenAgentActivity?: ComponentProps<typeof MessagesTimeline>["onOpenAgentActivity"];
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onOpenThread: (threadId: ThreadId) => void;
  onRevertUserMessage: (messageId: MessageId) => void;
  onEditUserMessage?: (messageId: MessageId, text: string) => boolean | Promise<boolean>;
  onScrollToBottom: () => void;
  onToggleWorkGroup?: (groupId: string) => void;
  resolvedTheme: "light" | "dark";
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  scrollButtonVisible: boolean;
  terminalWorkspaceTerminalTabActive: boolean;
  timelineEntries: ComponentProps<typeof MessagesTimeline>["timelineEntries"];
  timestampFormat: TimestampFormat;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  workspaceRoot: string | undefined;
}

export const ChatTranscriptPane = memo(function ChatTranscriptPane({
  activeThreadId,
  activeTurnId,
  activeTurnInProgress,
  activeTurnStartedAt,
  agentActivityDetail,
  bottomContentInsetPx,
  contentInsetRightPx,
  chatFontSizePx,
  emptyStateProjectName,
  expandedWorkGroups,
  hasMessages,
  isRevertingCheckpoint,
  isWorking,
  followLiveOutput,
  listRef,
  timelineControllerRef,
  pinnedMessageIds,
  onTogglePinMessage,
  threadMarkers,
  markdownCwd,
  onExpandTimelineImage,
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
  onIsAtEndChange,
  onCloseAgentActivityDetail,
  onOpenAgentActivity,
  onOpenTurnDiff,
  onOpenThread,
  onRevertUserMessage,
  onEditUserMessage,
  onScrollToBottom,
  onToggleWorkGroup,
  resolvedTheme,
  revertTurnCountByUserMessageId,
  scrollButtonVisible,
  terminalWorkspaceTerminalTabActive,
  timelineEntries,
  timestampFormat,
  turnDiffSummaryByAssistantMessageId,
  workspaceRoot,
}: ChatTranscriptPaneProps) {
  const scrollButtonFrameStyle: CSSProperties | undefined = contentInsetRightPx
    ? { paddingRight: contentInsetRightPx }
    : undefined;

  return (
    <div
      data-chat-transcript-pane="true"
      aria-hidden={terminalWorkspaceTerminalTabActive}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        terminalWorkspaceTerminalTabActive ? "pointer-events-none invisible" : "",
      )}
    >
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {agentActivityDetail && onCloseAgentActivityDetail ? (
          <AgentActivityDetailView
            detail={agentActivityDetail}
            bottomContentInsetPx={bottomContentInsetPx}
            chatFontSizePx={chatFontSizePx}
            contentInsetRightPx={contentInsetRightPx}
            markdownCwd={markdownCwd}
            onBack={onCloseAgentActivityDetail}
            onImageExpand={onExpandTimelineImage}
            onOpenThread={onOpenThread}
            timestampFormat={timestampFormat}
          />
        ) : (
          <MessagesTimeline
            key={activeThreadId}
            hasMessages={hasMessages}
            isWorking={isWorking}
            activeTurnId={activeTurnId ?? null}
            activeTurnInProgress={activeTurnInProgress}
            activeTurnStartedAt={activeTurnStartedAt}
            listRef={listRef}
            {...(timelineControllerRef ? { controllerRef: timelineControllerRef } : {})}
            {...(pinnedMessageIds ? { pinnedMessageIds } : {})}
            {...(onTogglePinMessage ? { onTogglePinMessage } : {})}
            {...(threadMarkers ? { threadMarkers } : {})}
            timelineEntries={timelineEntries}
            turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
            onOpenTurnDiff={onOpenTurnDiff}
            onOpenThread={onOpenThread}
            revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
            onRevertUserMessage={onRevertUserMessage}
            {...(onEditUserMessage ? { onEditUserMessage } : {})}
            isRevertingCheckpoint={isRevertingCheckpoint}
            onImageExpand={onExpandTimelineImage}
            followLiveOutput={followLiveOutput}
            onIsAtEndChange={onIsAtEndChange}
            onMessagesScroll={onMessagesScroll}
            onMessagesClickCapture={onMessagesClickCapture}
            onMessagesMouseUp={onMessagesMouseUp}
            onMessagesWheel={onMessagesWheel}
            onMessagesPointerDown={onMessagesPointerDown}
            onMessagesPointerUp={onMessagesPointerUp}
            onMessagesPointerCancel={onMessagesPointerCancel}
            onMessagesTouchStart={onMessagesTouchStart}
            onMessagesTouchMove={onMessagesTouchMove}
            onMessagesTouchEnd={onMessagesTouchEnd}
            markdownCwd={markdownCwd}
            resolvedTheme={resolvedTheme}
            chatFontSizePx={chatFontSizePx}
            timestampFormat={timestampFormat}
            workspaceRoot={workspaceRoot}
            bottomContentInsetPx={bottomContentInsetPx}
            contentInsetRightPx={contentInsetRightPx}
            {...(onOpenAgentActivity ? { onOpenAgentActivity } : {})}
            emptyStateContent={<ChatEmptyStateHero projectName={emptyStateProjectName} />}
            {...(expandedWorkGroups ? { expandedWorkGroups } : {})}
            {...(onToggleWorkGroup ? { onToggleWorkGroup } : {})}
          />
        )}

        {scrollButtonVisible && !agentActivityDetail ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-6 z-30 flex justify-center py-1"
            // Follow the same right inset as transcript rows so the button centers in the
            // visible chat column while the side panel overlays the viewport edge.
            style={scrollButtonFrameStyle}
          >
            <button
              type="button"
              onClick={onScrollToBottom}
              data-scroll-anchor-ignore
              aria-label="Scroll to bottom"
              className="pointer-events-auto flex size-8 items-center justify-center rounded-full border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] text-[var(--color-text-foreground)] backdrop-blur-md transition-colors hover:cursor-pointer hover:bg-[var(--color-background-elevated-secondary)]"
            >
              <ArrowDownIcon className="size-3.5" />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
});
