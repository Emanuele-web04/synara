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
  type ReactNode,
  type RefObject,
  type TouchEventHandler,
  type WheelEventHandler,
  useRef,
} from "react";
import { type TimestampFormat } from "../../appSettings";
import { type TurnDiffSummary } from "../../types";
import { ArrowDownIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { DISCLOSURE_CONTENT_MOTION_CLASS } from "~/lib/disclosureMotion";
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
  emptyStateContent?: ReactNode;
  emptyStateProjectName: string | undefined;
  expandedWorkGroups?: Record<string, boolean>;
  hasMessages: boolean;
  isRevertingCheckpoint: boolean;
  isWorking: boolean;
  followLiveOutput: boolean;
  nowIso?: ComponentProps<typeof MessagesTimeline>["nowIso"];
  listRef: RefObject<LegendListRef | null>;
  timelineControllerRef?: RefObject<MessagesTimelineController | null>;
  pinnedMessageIds?: ReadonlySet<MessageId>;
  canPinMessage?: (messageId: MessageId) => boolean;
  onTogglePinMessage?: (messageId: MessageId) => void;
  threadMarkers?: readonly ThreadMarker[];
  transcriptContainerRef?: RefObject<HTMLDivElement | null>;
  enteringUserMessageIds?: ComponentProps<typeof MessagesTimeline>["enteringUserMessageIds"];
  markdownCwd: string | undefined;
  onExpandTimelineImage: (preview: ExpandedImagePreview) => void;
  onMarkdownContentReflow?: ComponentProps<typeof MessagesTimeline>["onMarkdownContentReflow"];
  onMessagesClickCapture: MouseEventHandler<HTMLDivElement>;
  onMessagesMouseUp: MouseEventHandler<HTMLDivElement>;
  onMessagesPointerCancel: PointerEventHandler<HTMLDivElement>;
  onMessagesPointerDown: PointerEventHandler<HTMLDivElement>;
  onMessagesPointerUp: PointerEventHandler<HTMLDivElement>;
  onMessagesScroll: ComponentProps<typeof MessagesTimeline>["onMessagesScroll"];
  onMessagesKeyDown?: ComponentProps<typeof MessagesTimeline>["onMessagesKeyDown"];
  onMessagesTouchEnd: TouchEventHandler<HTMLDivElement>;
  onMessagesTouchMove: TouchEventHandler<HTMLDivElement>;
  onMessagesTouchStart: TouchEventHandler<HTMLDivElement>;
  onMessagesWheel: WheelEventHandler<HTMLDivElement>;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  onCloseAgentActivityDetail?: () => void;
  onOpenAgentActivity?: ComponentProps<typeof MessagesTimeline>["onOpenAgentActivity"];
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onOpenThread: (threadId: ThreadId) => void;
  onOpenAutomation?: ComponentProps<typeof MessagesTimeline>["onOpenAutomation"];
  onRevertUserMessage: (messageId: MessageId) => void;
  onEditUserMessage?: (messageId: MessageId, text: string) => boolean | Promise<boolean>;
  onScrollToBottom: () => void;
  shouldTailReflow?: ComponentProps<typeof MessagesTimeline>["shouldTailReflow"];
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
  emptyStateContent,
  emptyStateProjectName,
  expandedWorkGroups,
  hasMessages,
  isRevertingCheckpoint,
  isWorking,
  followLiveOutput,
  nowIso,
  listRef,
  timelineControllerRef,
  pinnedMessageIds,
  canPinMessage,
  onTogglePinMessage,
  threadMarkers,
  transcriptContainerRef,
  enteringUserMessageIds,
  markdownCwd,
  onExpandTimelineImage,
  onMarkdownContentReflow,
  onMessagesClickCapture,
  onMessagesMouseUp,
  onMessagesPointerCancel,
  onMessagesPointerDown,
  onMessagesPointerUp,
  onMessagesScroll,
  onMessagesKeyDown,
  onMessagesTouchEnd,
  onMessagesTouchMove,
  onMessagesTouchStart,
  onMessagesWheel,
  onIsAtEndChange,
  onCloseAgentActivityDetail,
  onOpenAgentActivity,
  onOpenTurnDiff,
  onOpenThread,
  onOpenAutomation,
  onRevertUserMessage,
  onEditUserMessage,
  onScrollToBottom,
  shouldTailReflow,
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
  const latestMessageEntry = (() => {
    for (let index = timelineEntries.length - 1; index >= 0; index -= 1) {
      const entry = timelineEntries[index];
      if (entry?.kind === "message") {
        return entry.message;
      }
    }
    return null;
  })();
  const liveLogAnnouncementRef = useRef<{ messageId: string | null; text: string }>({
    messageId: null,
    text: "",
  });
  if (latestMessageEntry && liveLogAnnouncementRef.current.messageId !== latestMessageEntry.id) {
    const speaker = latestMessageEntry.role === "user" ? "You" : "Assistant";
    liveLogAnnouncementRef.current = {
      messageId: latestMessageEntry.id,
      text: `${speaker}: ${latestMessageEntry.text.slice(0, 220)}`,
    };
  } else if (!latestMessageEntry && liveLogAnnouncementRef.current.messageId !== null) {
    liveLogAnnouncementRef.current = { messageId: null, text: "" };
  }
  const scrollButtonFrameStyle: CSSProperties | undefined = contentInsetRightPx
    ? { paddingRight: contentInsetRightPx }
    : undefined;

  return (
    <div
      ref={transcriptContainerRef}
      data-chat-transcript-pane="true"
      aria-hidden={terminalWorkspaceTerminalTabActive}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        terminalWorkspaceTerminalTabActive ? "pointer-events-none invisible" : "",
      )}
    >
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-atomic="false"
        className="sr-only"
      >
        {liveLogAnnouncementRef.current.text}
      </div>
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
            {...(canPinMessage ? { canPinMessage } : {})}
            {...(onTogglePinMessage ? { onTogglePinMessage } : {})}
            {...(threadMarkers ? { threadMarkers } : {})}
            {...(enteringUserMessageIds ? { enteringUserMessageIds } : {})}
            timelineEntries={timelineEntries}
            turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
            nowIso={nowIso}
            onOpenTurnDiff={onOpenTurnDiff}
            onOpenThread={onOpenThread}
            {...(onOpenAutomation ? { onOpenAutomation } : {})}
            revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
            onRevertUserMessage={onRevertUserMessage}
            {...(onEditUserMessage ? { onEditUserMessage } : {})}
            isRevertingCheckpoint={isRevertingCheckpoint}
            onImageExpand={onExpandTimelineImage}
            {...(onMarkdownContentReflow ? { onMarkdownContentReflow } : {})}
            {...(shouldTailReflow ? { shouldTailReflow } : {})}
            followLiveOutput={followLiveOutput}
            onIsAtEndChange={onIsAtEndChange}
            onMessagesScroll={onMessagesScroll}
            onMessagesClickCapture={onMessagesClickCapture}
            onMessagesMouseUp={onMessagesMouseUp}
            onMessagesWheel={onMessagesWheel}
            onMessagesPointerDown={onMessagesPointerDown}
            onMessagesPointerUp={onMessagesPointerUp}
            onMessagesPointerCancel={onMessagesPointerCancel}
            {...(onMessagesKeyDown ? { onMessagesKeyDown } : {})}
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
            emptyStateContent={
              emptyStateContent === undefined ? (
                <ChatEmptyStateHero projectName={emptyStateProjectName} />
              ) : (
                emptyStateContent
              )
            }
            {...(expandedWorkGroups ? { expandedWorkGroups } : {})}
            {...(onToggleWorkGroup ? { onToggleWorkGroup } : {})}
          />
        )}

        {!agentActivityDetail ? (
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-6 z-30 flex justify-center py-1",
              // Reuse the shared disclosure motion so the arrow fades + drifts in/out with
              // the same 220ms ease-out curve (and motion-reduce fallback) as every other
              // show/hide in the app. The wrapper stays pointer-events-none; only the
              // button re-enables pointer events while visible.
              DISCLOSURE_CONTENT_MOTION_CLASS,
              scrollButtonVisible ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
            )}
            // Follow the same right inset as transcript rows so the button centers in the
            // visible chat column while the side panel overlays the viewport edge.
            style={scrollButtonFrameStyle}
          >
            <button
              type="button"
              onClick={onScrollToBottom}
              data-scroll-anchor-ignore
              aria-label="Scroll to bottom"
              aria-hidden={!scrollButtonVisible}
              tabIndex={scrollButtonVisible ? 0 : -1}
              className={cn(
                "flex size-11 items-center justify-center rounded-full border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] text-[var(--color-text-foreground)] backdrop-blur-md transition-colors hover:cursor-pointer hover:bg-[var(--color-background-elevated-secondary)] sm:size-8",
                scrollButtonVisible ? "pointer-events-auto" : "pointer-events-none",
              )}
            >
              <ArrowDownIcon className="size-3.5" />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
});
