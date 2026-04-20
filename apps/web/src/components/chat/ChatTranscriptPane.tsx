// FILE: ChatTranscriptPane.tsx
// Purpose: Isolate the scrollable transcript subtree so composer state changes do not re-render it unnecessarily.
// Layer: Chat transcript shell
// Depends on: MessagesTimeline and the chat auto-scroll controller contract.

import { type MessageId, type ThreadId, type TurnId } from "@t3tools/contracts";
import {
  memo,
  type ComponentProps,
  type MouseEventHandler,
  type PointerEventHandler,
  type TouchEventHandler,
  type WheelEventHandler,
} from "react";
import { type TimestampFormat } from "../../appSettings";
import { type TurnDiffSummary } from "../../types";
import { ArrowDownIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import { ChatEmptyStateHero } from "./ChatEmptyStateHero";
import { MessagesTimeline } from "./MessagesTimeline";

interface ChatTranscriptPaneProps {
  activeThreadId: string;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  chatFontSizePx: number;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  emptyStateProjectName: string | undefined;
  expandedWorkGroups: Record<string, boolean>;
  hasMessages: boolean;
  isRevertingCheckpoint: boolean;
  isWorking: boolean;
  followLiveOutput: boolean;
  markdownCwd: string | undefined;
  messagesScrollElement: HTMLDivElement | null;
  onExpandTimelineImage: (preview: ExpandedImagePreview) => void;
  onMessagesClickCapture: MouseEventHandler<HTMLDivElement>;
  onMessagesMouseUp: MouseEventHandler<HTMLDivElement>;
  onMessagesPointerCancel: PointerEventHandler<HTMLDivElement>;
  onMessagesPointerDown: PointerEventHandler<HTMLDivElement>;
  onMessagesPointerUp: PointerEventHandler<HTMLDivElement>;
  onMessagesScroll: () => void;
  onMessagesTouchEnd: TouchEventHandler<HTMLDivElement>;
  onMessagesTouchMove: TouchEventHandler<HTMLDivElement>;
  onMessagesTouchStart: TouchEventHandler<HTMLDivElement>;
  onMessagesWheel: WheelEventHandler<HTMLDivElement>;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onOpenThread: (threadId: ThreadId) => void;
  onRevertUserMessage: (messageId: MessageId) => void;
  onScrollToBottom: () => void;
  onLiveContentHeightChange: () => void;
  onToggleWorkGroup: (groupId: string) => void;
  resolvedTheme: "light" | "dark";
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  scrollButtonVisible: boolean;
  setMessagesBottomAnchorRef: (element: HTMLDivElement | null) => void;
  setMessagesScrollContainerRef: (element: HTMLDivElement | null) => void;
  terminalWorkspaceTerminalTabActive: boolean;
  timelineEntries: ComponentProps<typeof MessagesTimeline>["timelineEntries"];
  timestampFormat: TimestampFormat;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  workspaceRoot: string | undefined;
}

export const ChatTranscriptPane = memo(function ChatTranscriptPane({
  activeThreadId,
  activeTurnInProgress,
  activeTurnStartedAt,
  chatFontSizePx,
  completionDividerBeforeEntryId,
  completionSummary,
  emptyStateProjectName,
  expandedWorkGroups,
  hasMessages,
  isRevertingCheckpoint,
  isWorking,
  followLiveOutput,
  markdownCwd,
  messagesScrollElement,
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
  onOpenTurnDiff,
  onOpenThread,
  onRevertUserMessage,
  onScrollToBottom,
  onLiveContentHeightChange,
  onToggleWorkGroup,
  resolvedTheme,
  revertTurnCountByUserMessageId,
  scrollButtonVisible,
  setMessagesBottomAnchorRef,
  setMessagesScrollContainerRef,
  terminalWorkspaceTerminalTabActive,
  timelineEntries,
  timestampFormat,
  turnDiffSummaryByAssistantMessageId,
  workspaceRoot,
}: ChatTranscriptPaneProps) {
  return (
    <div
      aria-hidden={terminalWorkspaceTerminalTabActive}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        terminalWorkspaceTerminalTabActive ? "pointer-events-none invisible" : "",
      )}
    >
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          ref={setMessagesScrollContainerRef}
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-3 sm:px-5 sm:py-4"
          onScroll={onMessagesScroll}
          onClickCapture={onMessagesClickCapture}
          onMouseUp={onMessagesMouseUp}
          onWheel={onMessagesWheel}
          onPointerDown={onMessagesPointerDown}
          onPointerUp={onMessagesPointerUp}
          onPointerCancel={onMessagesPointerCancel}
          onTouchStart={onMessagesTouchStart}
          onTouchMove={onMessagesTouchMove}
          onTouchEnd={onMessagesTouchEnd}
          onTouchCancel={onMessagesTouchEnd}
        >
          <MessagesTimeline
            key={activeThreadId}
            hasMessages={hasMessages}
            isWorking={isWorking}
            activeTurnInProgress={activeTurnInProgress}
            activeTurnStartedAt={activeTurnStartedAt}
            scrollContainer={messagesScrollElement}
            timelineEntries={timelineEntries}
            completionDividerBeforeEntryId={completionDividerBeforeEntryId}
            completionSummary={completionSummary}
            turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
            expandedWorkGroups={expandedWorkGroups}
            onToggleWorkGroup={onToggleWorkGroup}
            onOpenTurnDiff={onOpenTurnDiff}
            onOpenThread={onOpenThread}
            revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
            onRevertUserMessage={onRevertUserMessage}
            isRevertingCheckpoint={isRevertingCheckpoint}
            onImageExpand={onExpandTimelineImage}
            followLiveOutput={followLiveOutput}
            onLiveContentHeightChange={onLiveContentHeightChange}
            markdownCwd={markdownCwd}
            resolvedTheme={resolvedTheme}
            chatFontSizePx={chatFontSizePx}
            timestampFormat={timestampFormat}
            workspaceRoot={workspaceRoot}
            emptyStateContent={<ChatEmptyStateHero projectName={emptyStateProjectName} />}
          />
          {/* Keep an explicit bottom target so auto-stick can scroll to real content end
              without depending on in-flight virtualizer height estimates. */}
          <div ref={setMessagesBottomAnchorRef} aria-hidden="true" className="h-px w-full" />
        </div>

        {scrollButtonVisible ? (
          <div className="pointer-events-none absolute bottom-1 left-1/2 z-30 flex -translate-x-1/2 justify-center py-1">
            <button
              type="button"
              onClick={onScrollToBottom}
              aria-label="Scroll to bottom"
              className="pointer-events-auto flex size-9 items-center justify-center rounded-full border border-border bg-background/95 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:cursor-pointer hover:border-foreground/20 hover:bg-background hover:text-foreground"
            >
              <ArrowDownIcon className="size-4" />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
});
