import "../../index.css";

import { MessageId } from "@t3tools/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { page } from "vitest/browser";
import {
  Profiler,
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ProfilerOnRenderCallback,
} from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ChatTranscriptPane } from "./ChatTranscriptPane";
import { TranscriptSelectionActionLayer } from "./TranscriptSelectionActionLayer";
import { useTranscriptAssistantSelectionAction } from "./useTranscriptAssistantSelectionAction";
import { COLLAPSED_USER_MESSAGE_MAX_CHARS } from "./userMessagePreview";
import ChatMarkdown from "../ChatMarkdown";
import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  getScrollContainerDistanceFromBottom,
} from "../../chat-scroll";

const EMPTY_WORK_GROUPS: Record<string, boolean> = {};
const EMPTY_TURN_DIFFS = new Map();
const EMPTY_REVERT_COUNTS = new Map();
const NOOP = () => {};
const TIMELINE_ENTRIES = [
  {
    id: "assistant-message-entry",
    kind: "message" as const,
    createdAt: "2026-03-17T19:12:28.000Z",
    message: {
      id: MessageId.makeUnsafe("assistant-message-1"),
      role: "assistant" as const,
      text: "This is a stable assistant message for the transcript perf harness.",
      createdAt: "2026-03-17T19:12:28.000Z",
      streaming: false,
    },
  },
];
type TranscriptTimelineEntries = ComponentProps<typeof ChatTranscriptPane>["timelineEntries"];

function assistantEntry(
  id: string,
  text: string,
  streaming = false,
): TranscriptTimelineEntries[number] {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: "2026-03-17T19:12:28.000Z",
    message: {
      id: MessageId.makeUnsafe(id),
      role: "assistant",
      text,
      createdAt: "2026-03-17T19:12:28.000Z",
      streaming,
    },
  };
}

async function waitForScrollContainer(): Promise<HTMLElement> {
  await vi.waitFor(() => {
    expect(document.querySelector("[data-chat-scroll-container='true']")).toBeInstanceOf(
      HTMLElement,
    );
  });
  return document.querySelector<HTMLElement>("[data-chat-scroll-container='true']")!;
}

function TranscriptScrollHarness() {
  const listRef = useRef<LegendListRef | null>(null);
  const [isAtEnd, setIsAtEnd] = useState(true);
  const [tailLines, setTailLines] = useState(1);
  const timelineEntries: TranscriptTimelineEntries = [
    ...Array.from({ length: 36 }, (_, index) =>
      assistantEntry(`history-${index}`, `History row ${index}\n\n${"filler ".repeat(80)}`),
    ),
    assistantEntry(
      "streaming-tail",
      Array.from({ length: tailLines }, (_, index) => `Streaming tail line ${index}`).join("\n\n"),
      true,
    ),
  ];

  const handleMarkdownContentReflow = useCallback(() => {
    if (isAtEnd) {
      listRef.current?.scrollToEnd?.({ animated: false });
    }
  }, [isAtEnd]);
  const shouldTailReflow = useCallback(() => isAtEnd, [isAtEnd]);

  return (
    <div>
      <button type="button" onClick={() => setTailLines((current) => current + 8)}>
        Append tail text
      </button>
      <div style={{ display: "flex", height: 420, width: 720 }}>
        <ChatTranscriptPane
          activeThreadId="thread-scroll-follow"
          activeTurnInProgress
          activeTurnStartedAt="2026-03-17T19:12:28.000Z"
          chatFontSizePx={15}
          emptyStateProjectName={undefined}
          expandedWorkGroups={EMPTY_WORK_GROUPS}
          hasMessages
          isRevertingCheckpoint={false}
          isWorking={false}
          followLiveOutput={false}
          listRef={listRef}
          markdownCwd={undefined}
          onExpandTimelineImage={NOOP}
          onMessagesClickCapture={NOOP}
          onMessagesMouseUp={NOOP}
          onMessagesPointerCancel={NOOP}
          onMessagesPointerDown={NOOP}
          onMessagesPointerUp={NOOP}
          onMessagesScroll={NOOP}
          onMessagesTouchEnd={NOOP}
          onMessagesTouchMove={NOOP}
          onMessagesTouchStart={NOOP}
          onMessagesWheel={NOOP}
          onIsAtEndChange={setIsAtEnd}
          onOpenTurnDiff={NOOP}
          onOpenThread={NOOP}
          onRevertUserMessage={NOOP}
          onScrollToBottom={() => listRef.current?.scrollToEnd?.({ animated: false })}
          onMarkdownContentReflow={handleMarkdownContentReflow}
          shouldTailReflow={shouldTailReflow}
          onToggleWorkGroup={NOOP}
          resolvedTheme="dark"
          revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
          scrollButtonVisible={!isAtEnd}
          terminalWorkspaceTerminalTabActive={false}
          timelineEntries={timelineEntries}
          timestampFormat="locale"
          turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFFS}
          workspaceRoot={undefined}
        />
      </div>
    </div>
  );
}

const ComposerAdjacentProbe = memo(function ComposerAdjacentProbe() {
  return <div data-composer-adjacent="true">Composer controls stay local</div>;
});

type StreamingProfilerId =
  | "chat-view-shell"
  | "chat-transcript-pane"
  | "chat-markdown"
  | "composer-adjacent";

function StreamingRenderProfilerHarness(props: { onRender: (id: StreamingProfilerId) => void }) {
  const onRender = props.onRender;
  const listRef = useRef<LegendListRef | null>(null);
  const [tailLines, setTailLines] = useState(1);
  const tailText = useMemo(
    () =>
      Array.from({ length: tailLines }, (_, index) => `Streaming profiler line ${index}`).join(
        "\n\n",
      ),
    [tailLines],
  );
  const timelineEntries: TranscriptTimelineEntries = useMemo(
    () => [
      assistantEntry("profiler-history", "Profiler history row stays stable."),
      assistantEntry("profiler-streaming-tail", tailText, true),
    ],
    [tailText],
  );
  const onProfilerRender = useCallback<ProfilerOnRenderCallback>(
    (id) => {
      if (
        id === "chat-view-shell" ||
        id === "chat-transcript-pane" ||
        id === "chat-markdown" ||
        id === "composer-adjacent"
      ) {
        onRender(id);
      }
    },
    [onRender],
  );

  return (
    <Profiler id="chat-view-shell" onRender={onProfilerRender}>
      <button type="button" onClick={() => setTailLines((current) => current + 1)}>
        Append profiler token
      </button>
      <Profiler id="composer-adjacent" onRender={onProfilerRender}>
        <ComposerAdjacentProbe />
      </Profiler>
      <div style={{ display: "flex", height: 320, width: 720 }}>
        <Profiler id="chat-transcript-pane" onRender={onProfilerRender}>
          <ChatTranscriptPane
            activeThreadId="thread-render-profiler"
            activeTurnInProgress
            activeTurnStartedAt="2026-03-17T19:12:28.000Z"
            chatFontSizePx={15}
            emptyStateProjectName={undefined}
            expandedWorkGroups={EMPTY_WORK_GROUPS}
            hasMessages
            isRevertingCheckpoint={false}
            isWorking={false}
            followLiveOutput={false}
            listRef={listRef}
            markdownCwd={undefined}
            onExpandTimelineImage={NOOP}
            onMessagesClickCapture={NOOP}
            onMessagesMouseUp={NOOP}
            onMessagesPointerCancel={NOOP}
            onMessagesPointerDown={NOOP}
            onMessagesPointerUp={NOOP}
            onMessagesScroll={NOOP}
            onMessagesTouchEnd={NOOP}
            onMessagesTouchMove={NOOP}
            onMessagesTouchStart={NOOP}
            onMessagesWheel={NOOP}
            onIsAtEndChange={NOOP}
            onOpenTurnDiff={NOOP}
            onOpenThread={NOOP}
            onRevertUserMessage={NOOP}
            onScrollToBottom={NOOP}
            onToggleWorkGroup={NOOP}
            resolvedTheme="dark"
            revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
            scrollButtonVisible={false}
            terminalWorkspaceTerminalTabActive={false}
            timelineEntries={timelineEntries}
            timestampFormat="locale"
            turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFFS}
            workspaceRoot={undefined}
          />
        </Profiler>
      </div>
      <Profiler id="chat-markdown" onRender={onProfilerRender}>
        <ChatMarkdown text={tailText} cwd={undefined} isStreaming />
      </Profiler>
    </Profiler>
  );
}

function LiveLogWorkChurnHarness() {
  const listRef = useRef<LegendListRef | null>(null);
  const [workRevision, setWorkRevision] = useState(0);
  const [extraMessages, setExtraMessages] = useState<TranscriptTimelineEntries>([]);
  const timelineEntries: TranscriptTimelineEntries = [
    assistantEntry("live-log-assistant-1", "Initial answer"),
    {
      id: "entry-live-log-work",
      kind: "work",
      createdAt: "2026-03-17T19:12:29.000Z",
      entry: {
        id: "live-log-work",
        createdAt: "2026-03-17T19:12:29.000Z",
        label: `Ran command revision ${workRevision}`,
        tone: "tool",
        itemType: "command_execution",
        toolTitle: "Ran command",
        command: `echo ${workRevision}`,
      },
    },
    ...extraMessages,
  ];

  return (
    <div>
      <button type="button" onClick={() => setWorkRevision((current) => current + 1)}>
        Update work row
      </button>
      <button
        type="button"
        onClick={() =>
          setExtraMessages((current) => [
            ...current,
            {
              id: "entry-live-log-user",
              kind: "message",
              createdAt: "2026-03-17T19:12:30.000Z",
              message: {
                id: MessageId.makeUnsafe("live-log-user"),
                role: "user",
                text: "Follow-up question",
                createdAt: "2026-03-17T19:12:30.000Z",
                streaming: false,
              },
            },
          ])
        }
      >
        Append user message
      </button>
      <button
        type="button"
        onClick={() =>
          setExtraMessages((current) => [
            ...current,
            assistantEntry("live-log-assistant-2", "Second answer"),
          ])
        }
      >
        Append assistant message
      </button>
      <div style={{ display: "flex", height: 320, width: 720 }}>
        <ChatTranscriptPane
          activeThreadId="thread-live-log-work-churn"
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          chatFontSizePx={15}
          emptyStateProjectName={undefined}
          expandedWorkGroups={EMPTY_WORK_GROUPS}
          hasMessages
          isRevertingCheckpoint={false}
          isWorking={false}
          followLiveOutput={false}
          listRef={listRef}
          markdownCwd={undefined}
          onExpandTimelineImage={NOOP}
          onMessagesClickCapture={NOOP}
          onMessagesMouseUp={NOOP}
          onMessagesPointerCancel={NOOP}
          onMessagesPointerDown={NOOP}
          onMessagesPointerUp={NOOP}
          onMessagesScroll={NOOP}
          onMessagesTouchEnd={NOOP}
          onMessagesTouchMove={NOOP}
          onMessagesTouchStart={NOOP}
          onMessagesWheel={NOOP}
          onIsAtEndChange={NOOP}
          onOpenTurnDiff={NOOP}
          onOpenThread={NOOP}
          onRevertUserMessage={NOOP}
          onScrollToBottom={NOOP}
          onToggleWorkGroup={NOOP}
          resolvedTheme="dark"
          revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
          scrollButtonVisible={false}
          terminalWorkspaceTerminalTabActive={false}
          timelineEntries={timelineEntries}
          timestampFormat="locale"
          turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFFS}
          workspaceRoot={undefined}
        />
      </div>
    </div>
  );
}

function TranscriptPerfHarness(props: { onTranscriptRender: () => void }) {
  const [composerValue, setComposerValue] = useState("");
  const composerImagesRef = useRef<readonly []>([]);
  const composerFilesRef = useRef<readonly []>([]);
  const composerAssistantSelectionsRef = useRef<readonly []>([]);
  const listRef = useRef<LegendListRef | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);
  const {
    pendingTranscriptSelectionAction,
    commitTranscriptAssistantSelection,
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
  } = useTranscriptAssistantSelectionAction({
    threadId: "thread-transcript-perf",
    enabled: true,
    transcriptContainerRef,
    composerImagesRef,
    composerFilesRef,
    composerAssistantSelectionsRef,
    addComposerAssistantSelectionToDraft: () => true,
    scheduleComposerFocus: NOOP,
    onMessagesClickCaptureBase: NOOP,
    onMessagesPointerCancelBase: NOOP,
    onMessagesPointerDownBase: NOOP,
    onMessagesPointerUpBase: NOOP,
    onMessagesScrollBase: NOOP,
    onMessagesTouchEndBase: NOOP,
    onMessagesTouchMoveBase: NOOP,
    onMessagesTouchStartBase: NOOP,
    onMessagesWheelBase: NOOP,
  });
  const handleComposerChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setComposerValue(event.target.value);
  }, []);
  const handleTranscriptRender = useCallback<ProfilerOnRenderCallback>(() => {
    props.onTranscriptRender();
  }, [props]);

  return (
    <div>
      <label htmlFor="composer-input">Composer</label>
      <input
        id="composer-input"
        placeholder="Type composer text"
        value={composerValue}
        onChange={handleComposerChange}
      />
      <Profiler id="chat-transcript-pane" onRender={handleTranscriptRender}>
        <ChatTranscriptPane
          activeThreadId="thread-transcript-perf"
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          chatFontSizePx={15}
          emptyStateProjectName={undefined}
          expandedWorkGroups={EMPTY_WORK_GROUPS}
          hasMessages
          isRevertingCheckpoint={false}
          isWorking={false}
          followLiveOutput={false}
          listRef={listRef}
          transcriptContainerRef={transcriptContainerRef}
          markdownCwd={undefined}
          onExpandTimelineImage={NOOP}
          onMessagesClickCapture={onMessagesClickCapture}
          onMessagesMouseUp={onMessagesMouseUp}
          onMessagesPointerCancel={onMessagesPointerCancel}
          onMessagesPointerDown={onMessagesPointerDown}
          onMessagesPointerUp={onMessagesPointerUp}
          onMessagesScroll={onMessagesScroll}
          onMessagesTouchEnd={onMessagesTouchEnd}
          onMessagesTouchMove={onMessagesTouchMove}
          onMessagesTouchStart={onMessagesTouchStart}
          onMessagesWheel={onMessagesWheel}
          onIsAtEndChange={NOOP}
          onOpenTurnDiff={NOOP}
          onOpenThread={NOOP}
          onRevertUserMessage={NOOP}
          onScrollToBottom={NOOP}
          onToggleWorkGroup={NOOP}
          resolvedTheme="dark"
          revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
          scrollButtonVisible={false}
          terminalWorkspaceTerminalTabActive={false}
          timelineEntries={TIMELINE_ENTRIES}
          timestampFormat="locale"
          turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFFS}
          workspaceRoot={undefined}
        />
      </Profiler>
      <TranscriptSelectionActionLayer
        action={pendingTranscriptSelectionAction}
        onAddToChat={commitTranscriptAssistantSelection}
      />
    </div>
  );
}

function textNodeContaining(root: ParentNode, text: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let currentNode = walker.nextNode();
  while (currentNode) {
    if (currentNode.textContent?.includes(text)) {
      return currentNode as Text;
    }
    currentNode = walker.nextNode();
  }
  throw new Error(`Unable to find text node containing "${text}".`);
}

describe("ChatTranscriptPane", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not re-render the transcript subtree when only composer text changes", async () => {
    let transcriptCommitCount = 0;

    const screen = await render(
      <TranscriptPerfHarness
        onTranscriptRender={() => {
          transcriptCommitCount += 1;
        }}
      />,
    );
    try {
      await vi.waitFor(() => {
        expect(transcriptCommitCount).toBeGreaterThan(0);
      });

      const baselineCommitCount = transcriptCommitCount;
      await page.getByPlaceholder("Type composer text").fill("reply follow up");

      await vi.waitFor(() => {
        expect(screen.container.querySelector("#composer-input")).toHaveValue("reply follow up");
      });

      expect(transcriptCommitCount).toBe(baselineCommitCount);
    } finally {
      await screen.unmount();
    }
  });

  it("records streaming token render boundaries without rerendering composer-adjacent controls", async () => {
    const renderCounts = {
      "chat-view-shell": 0,
      "chat-transcript-pane": 0,
      "chat-markdown": 0,
      "composer-adjacent": 0,
    };

    const screen = await render(
      <StreamingRenderProfilerHarness
        onRender={(id) => {
          renderCounts[id] += 1;
        }}
      />,
    );
    try {
      await vi.waitFor(() => {
        expect(renderCounts["chat-view-shell"]).toBeGreaterThan(0);
        expect(renderCounts["chat-transcript-pane"]).toBeGreaterThan(0);
        expect(renderCounts["chat-markdown"]).toBeGreaterThan(0);
        expect(renderCounts["composer-adjacent"]).toBeGreaterThan(0);
      });

      const baselineCounts = { ...renderCounts };
      const stableHistoryRow = screen.container.querySelector(
        '[data-message-id="profiler-history"]',
      );
      expect(stableHistoryRow).toBeInstanceOf(HTMLElement);

      await page.getByRole("button", { name: "Append profiler token" }).click();

      await vi.waitFor(() => {
        expect(screen.container.textContent).toContain("Streaming profiler line 1");
      });

      expect(renderCounts["chat-view-shell"]).toBeGreaterThan(baselineCounts["chat-view-shell"]);
      expect(renderCounts["chat-transcript-pane"]).toBeGreaterThan(
        baselineCounts["chat-transcript-pane"],
      );
      expect(renderCounts["chat-markdown"]).toBeGreaterThan(baselineCounts["chat-markdown"]);
      expect(renderCounts["composer-adjacent"]).toBe(baselineCounts["composer-adjacent"]);
      expect(screen.container.querySelector('[data-message-id="profiler-history"]')).toBe(
        stableHistoryRow,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("announces new message rows without re-announcing work row churn", async () => {
    const screen = await render(<LiveLogWorkChurnHarness />);
    try {
      const liveLog = screen.container.querySelector("[role='log']");
      expect(liveLog?.textContent).toBe("Assistant: Initial answer");

      await page.getByRole("button", { name: "Update work row" }).click();

      expect(liveLog?.textContent).toBe("Assistant: Initial answer");

      await page.getByRole("button", { name: "Append user message" }).click();

      await vi.waitFor(() => {
        expect(liveLog?.textContent).toBe("You: Follow-up question");
      });

      await page.getByRole("button", { name: "Append assistant message" }).click();

      await vi.waitFor(() => {
        expect(liveLog?.textContent).toBe("Assistant: Second answer");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("reveals and dismisses assistant selection actions from keyboard-created selections", async () => {
    const screen = await render(
      <TranscriptPerfHarness
        onTranscriptRender={() => {
          return;
        }}
      />,
    );
    try {
      const composerInput = screen.container.querySelector<HTMLInputElement>("#composer-input");
      expect(composerInput).toBeInstanceOf(HTMLInputElement);
      composerInput?.focus();

      const assistantContent = screen.container.querySelector(
        '[data-assistant-message-id="assistant-message-1"]',
      );
      expect(assistantContent).toBeInstanceOf(HTMLElement);
      const textNode = textNodeContaining(assistantContent!, "stable assistant message");
      const offset = textNode.textContent?.indexOf("stable assistant message") ?? -1;
      expect(offset).toBeGreaterThanOrEqual(0);

      const range = document.createRange();
      range.setStart(textNode, offset);
      range.setEnd(textNode, offset + "stable assistant message".length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));

      await expect.element(page.getByRole("button", { name: "Add to chat" })).toBeInTheDocument();

      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );

      await vi.waitFor(() => {
        expect(screen.container.querySelector('[data-transcript-selection-action="true"]')).toBe(
          null,
        );
      });
      expect(window.getSelection()?.rangeCount).toBe(0);
      expect(document.activeElement).toBe(composerInput);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the mobile scroll-to-bottom target large enough for touch", async () => {
    await page.viewport(390, 844);
    const screen = await render(
      <ChatTranscriptPane
        activeThreadId="thread-mobile-scroll-target"
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        chatFontSizePx={15}
        emptyStateProjectName={undefined}
        hasMessages
        isRevertingCheckpoint={false}
        isWorking={false}
        followLiveOutput={false}
        listRef={{ current: null }}
        markdownCwd={undefined}
        onExpandTimelineImage={NOOP}
        onMessagesClickCapture={NOOP}
        onMessagesMouseUp={NOOP}
        onMessagesPointerCancel={NOOP}
        onMessagesPointerDown={NOOP}
        onMessagesPointerUp={NOOP}
        onMessagesScroll={NOOP}
        onMessagesTouchEnd={NOOP}
        onMessagesTouchMove={NOOP}
        onMessagesTouchStart={NOOP}
        onMessagesWheel={NOOP}
        onIsAtEndChange={NOOP}
        onOpenTurnDiff={NOOP}
        onOpenThread={NOOP}
        onRevertUserMessage={NOOP}
        onScrollToBottom={NOOP}
        resolvedTheme="dark"
        revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
        scrollButtonVisible
        terminalWorkspaceTerminalTabActive={false}
        timelineEntries={[assistantEntry("mobile-scroll-target-message", "Mobile transcript")]}
        timestampFormat="locale"
        turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFFS}
        workspaceRoot={undefined}
      />,
    );
    try {
      const button = screen.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Scroll to bottom"]',
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      const bounds = button!.getBoundingClientRect();
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    } finally {
      await page.viewport(1280, 720);
      await screen.unmount();
    }
  });

  it("follows streaming tail growth while already pinned to the bottom", async () => {
    const screen = await render(<TranscriptScrollHarness />);
    try {
      const scroller = await waitForScrollContainer();
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event("scroll"));

      await expect
        .poll(() => getScrollContainerDistanceFromBottom(scroller))
        .toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
      const liveLog = screen.container.querySelector("[role='log']");
      expect(liveLog?.textContent).toBe("Assistant: Streaming tail line 0");

      await page.getByRole("button", { name: "Append tail text" }).click();

      await expect
        .poll(() => getScrollContainerDistanceFromBottom(scroller))
        .toBeLessThanOrEqual(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
      expect(liveLog?.textContent).toBe("Assistant: Streaming tail line 0");
    } finally {
      await screen.unmount();
    }
  });

  it("does not force-follow streaming tail growth after the user scrolls away", async () => {
    const screen = await render(<TranscriptScrollHarness />);
    try {
      const scroller = await waitForScrollContainer();
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 240);
      scroller.dispatchEvent(new Event("scroll"));

      await expect
        .poll(() => getScrollContainerDistanceFromBottom(scroller))
        .toBeGreaterThan(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);

      await page.getByRole("button", { name: "Append tail text" }).click();

      await expect
        .poll(() => getScrollContainerDistanceFromBottom(scroller))
        .toBeGreaterThan(AUTO_SCROLL_BOTTOM_THRESHOLD_PX);
      await expect
        .element(page.getByRole("button", { name: "Scroll to bottom" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("settles collapsed message disclosure immediately enough under reduced motion", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const hiddenTail = "REDUCED_MOTION_TAIL";
    const longUserText = `${"r".repeat(COLLAPSED_USER_MESSAGE_MAX_CHARS)}${hiddenTail}`;

    const screen = await render(
      <ChatTranscriptPane
        activeThreadId="thread-user-message-reduced-motion"
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        chatFontSizePx={15}
        emptyStateProjectName={undefined}
        hasMessages
        isRevertingCheckpoint={false}
        isWorking={false}
        followLiveOutput={false}
        listRef={{ current: null }}
        markdownCwd={undefined}
        onExpandTimelineImage={NOOP}
        onMessagesClickCapture={NOOP}
        onMessagesMouseUp={NOOP}
        onMessagesPointerCancel={NOOP}
        onMessagesPointerDown={NOOP}
        onMessagesPointerUp={NOOP}
        onMessagesScroll={NOOP}
        onMessagesTouchEnd={NOOP}
        onMessagesTouchMove={NOOP}
        onMessagesTouchStart={NOOP}
        onMessagesWheel={NOOP}
        onIsAtEndChange={NOOP}
        onOpenTurnDiff={NOOP}
        onOpenThread={NOOP}
        onRevertUserMessage={NOOP}
        onScrollToBottom={NOOP}
        resolvedTheme="dark"
        revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
        scrollButtonVisible={false}
        terminalWorkspaceTerminalTabActive={false}
        timelineEntries={[
          {
            id: "reduced-motion-user-message-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("reduced-motion-user-message"),
              role: "user",
              text: longUserText,
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        timestampFormat="locale"
        turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFFS}
        workspaceRoot={undefined}
      />,
    );
    try {
      await page.getByText("Show more").click();

      await vi.waitFor(() => {
        expect(screen.container.textContent).toContain(hiddenTail);
      });
      await expect.element(page.getByText("Show less")).toBeInTheDocument();
    } finally {
      window.matchMedia = originalMatchMedia;
      await screen.unmount();
    }
  });

  it("expands collapsed user messages from the Show more control", async () => {
    const hiddenTail = "TAIL_SHOULD_APPEAR_AFTER_EXPAND";
    const longUserText = `${"a".repeat(COLLAPSED_USER_MESSAGE_MAX_CHARS)}${hiddenTail}`;

    const screen = await render(
      <ChatTranscriptPane
        activeThreadId="thread-user-message-expand"
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        chatFontSizePx={15}
        emptyStateProjectName={undefined}
        hasMessages
        isRevertingCheckpoint={false}
        isWorking={false}
        followLiveOutput={false}
        listRef={{ current: null }}
        markdownCwd={undefined}
        onExpandTimelineImage={NOOP}
        onMessagesClickCapture={NOOP}
        onMessagesMouseUp={NOOP}
        onMessagesPointerCancel={NOOP}
        onMessagesPointerDown={NOOP}
        onMessagesPointerUp={NOOP}
        onMessagesScroll={NOOP}
        onMessagesTouchEnd={NOOP}
        onMessagesTouchMove={NOOP}
        onMessagesTouchStart={NOOP}
        onMessagesWheel={NOOP}
        onIsAtEndChange={NOOP}
        onOpenTurnDiff={NOOP}
        onOpenThread={NOOP}
        onRevertUserMessage={NOOP}
        onScrollToBottom={NOOP}
        resolvedTheme="dark"
        revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
        scrollButtonVisible={false}
        terminalWorkspaceTerminalTabActive={false}
        timelineEntries={[
          {
            id: "user-message-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("user-message-expand"),
              role: "user",
              text: longUserText,
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        timestampFormat="locale"
        turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFFS}
        workspaceRoot={undefined}
      />,
    );
    try {
      expect(screen.container.textContent).not.toContain(hiddenTail);
      expect(screen.container.querySelector("button[data-scroll-anchor-ignore]")?.textContent).toBe(
        "Show more",
      );

      await page.getByText("Show more").click();

      await vi.waitFor(() => {
        expect(screen.container.textContent).toContain(hiddenTail);
      });
      await expect.element(page.getByText("Show less")).toBeInTheDocument();
      expect(screen.container.querySelector("button[data-scroll-anchor-ignore]")?.textContent).toBe(
        "Show less",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("keeps neighboring transcript rows mounted when a user message disclosure toggles", async () => {
    const hiddenTail = "MIDDLE_TAIL_SHOULD_APPEAR_AFTER_EXPAND";
    const longUserText = `${"b".repeat(COLLAPSED_USER_MESSAGE_MAX_CHARS)}${hiddenTail}`;

    const screen = await render(
      <ChatTranscriptPane
        activeThreadId="thread-user-message-local-toggle"
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        chatFontSizePx={15}
        emptyStateProjectName={undefined}
        hasMessages
        isRevertingCheckpoint={false}
        isWorking={false}
        followLiveOutput={false}
        listRef={{ current: null }}
        markdownCwd={undefined}
        onExpandTimelineImage={NOOP}
        onMessagesClickCapture={NOOP}
        onMessagesMouseUp={NOOP}
        onMessagesPointerCancel={NOOP}
        onMessagesPointerDown={NOOP}
        onMessagesPointerUp={NOOP}
        onMessagesScroll={NOOP}
        onMessagesTouchEnd={NOOP}
        onMessagesTouchMove={NOOP}
        onMessagesTouchStart={NOOP}
        onMessagesWheel={NOOP}
        onIsAtEndChange={NOOP}
        onOpenTurnDiff={NOOP}
        onOpenThread={NOOP}
        onRevertUserMessage={NOOP}
        onScrollToBottom={NOOP}
        resolvedTheme="dark"
        revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
        scrollButtonVisible={false}
        terminalWorkspaceTerminalTabActive={false}
        timelineEntries={[
          {
            id: "before-user-message-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("before-user-message"),
              role: "user",
              text: "before row stays mounted",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
          {
            id: "middle-user-message-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("middle-user-message"),
              role: "user",
              text: longUserText,
              createdAt: "2026-03-17T19:12:29.000Z",
              streaming: false,
            },
          },
          {
            id: "after-user-message-entry",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("after-user-message"),
              role: "user",
              text: "after row stays mounted",
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        timestampFormat="locale"
        turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFFS}
        workspaceRoot={undefined}
      />,
    );
    try {
      const beforeRow = screen.container.querySelector('[data-message-id="before-user-message"]');
      const afterRow = screen.container.querySelector('[data-message-id="after-user-message"]');

      expect(beforeRow).toBeInstanceOf(HTMLElement);
      expect(afterRow).toBeInstanceOf(HTMLElement);
      expect(screen.container.textContent).not.toContain(hiddenTail);

      await page.getByText("Show more").click();

      await vi.waitFor(() => {
        expect(screen.container.textContent).toContain(hiddenTail);
      });
      expect(screen.container.querySelector('[data-message-id="before-user-message"]')).toBe(
        beforeRow,
      );
      expect(screen.container.querySelector('[data-message-id="after-user-message"]')).toBe(
        afterRow,
      );
    } finally {
      await screen.unmount();
    }
  });
});
