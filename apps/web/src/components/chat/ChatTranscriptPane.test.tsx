import { MessageId, ThreadId } from "@synara/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatTranscriptPane } from "./ChatTranscriptPane";

function renderTranscriptPaneMarkup(
  props: Partial<ComponentProps<typeof ChatTranscriptPane>> = {},
) {
  return renderToStaticMarkup(
    <ChatTranscriptPane
      activeThreadId="thread-1"
      activeTurnId={null}
      activeTurnInProgress={false}
      activeTurnStartedAt={null}
      chatFontSizePx={14}
      emptyStateProjectName={undefined}
      hasMessages
      isRevertingCheckpoint={false}
      isWorking={false}
      worktreeSetup={null}
      followLiveOutput={false}
      listRef={createRef<LegendListRef | null>()}
      markdownCwd={undefined}
      onExpandTimelineImage={() => {}}
      onIsAtEndChange={() => {}}
      onMessagesClickCapture={() => {}}
      onMessagesMouseUp={() => {}}
      onMessagesPointerCancel={() => {}}
      onMessagesPointerDown={() => {}}
      onMessagesPointerUp={() => {}}
      onMessagesScroll={() => {}}
      onMessagesTouchEnd={() => {}}
      onMessagesTouchMove={() => {}}
      onMessagesTouchStart={() => {}}
      onMessagesWheel={() => {}}
      onOpenTurnDiff={() => {}}
      onOpenThread={(_threadId: ThreadId) => {}}
      onRevertUserMessage={(_messageId: MessageId) => {}}
      onScrollToBottom={() => {}}
      resolvedTheme="light"
      revertTurnCountByUserMessageId={new Map()}
      scrollButtonVisible
      terminalWorkspaceTerminalTabActive={false}
      timelineEntries={[]}
      timestampFormat="locale"
      turnDiffSummaryByAssistantMessageId={new Map()}
      workspaceRoot={undefined}
      {...props}
    />,
  );
}

describe("ChatTranscriptPane", () => {
  it("renders agent activity detail in place of the message timeline", () => {
    const markup = renderTranscriptPaneMarkup({
      agentActivityDetail: {
        id: "agent-task-1",
        title: "Agent task",
        summary: "Checked the sidebar issue.",
        primaryEntry: {
          id: "agent-task-1",
          createdAt: "2026-06-05T00:00:00.000Z",
          label: "Agent task",
          tone: "tool",
          itemType: "collab_agent_tool_call",
          detail: "Checked the sidebar issue.",
        },
        entries: [
          {
            id: "agent-task-1",
            createdAt: "2026-06-05T00:00:00.000Z",
            label: "Agent task",
            tone: "tool",
            itemType: "collab_agent_tool_call",
            detail: "Checked the sidebar issue.",
          },
        ],
      },
      onCloseAgentActivityDetail: () => {},
    });

    expect(markup).toContain('data-agent-activity-detail="true"');
    expect(markup).toContain("Back");
    expect(markup).toContain("Checked the sidebar issue.");
    expect(markup).not.toContain("Scroll to bottom");
  });

  it("centers the scroll button inside the inset chat column", () => {
    const markup = renderTranscriptPaneMarkup({
      contentInsetRightPx: 360,
      scrollButtonVisible: true,
    });

    expect(markup).toContain('style="padding-right:360px"');
    expect(markup).toContain("Scroll to bottom");
  });

  it("does not host the in-thread find bar as a transcript overlay", () => {
    const markup = renderTranscriptPaneMarkup();

    expect(markup).not.toContain('data-testid="thread-find-bar"');
    expect(markup).not.toContain("absolute right-2 top-2");
  });

  it("renders a stored thread error in flow above the transcript, never as an overlay", () => {
    const markup = renderTranscriptPaneMarkup({
      threadError: "Provider adapter request failed (grok): connect ETIMEDOUT",
      onDismissThreadError: () => {},
    });

    expect(markup).toContain("Provider adapter request failed (grok): connect ETIMEDOUT");
    expect(markup).toContain('role="alert"');
    // In flow above the transcript — an absolute overlay would cover whatever
    // message happens to sit at the top of the scroll region.
    expect(markup).not.toContain("pointer-events-none absolute inset-x-0 top-2");
    expect(markup).toContain("shrink-0");
    expect(markup).not.toContain("Unblock thread");
  });

  it("keeps the transcript clean when no thread error is stored", () => {
    const markup = renderTranscriptPaneMarkup({ threadError: null });

    expect(markup).not.toContain('role="alert"');
  });
});
