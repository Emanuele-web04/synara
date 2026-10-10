// FILE: ChatTranscriptPane.tsx
// Purpose: Isolate the transcript shell so composer state changes do not re-render it unnecessarily.
// Layer: Chat transcript shell
// Depends on: MessagesTimeline and ChatView's list-owned scroll contract.

import { type MessageId, type ThreadId, type TurnId } from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import {
  useEffect,
  useMemo,
  useCallback,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type CSSProperties,
  type MouseEventHandler,
  type PointerEventHandler,
  type ReactNode,
  type RefObject,
  type TouchEventHandler,
  type WheelEventHandler,
} from "react";
import { type MessageTrailAudioSource, type TimestampFormat } from "../../appSettings";
import { type TurnDiffSummary, type WorktreeSetupSnapshot } from "../../types";
import { ArrowDownIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { getAudioLevelSubscriber, isAudioLevelAvailable } from "~/lib/audioLevel";
import { DISCLOSURE_CONTENT_MOTION_CLASS } from "~/lib/disclosureMotion";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import { ChatEmptyStateHero } from "./ChatEmptyStateHero";
import { MessagesTimeline, type MessagesTimelineController } from "./MessagesTimeline";
import { composerOverlayAffordanceBottomPx } from "./composerOverlay";
import { MessageTrail } from "./MessageTrail";
import { createActiveTrailStore, deriveMessageTrailItems } from "./messageTrail.logic";
import { createThreadFindHighlightStore, type ThreadFindHighlightStore } from "./threadFind.logic";
import { AgentActivityDetailView } from "./AgentActivityDetailView";
import type { AgentActivityDetail } from "./agentActivity.logic";
import { ThreadErrorBanner } from "./ThreadErrorBanner";
import { SubagentRunningChip } from "./SubagentRunningChip";
import { SubagentThreadIntro } from "./SubagentThreadIntro";
import {
  createSubagentRunVisibilityStore,
  SubagentRunContext,
  type SubagentRunContextValue,
} from "./subagentRunContext";
import {
  CHAT_COLUMN_FRAME_CLASS_NAME,
  CHAT_COLUMN_GUTTER_CLASS_NAME,
} from "./composerPickerStyles";
import { ImportedHistoryButton, useImportedHistory } from "~/projectImport/ImportedHistoryButton";

interface ChatTranscriptPaneProps {
  activeThreadId: string;
  activeTurnId?: TurnId | null;
  activeTurnInProgress: boolean;
  subagentsRunning?: boolean;
  /** What the transcript's subagent cards read from the chat (child threads, controls). */
  subagentRun?: Omit<SubagentRunContextValue, "visibility"> | null;
  /** The newest card with subagents at work; drives the floating "N running" chip. */
  runningSubagentRun?: { entryId: string; runningCount: number } | null;
  subagentThread?: ComponentProps<typeof MessagesTimeline>["subagentThread"];
  collapseFinishedTurns?: boolean;
  activeTurnStartedAt: string | null;
  agentActivityDetail?: AgentActivityDetail | null;
  contentInsetRightPx?: ComponentProps<typeof MessagesTimeline>["contentInsetRightPx"];
  contentInsetBottomPx?: ComponentProps<typeof MessagesTimeline>["contentInsetBottomPx"];
  contentInsetBottomClearancePx?: ComponentProps<
    typeof MessagesTimeline
  >["contentInsetBottomClearancePx"];
  chatFontSizePx: number;
  emptyStateContent?: ReactNode;
  emptyStateProjectName: string | undefined;
  expandedWorkGroups?: Record<string, boolean>;
  hasMessages: boolean;
  isRevertingCheckpoint: boolean;
  isTemporaryThread?: boolean;
  /** A new chat the server has not created yet. The server refuses history requests for it. */
  isLocalDraft?: boolean;
  isProjectImport?: boolean;
  isWorking: boolean;
  workingLabel?: ComponentProps<typeof MessagesTimeline>["workingLabel"];
  followLiveOutput: boolean;
  animateTailAnchorSlide?: ComponentProps<typeof MessagesTimeline>["animateTailAnchorSlide"];
  listRef: RefObject<LegendListRef | null>;
  timelineControllerRef?: RefObject<MessagesTimelineController | null>;
  pinnedMessageIds?: ReadonlySet<MessageId>;
  canPinMessage?: (messageId: MessageId) => boolean;
  onTogglePinMessage?: (messageId: MessageId) => void;
  onForkFromMessage?: (messageId: MessageId) => void;
  goalAchievements?: ComponentProps<typeof MessagesTimeline>["goalAchievements"];
  enteringUserMessageIds?: ComponentProps<typeof MessagesTimeline>["enteringUserMessageIds"];
  tailAnchorMessageId?: ComponentProps<typeof MessagesTimeline>["tailAnchorMessageId"];
  tailAnchorScrollInFlightRef?: ComponentProps<
    typeof MessagesTimeline
  >["tailAnchorScrollInFlightRef"];
  crossTaskOrigin?: ComponentProps<typeof MessagesTimeline>["crossTaskOrigin"];
  forkSource?: ComponentProps<typeof MessagesTimeline>["forkSource"];
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
  onNavigate?: () => void;
  onCloseAgentActivityDetail?: () => void;
  onOpenAgentActivity?: ComponentProps<typeof MessagesTimeline>["onOpenAgentActivity"];
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onOpenThread: (threadId: ThreadId) => void;
  onOpenAutomation?: ComponentProps<typeof MessagesTimeline>["onOpenAutomation"];
  onStopBackgroundTask?: ComponentProps<typeof MessagesTimeline>["onStopBackgroundTask"];
  computerControlEnabled?: ComponentProps<typeof MessagesTimeline>["computerControlEnabled"];
  onEnableComputerControl?: ComponentProps<typeof MessagesTimeline>["onEnableComputerControl"];
  onRevertUserMessage: (messageId: MessageId) => void;
  onUndoTurnFiles?: ComponentProps<typeof MessagesTimeline>["onUndoTurnFiles"];
  onRespondToAsyncUserInput?: ComponentProps<typeof MessagesTimeline>["onRespondToAsyncUserInput"];
  onEditUserMessage?: (messageId: MessageId, text: string) => boolean | Promise<boolean>;
  editableUserMessageId?: MessageId | null;
  onScrollToBottom: () => void;
  onToggleWorkGroup?: (groupId: string) => void;
  resolvedTheme: "light" | "dark";
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  scrollButtonVisible: boolean;
  terminalWorkspaceTerminalTabActive: boolean;
  timelineEntries: ComponentProps<typeof MessagesTimeline>["timelineEntries"];
  messageChangeSignal?: ComponentProps<typeof MessagesTimeline>["messageChangeSignal"];
  hubWorkItemsByMessageId?: ComponentProps<typeof MessagesTimeline>["hubWorkItemsByMessageId"];
  timestampFormat: TimestampFormat;
  /** Sound the message trail moves with (macOS desktop setting). */
  messageTrailAudioSource?: MessageTrailAudioSource;
  /** Core Audio UID of the microphone the trail listens to; "" follows the Mac default. */
  messageTrailMicrophoneId?: string;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  turnTimingByTurnId?: ComponentProps<typeof MessagesTimeline>["turnTimingByTurnId"];
  conversationOnly?: boolean;
  /** Stored thread-level error, rendered in flow above the transcript. */
  threadError?: string | null;
  recoverableTurnId?: ComponentProps<typeof MessagesTimeline>["recoverableTurnId"];
  turnRecoveryDisabled?: boolean;
  onContinueFailedTurn?: ComponentProps<typeof MessagesTimeline>["onContinueFailedTurn"];
  onChangeRecoveryModel?: () => void;
  unblockingThread?: boolean;
  onDismissThreadError?: () => void;
  onUnblockThread?: () => void;
  workspaceRoot: string | undefined;
  keybindings?: ComponentProps<typeof MessagesTimeline>["keybindings"];
  availableEditors?: ComponentProps<typeof MessagesTimeline>["availableEditors"];
  worktreeSetup: WorktreeSetupSnapshot | null;
  worktreeSetupPendingAction?: ComponentProps<
    typeof MessagesTimeline
  >["worktreeSetupPendingAction"];
  onResolveWorktreeSetup?: ComponentProps<typeof MessagesTimeline>["onResolveWorktreeSetup"];
  findHighlightStore?: ThreadFindHighlightStore | null;
}

export function ChatTranscriptPane({
  activeThreadId,
  activeTurnId,
  activeTurnInProgress,
  subagentsRunning,
  subagentRun,
  runningSubagentRun,
  subagentThread,
  collapseFinishedTurns,
  activeTurnStartedAt,
  agentActivityDetail,
  contentInsetRightPx,
  contentInsetBottomPx,
  contentInsetBottomClearancePx,
  chatFontSizePx,
  emptyStateContent,
  emptyStateProjectName,
  expandedWorkGroups,
  hasMessages,
  isRevertingCheckpoint,
  isTemporaryThread,
  isLocalDraft,
  isProjectImport,
  isWorking,
  workingLabel,
  followLiveOutput,
  animateTailAnchorSlide,
  listRef,
  timelineControllerRef,
  pinnedMessageIds,
  canPinMessage,
  onTogglePinMessage,
  onForkFromMessage,
  goalAchievements,
  enteringUserMessageIds,
  tailAnchorMessageId,
  tailAnchorScrollInFlightRef,
  crossTaskOrigin,
  forkSource,
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
  onNavigate,
  onCloseAgentActivityDetail,
  onOpenAgentActivity,
  onOpenTurnDiff,
  onOpenThread,
  onOpenAutomation,
  onStopBackgroundTask,
  computerControlEnabled,
  onEnableComputerControl,
  onRevertUserMessage,
  onUndoTurnFiles,
  onEditUserMessage,
  onRespondToAsyncUserInput,
  editableUserMessageId,
  onScrollToBottom,
  onToggleWorkGroup,
  resolvedTheme,
  revertTurnCountByUserMessageId,
  scrollButtonVisible,
  terminalWorkspaceTerminalTabActive,
  timelineEntries,
  messageChangeSignal,
  hubWorkItemsByMessageId,
  timestampFormat,
  messageTrailAudioSource,
  messageTrailMicrophoneId,
  turnDiffSummaryByAssistantMessageId,
  turnTimingByTurnId,
  conversationOnly,
  threadError,
  recoverableTurnId,
  turnRecoveryDisabled,
  onContinueFailedTurn,
  onChangeRecoveryModel,
  unblockingThread,
  onDismissThreadError,
  onUnblockThread,
  workspaceRoot,
  keybindings,
  availableEditors,
  worktreeSetup,
  worktreeSetupPendingAction,
  onResolveWorktreeSetup,
  findHighlightStore: findHighlightStoreProp,
}: ChatTranscriptPaneProps) {
  // The composer floats over the transcript's bottom edge, so the scroll-to-bottom
  // affordance rides above it on the same inset the transcript content uses.
  const scrollButtonFrameStyle: CSSProperties | undefined =
    contentInsetRightPx || contentInsetBottomPx
      ? {
          ...(contentInsetRightPx ? { paddingRight: contentInsetRightPx } : {}),
          ...(contentInsetBottomPx
            ? { bottom: composerOverlayAffordanceBottomPx(contentInsetBottomPx) }
            : {}),
        }
      : undefined;

  // Left-edge navigation trail: one tick per sent message. Current + visible
  // highlights are pushed up from MessagesTimeline as the viewport scrolls. They
  // flow through a stable store (not pane state) so scroll updates re-render only
  // the trail, not the memoized timeline; reset on thread switch so stale
  // highlights can't linger.
  const [activeTrailStore] = useState(() => createActiveTrailStore());
  const [fallbackFindHighlightStore] = useState(() => createThreadFindHighlightStore());
  const findHighlightStore = findHighlightStoreProp ?? fallbackFindHighlightStore;
  const findHighlight = useSyncExternalStore(
    findHighlightStore.subscribe,
    findHighlightStore.get,
    findHighlightStore.get,
  );
  useEffect(() => {
    activeTrailStore.set(null);
  }, [activeThreadId, activeTrailStore]);
  const importedHistory = useImportedHistory(
    activeThreadId,
    isProjectImport === true && !isTemporaryThread && !isLocalDraft,
  );
  const olderTimelineEntries = useMemo(
    () =>
      importedHistory.messages.map((message) => ({
        id: message.messageId,
        kind: "message" as const,
        createdAt: message.createdAt,
        message: {
          id: message.messageId,
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
          turnId: null,
          streaming: false,
          source: "native" as const,
        },
      })),
    [importedHistory.messages],
  );
  const visibleTimelineEntries = useMemo(
    () =>
      olderTimelineEntries.length ? [...olderTimelineEntries, ...timelineEntries] : timelineEntries,
    [olderTimelineEntries, timelineEntries],
  );
  const olderMessageIds = useMemo(
    () => new Set(importedHistory.messages.map((message) => message.messageId)),
    [importedHistory.messages],
  );
  const canActOnMessage = useCallback(
    (messageId: MessageId) =>
      !olderMessageIds.has(messageId) && (canPinMessage?.(messageId) ?? true),
    [olderMessageIds, canPinMessage],
  );
  const trailItems = deriveMessageTrailItems(visibleTimelineEntries);
  const handleTrailSelect = (messageId: MessageId) => {
    timelineControllerRef?.current?.scrollToMessage(messageId);
  };

  const agentDetailOpen = Boolean(agentActivityDetail && onCloseAgentActivityDetail);

  // Subagent cards report whether they are on screen; the "N running" chip
  // shows only while the card of the subagents still at work is not.
  const [subagentRunVisibility] = useState(() => createSubagentRunVisibilityStore());
  const subagentRunContextValue = useMemo<SubagentRunContextValue | null>(
    () => (subagentRun ? { ...subagentRun, visibility: subagentRunVisibility } : null),
    [subagentRun, subagentRunVisibility],
  );
  const subagentCardPlacements = useSyncExternalStore(
    subagentRunVisibility.subscribe,
    subagentRunVisibility.get,
    subagentRunVisibility.get,
  );
  const runningCardPlacement = runningSubagentRun
    ? (subagentCardPlacements.get(runningSubagentRun.entryId) ?? null)
    : null;
  const subagentChipVisible =
    runningSubagentRun !== null &&
    runningSubagentRun !== undefined &&
    runningCardPlacement !== "visible" &&
    !agentActivityDetail;
  const subagentChipEntryId = runningSubagentRun?.entryId ?? null;
  const handleSubagentChipClick = useCallback(() => {
    if (subagentChipEntryId) {
      timelineControllerRef?.current?.scrollToWorkEntry(subagentChipEntryId);
    }
  }, [subagentChipEntryId, timelineControllerRef]);

  return (
    <div
      data-chat-transcript-pane="true"
      inert={terminalWorkspaceTerminalTabActive}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        terminalWorkspaceTerminalTabActive ? "pointer-events-none invisible" : "",
      )}
    >
      {/* The thread error renders in flow above the transcript rather than as
          a floating overlay, so it can never cover message content. */}
      {!agentActivityDetail &&
      threadError &&
      !visibleTimelineEntries.some(
        (entry) => entry.kind === "work" && entry.entry.turnFailure?.cause === threadError,
      ) ? (
        <div className="flex shrink-0 justify-center px-3 pt-2">
          <ThreadErrorBanner
            error={threadError}
            unblocking={unblockingThread === true}
            {...(onDismissThreadError ? { onDismiss: onDismissThreadError } : {})}
            {...(onUnblockThread ? { onUnblock: onUnblockThread } : {})}
          />
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* The timeline stays mounted under the agent detail: unmounting it would rebuild
            every row and lose the scroll position on Back. The wrapper has no box of its own
            (`contents`), so the timeline's layout and measurement are the same either way. */}
        <div
          className={cn("contents", agentDetailOpen && "pointer-events-none invisible")}
          aria-hidden={agentDetailOpen || undefined}
          inert={agentDetailOpen}
        >
          <SubagentRunContext.Provider value={subagentRunContextValue}>
            <MessagesTimeline
              key={activeThreadId}
              subagentThread={subagentThread ?? null}
              historyHeader={
                importedHistory.nextCursor || importedHistory.error || importedHistory.loading ? (
                  <ImportedHistoryButton history={importedHistory} />
                ) : subagentThread ? (
                  <SubagentThreadIntro subagent={subagentThread} onOpenThread={onOpenThread}
              onStopBackgroundTask={onStopBackgroundTask} />
                ) : undefined
              }
              hasMessages={hasMessages}
              isWorking={isWorking}
              {...(workingLabel ? { workingLabel } : {})}
              worktreeSetup={worktreeSetup}
              worktreeSetupPendingAction={worktreeSetupPendingAction ?? null}
              {...(onResolveWorktreeSetup ? { onResolveWorktreeSetup } : {})}
              activeTurnId={activeTurnId ?? null}
              activeTurnInProgress={activeTurnInProgress}
              subagentsRunning={subagentsRunning === true}
              collapseFinishedTurns={collapseFinishedTurns !== false}
              activeTurnStartedAt={activeTurnStartedAt}
              listRef={listRef}
              {...(timelineControllerRef ? { controllerRef: timelineControllerRef } : {})}
              {...(pinnedMessageIds ? { pinnedMessageIds } : {})}
              canPinMessage={canActOnMessage}
              {...(onTogglePinMessage ? { onTogglePinMessage } : {})}
              {...(onForkFromMessage ? { onForkFromMessage } : {})}
              {...(goalAchievements ? { goalAchievements } : {})}
              {...(enteringUserMessageIds ? { enteringUserMessageIds } : {})}
              tailAnchorMessageId={tailAnchorMessageId ?? null}
              {...(tailAnchorScrollInFlightRef ? { tailAnchorScrollInFlightRef } : {})}
              {...(crossTaskOrigin ? { crossTaskOrigin } : {})}
              {...(forkSource ? { forkSource } : {})}
              isTemporaryThread={isTemporaryThread ?? false}
              timelineEntries={visibleTimelineEntries}
              {...(recoverableTurnId !== undefined ? { recoverableTurnId } : {})}
              {...(turnRecoveryDisabled !== undefined ? { turnRecoveryDisabled } : {})}
              {...(onContinueFailedTurn ? { onContinueFailedTurn } : {})}
              {...(onChangeRecoveryModel ? { onChangeRecoveryModel } : {})}
              hubWorkItemsByMessageId={hubWorkItemsByMessageId}
              messageChangeSignal={messageChangeSignal ?? timelineEntries}
              turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
              turnTimingByTurnId={turnTimingByTurnId}
              conversationOnly={conversationOnly === true}
              onOpenTurnDiff={onOpenTurnDiff}
              onOpenThread={onOpenThread}
              {...(onOpenAutomation ? { onOpenAutomation } : {})}
              {...(computerControlEnabled !== undefined ? { computerControlEnabled } : {})}
              {...(onEnableComputerControl ? { onEnableComputerControl } : {})}
              revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
              onRevertUserMessage={onRevertUserMessage}
              {...(onUndoTurnFiles ? { onUndoTurnFiles } : {})}
              {...(onEditUserMessage ? { onEditUserMessage } : {})}
              {...(onRespondToAsyncUserInput ? { onRespondToAsyncUserInput } : {})}
              editableUserMessageId={editableUserMessageId ?? null}
              isRevertingCheckpoint={isRevertingCheckpoint}
              onImageExpand={onExpandTimelineImage}
              followLiveOutput={followLiveOutput}
              {...(animateTailAnchorSlide !== undefined ? { animateTailAnchorSlide } : {})}
              onIsAtEndChange={onIsAtEndChange}
              {...(onNavigate ? { onNavigate } : {})}
              onTrailHighlightsChange={activeTrailStore.set}
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
              {...(keybindings ? { keybindings } : {})}
              {...(availableEditors ? { availableEditors } : {})}
              contentInsetRightPx={contentInsetRightPx}
              contentInsetBottomPx={contentInsetBottomPx}
              contentInsetBottomClearancePx={contentInsetBottomClearancePx}
              {...(onOpenAgentActivity ? { onOpenAgentActivity } : {})}
              findHighlight={findHighlight}
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
          </SubagentRunContext.Provider>
        </div>
        {agentActivityDetail && onCloseAgentActivityDetail ? (
          <div className="absolute inset-0">
            <AgentActivityDetailView
              detail={agentActivityDetail}
              chatFontSizePx={chatFontSizePx}
              contentInsetRightPx={contentInsetRightPx}
              markdownCwd={markdownCwd}
              onBack={onCloseAgentActivityDetail}
              onImageExpand={onExpandTimelineImage}
              timestampFormat={timestampFormat}
            />
          </div>
        ) : null}

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
                "flex size-8 items-center justify-center rounded-full border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] text-[var(--color-text-foreground)] backdrop-blur-md hover:cursor-pointer",
                // The hover tint is layered over the opaque fill instead of replacing it: the
                // shared elevated hover is a thin ink wash, which alone would let the
                // transcript read through the button.
                "hover:bg-[image:linear-gradient(var(--color-background-elevated-secondary),var(--color-background-elevated-secondary))]",
                scrollButtonVisible ? "pointer-events-auto" : "pointer-events-none",
              )}
            >
              <ArrowDownIcon className="size-3.5" />
            </button>
          </div>
        ) : null}

        {runningSubagentRun ? (
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-6 z-30 py-1",
              DISCLOSURE_CONTENT_MOTION_CLASS,
              subagentChipVisible ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
            )}
            style={scrollButtonFrameStyle}
          >
            <div
              className={cn(CHAT_COLUMN_FRAME_CLASS_NAME, CHAT_COLUMN_GUTTER_CLASS_NAME, "flex")}
            >
              <SubagentRunningChip
                runningCount={runningSubagentRun.runningCount}
                direction={runningCardPlacement === "below" ? "below" : "above"}
                visible={subagentChipVisible}
                onClick={handleSubagentChipClick}
              />
            </div>
          </div>
        ) : null}

        {!agentActivityDetail ? (
          <MessageTrail
            items={trailItems}
            contentInsetRightPx={contentInsetRightPx}
            activeStore={activeTrailStore}
            onSelect={handleTrailSelect}
            subscribeAudioLevel={
              messageTrailAudioSource &&
              messageTrailAudioSource !== "off" &&
              isAudioLevelAvailable()
                ? getAudioLevelSubscriber(messageTrailAudioSource, messageTrailMicrophoneId)
                : undefined
            }
          />
        ) : null}
      </div>
    </div>
  );
}
