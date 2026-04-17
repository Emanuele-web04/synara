import { MessageId, TurnId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { formatShortTimestamp } from "../../timestampFormat";

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

describe("MessagesTimeline", () => {
  it("renders user message metadata outside the bubble shell", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-1"),
              role: "user",
              text: "ship the fix",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map([[MessageId.makeUnsafe("message-1"), 1]])}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("flex w-full justify-end");
    expect(markup).toContain("group flex max-w-[80%] flex-col items-end gap-px");
    expect(markup).toContain(
      "w-max max-w-full min-w-0 self-end rounded-lg border border-border/70",
    );
    expect(markup).toContain("text-muted-foreground/45");
  });

  it("renders plain user text without preformatted shrink-wrap markup", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-plain-user-message",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-plain-user"),
              role: "user",
              text: "tl\ndr",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain(
      "inline-block max-w-full min-w-0 whitespace-pre-wrap break-words font-system-ui",
    );
    expect(markup).not.toContain("<pre");
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-2"),
              role: "user",
              text: [
                "yoo what's @terminal-1:1-5 mean",
                "",
                "<terminal_context>",
                "- Terminal 1 lines 1-5:",
                "  1 | julius@mac effect-http-ws-cli % bun i",
                "  2 | bun install v1.3.9 (cf6cdbbb)",
                "</terminal_context>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("tabler-icon-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
  });

  it("renders trailing user skill tokens with the composer skill pill UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-user-skill-pill",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-user-skill"),
              role: "user",
              text: "$check-code",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Check Code");
    expect(markup).toContain("bg-[var(--info-foreground)]/10");
    expect(markup).not.toContain("$check-code</div>");
  });

  it("renders trailing user subagent mentions with the composer agent pill UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-user-agent-pill",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-user-agent"),
              role: "user",
              text: "@spark(check the UI)",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("@spark");
    expect(markup).toContain("inline-flex max-w-full select-none items-center gap-1 rounded-md");
    expect(markup).toContain("(check the UI)");
    expect(markup).not.toContain("@spark(check the UI)</div>");
  });

  it("renders context compaction entries in the normal work log", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted manually",
              tone: "info",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Context compacted manually");
    expect(markup).not.toContain("Work log");
  });

  it("renders the active compaction label instead of the generic working copy", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-compacting",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-compacting",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Compacting conversation...",
              tone: "info",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Compacting conversation...");
    expect(markup).not.toContain("Working for");
    expect(markup).toContain("h-px flex-1 bg-border");
  });

  it("folds work log summaries into the next assistant message footer", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-work-inline",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "turn",
              tone: "info",
            },
          },
          {
            id: "entry-assistant-inline",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-inline"),
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain(
      `${formatShortTimestamp("2026-03-17T19:12:29.000Z", "locale")} • 1.0s`,
    );
    expect(markup).not.toContain("Work log");
  });

  it("attaches trailing work log summaries to the last assistant reply after completion", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-assistant-trailing",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-trailing"),
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-work-trailing",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "work-trailing-1",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "turn",
              tone: "info",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:31.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain(">done</p>");
    expect(markup).not.toContain("Work log");
    expect(markup).not.toContain('data-timeline-row-kind="work"');
  });

  it("shows the first four inline tool calls and collapses the remainder", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-inline-tools",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-tool-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "tool 1",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.100Z",
            entry: {
              id: "work-inline-tool-2",
              createdAt: "2026-03-17T19:12:28.100Z",
              label: "tool 2",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-3",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.200Z",
            entry: {
              id: "work-inline-tool-3",
              createdAt: "2026-03-17T19:12:28.200Z",
              label: "tool 3",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-4",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.300Z",
            entry: {
              id: "work-inline-tool-4",
              createdAt: "2026-03-17T19:12:28.300Z",
              label: "tool 4",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-5",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.400Z",
            entry: {
              id: "work-inline-tool-5",
              createdAt: "2026-03-17T19:12:28.400Z",
              label: "tool 5",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-6",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.500Z",
            entry: {
              id: "work-inline-tool-6",
              createdAt: "2026-03-17T19:12:28.500Z",
              label: "tool 6",
              tone: "tool",
            },
          },
          {
            id: "entry-assistant-inline-tools",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-inline-tools"),
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Tool 1");
    expect(markup).toContain("Tool 4");
    expect(markup).toContain("+2 more tool calls");
    expect(markup).not.toContain("Tool 5");
    expect(markup).not.toContain("Tool calls");
  });

  it("keeps the latest inline tool calls visible while the turn is still active", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-inline-tools-live-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-live-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "tool 1",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-live-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.100Z",
            entry: {
              id: "work-inline-live-2",
              createdAt: "2026-03-17T19:12:28.100Z",
              label: "tool 2",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-live-3",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.200Z",
            entry: {
              id: "work-inline-live-3",
              createdAt: "2026-03-17T19:12:28.200Z",
              label: "tool 3",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-live-4",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.300Z",
            entry: {
              id: "work-inline-live-4",
              createdAt: "2026-03-17T19:12:28.300Z",
              label: "tool 4",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-live-5",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.400Z",
            entry: {
              id: "work-inline-live-5",
              createdAt: "2026-03-17T19:12:28.400Z",
              label: "tool 5",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-live-6",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.500Z",
            entry: {
              id: "work-inline-live-6",
              createdAt: "2026-03-17T19:12:28.500Z",
              label: "tool 6",
              tone: "tool",
            },
          },
          {
            id: "entry-assistant-inline-tools-live",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-inline-tools-live"),
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain("Tool 1");
    expect(markup).not.toContain("Tool 2");
    expect(markup).toContain("Tool 3");
    expect(markup).toContain("Tool 6");
    expect(markup).toContain("+2 more tool calls");
  });

  it("attaches trailing tool rows to the last assistant reply after completion", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-assistant-final",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-final"),
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-trailing-tool-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.100Z",
            entry: {
              id: "work-trailing-tool-1",
              createdAt: "2026-03-17T19:12:30.100Z",
              label: "tool 1",
              tone: "tool",
            },
          },
          {
            id: "entry-trailing-tool-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.200Z",
            entry: {
              id: "work-trailing-tool-2",
              createdAt: "2026-03-17T19:12:30.200Z",
              label: "tool 2",
              tone: "tool",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:31.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Tool 1");
    expect(markup).toContain("Tool 2");
    expect(markup).not.toContain('data-timeline-row-kind="work"');
  });

  it("expands inline tool calls when the group is toggled open", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-inline-tools-expanded",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-expanded-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "tool 1",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-expanded-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.100Z",
            entry: {
              id: "work-inline-expanded-2",
              createdAt: "2026-03-17T19:12:28.100Z",
              label: "tool 2",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-expanded-3",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.200Z",
            entry: {
              id: "work-inline-expanded-3",
              createdAt: "2026-03-17T19:12:28.200Z",
              label: "tool 3",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-expanded-4",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.300Z",
            entry: {
              id: "work-inline-expanded-4",
              createdAt: "2026-03-17T19:12:28.300Z",
              label: "tool 4",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-expanded-5",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.400Z",
            entry: {
              id: "work-inline-expanded-5",
              createdAt: "2026-03-17T19:12:28.400Z",
              label: "tool 5",
              tone: "tool",
            },
          },
          {
            id: "entry-assistant-inline-tools-expanded",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-inline-tools-expanded"),
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{ "entry-inline-tools-expanded": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Tool 5");
    expect(markup).toContain("Show less");
  });

  it("renders inline file-change tool calls as edited rows with diff stats", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("message-assistant-inline-edit");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-inline-file-change",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-file-change",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File Change",
              tone: "tool",
              requestKind: "file-change",
              changedFiles: ["apps/web/src/components/chat/MessagesTimeline.test.tsx"],
            },
          },
          {
            id: "entry-assistant-inline-edit",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.makeUnsafe("turn-inline-edit-1"),
                completedAt: "2026-03-17T19:12:30.000Z",
                assistantMessageId,
                files: [
                  {
                    path: "apps/web/src/components/chat/MessagesTimeline.test.tsx",
                    additions: 1,
                    deletions: 1,
                  },
                ],
              },
            ],
          ])
        }
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Edited");
    expect(markup).toContain("MessagesTimeline.test.tsx");
    expect(markup).toContain("+1");
    expect(markup).toContain("-1");
    expect(markup).not.toContain(
      "File Change - apps/web/src/components/chat/MessagesTimeline.test.tsx",
    );
  });

  it("renders command rows with a readable summary and keeps the full command on hover", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-inline-command",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-command",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Searched",
              command: `/bin/zsh -lc 'rg -n "ProjectionSnapshotQuery" apps/server/src'`,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Searched");
    expect(markup).toContain("for ProjectionSnapshotQuery in server/src");
    expect(markup).toContain(
      `title="/bin/zsh -lc &#x27;rg -n &quot;ProjectionSnapshotQuery&quot; apps/server/src&#x27;"`,
    );
    expect(markup).not.toContain("&gt;/bin/zsh -lc");
  });

  it("shows a globe icon next to compact web-search rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-inline-web-search",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-web-search",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Web search",
              tone: "tool",
              itemType: "web_search",
              toolTitle: "Searched the web",
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Searched the web");
    expect(markup).toContain("tabler-icon-world");
  });

  it("renders every changed file in the same inline file-change tool call", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("message-assistant-inline-multi-edit");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-inline-multi-file-change",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-multi-file-change",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File Change",
              tone: "tool",
              requestKind: "file-change",
              changedFiles: [
                "apps/web/src/components/chat/MessagesTimeline.test.tsx",
                "apps/web/src/components/chat/MessagesTimeline.tsx",
              ],
            },
          },
          {
            id: "entry-assistant-inline-multi-edit",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.makeUnsafe("turn-inline-multi-edit-1"),
                completedAt: "2026-03-17T19:12:30.000Z",
                assistantMessageId,
                files: [
                  {
                    path: "apps/web/src/components/chat/MessagesTimeline.test.tsx",
                    additions: 1,
                    deletions: 1,
                  },
                  {
                    path: "apps/web/src/components/chat/MessagesTimeline.tsx",
                    additions: 2,
                    deletions: 0,
                  },
                ],
              },
            ],
          ])
        }
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("MessagesTimeline.test.tsx");
    expect(markup).toContain("MessagesTimeline.tsx");
    expect(markup.match(/Edited/g)?.length).toBe(2);
    expect(markup).toContain("+1");
    expect(markup).toContain("-1");
    expect(markup).toContain("+2");
  });

  it("renders inline edited rows from the turn summary when the file-change tool call has no filenames", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("message-assistant-inline-summary-fallback");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-inline-summary-fallback",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-summary-fallback",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File Change",
              tone: "tool",
              requestKind: "file-change",
            },
          },
          {
            id: "entry-assistant-inline-summary-fallback",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.makeUnsafe("turn-inline-summary-fallback-1"),
                completedAt: "2026-03-17T19:12:30.000Z",
                assistantMessageId,
                files: [
                  {
                    path: "apps/web/src/components/chat/ProviderHealth.ts",
                    additions: 63,
                    deletions: 4,
                  },
                  {
                    path: "apps/web/src/components/ChatView.tsx",
                    additions: 41,
                    deletions: 5,
                  },
                ],
              },
            ],
          ])
        }
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Edited");
    expect(markup).toContain("ProviderHealth.ts");
    expect(markup).toContain("ChatView.tsx");
    expect(markup).toContain("+63");
    expect(markup).toContain("-4");
    expect(markup).toContain("+41");
    expect(markup).toContain("-5");
    expect(markup).not.toContain(">File Change<");
  });

  it("renders a collapsible changed files header with ui-font filenames", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("message-assistant-diff");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-assistant-diff",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.makeUnsafe("turn-diff-1"),
                completedAt: "2026-03-17T19:12:30.000Z",
                assistantMessageId,
                files: [
                  { path: "apps/web/src/components/Sidebar.tsx", additions: 6, deletions: 5 },
                ],
              },
            ],
          ])
        }
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("1 File changed");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("font-chat-code truncate font-normal");
    expect(markup).toContain("apps/web/src/components/Sidebar.tsx");
  });
});
