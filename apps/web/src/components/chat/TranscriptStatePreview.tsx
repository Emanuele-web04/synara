import { type LegendListRef } from "@legendapp/list/react";
import { type MessageId, type ThreadId, type TurnId } from "@t3tools/contracts";
import { useCallback, useMemo, useRef, type ReactElement } from "react";

import { cn } from "~/lib/utils";
import { ChatTranscriptPane } from "./ChatTranscriptPane";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  deriveLatestRateLimitStatus,
  RateLimitBanner,
  type RateLimitStatus,
} from "./RateLimitBanner";
import {
  rateLimitActivityForState,
  deriveTranscriptStatePreviewMeta,
} from "./TranscriptStatePreviewMeta";
import type { TranscriptScenarioState } from "./transcriptStateFixtures";

const WORKSPACE_ROOT = "/Users/tylersheffield/code/synara";
const EMPTY_WORK_GROUPS: Record<string, boolean> = {};

const noop = (): void => undefined;
const noopImage = (_preview: ExpandedImagePreview): void => undefined;
const noopOpenThread = (_threadId: ThreadId): void => undefined;
const noopOpenTurnDiff = (_turnId: TurnId, _filePath?: string): void => undefined;
const noopRevertUserMessage = (_messageId: MessageId): void => undefined;

interface TranscriptStatePreviewProps {
  readonly state: TranscriptScenarioState;
  readonly className?: string;
}

export function TranscriptStatePreview({
  state,
  className,
}: TranscriptStatePreviewProps): ReactElement {
  const listRef = useRef<LegendListRef | null>(null);
  const meta = useMemo(() => deriveTranscriptStatePreviewMeta(state), [state]);
  const rateLimitStatus = useMemo(() => previewRateLimitStatusForState(state), [state]);
  const shouldTailReflow = useCallback(() => state.followLiveOutput, [state.followLiveOutput]);

  return (
    <section
      data-transcript-state-preview={meta.phase}
      aria-label={`${state.scenario.label} transcript preview`}
      className={cn(
        "grid h-[520px] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg border border-border bg-[var(--color-background-elevated-primary)] lg:h-full lg:min-h-[520px]",
        className,
      )}
    >
      <RateLimitBanner rateLimitStatus={rateLimitStatus} />
      <div className="min-h-0">
        <ChatTranscriptPane
          activeThreadId={state.activeThreadId}
          activeTurnId={state.activeTurnId}
          activeTurnInProgress={state.activeTurnInProgress}
          activeTurnStartedAt={state.activeTurnStartedAt}
          chatFontSizePx={15}
          emptyStateProjectName={undefined}
          expandedWorkGroups={EMPTY_WORK_GROUPS}
          followLiveOutput={state.followLiveOutput}
          hasMessages={state.timelineEntries.length > 0}
          isRevertingCheckpoint={false}
          isWorking={state.isWorking}
          listRef={listRef}
          markdownCwd={WORKSPACE_ROOT}
          nowIso={state.nowIso}
          onExpandTimelineImage={noopImage}
          onIsAtEndChange={noop}
          onMarkdownContentReflow={noop}
          onMessagesClickCapture={noop}
          onMessagesMouseUp={noop}
          onMessagesPointerCancel={noop}
          onMessagesPointerDown={noop}
          onMessagesPointerUp={noop}
          onMessagesScroll={noop}
          onMessagesTouchEnd={noop}
          onMessagesTouchMove={noop}
          onMessagesTouchStart={noop}
          onMessagesWheel={noop}
          onOpenThread={noopOpenThread}
          onOpenTurnDiff={noopOpenTurnDiff}
          onRevertUserMessage={noopRevertUserMessage}
          onScrollToBottom={noop}
          onToggleWorkGroup={noop}
          resolvedTheme="dark"
          revertTurnCountByUserMessageId={state.revertTurnCountByUserMessageId}
          scrollButtonVisible={meta.scrollButtonVisible}
          shouldTailReflow={shouldTailReflow}
          terminalWorkspaceTerminalTabActive={false}
          timelineEntries={state.timelineEntries}
          timestampFormat="locale"
          turnDiffSummaryByAssistantMessageId={state.turnDiffSummaryByAssistantMessageId}
          workspaceRoot={WORKSPACE_ROOT}
        />
      </div>
    </section>
  );
}

function previewRateLimitStatusForState(state: TranscriptScenarioState): RateLimitStatus | null {
  const activity = rateLimitActivityForState(state);
  return activity ? deriveLatestRateLimitStatus([activity]) : null;
}
