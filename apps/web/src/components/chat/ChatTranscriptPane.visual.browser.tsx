// FILE: ChatTranscriptPane.visual.browser.tsx
// Purpose: Screenshot evidence for the Codex-native transcript state matrix.
// Layer: Web browser visual fixture

import "../../index.css";

import { ApprovalRequestId, MessageId } from "@t3tools/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, type ComponentProps } from "react";
import { render } from "vitest-browser-react";

import { ChatTranscriptPane } from "./ChatTranscriptPane";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const EMPTY_WORK_GROUPS: Record<string, boolean> = {};
const EMPTY_TURN_DIFFS = new Map();
const EMPTY_REVERT_COUNTS = new Map();
const NOOP = () => {};

type TranscriptTimelineEntries = ComponentProps<typeof ChatTranscriptPane>["timelineEntries"];

const timelineEntries: TranscriptTimelineEntries = [
  {
    id: "visual-user-entry",
    kind: "message",
    createdAt: "2026-03-17T19:12:00.000Z",
    message: {
      id: MessageId.makeUnsafe("visual-user"),
      role: "user",
      text: "Summarize the renderer changes and keep the table readable.",
      createdAt: "2026-03-17T19:12:00.000Z",
      streaming: false,
    },
  },
  {
    id: "visual-work-entry",
    kind: "work",
    createdAt: "2026-03-17T19:12:10.000Z",
    entry: {
      id: "visual-work-command",
      createdAt: "2026-03-17T19:12:10.000Z",
      label: "Ran command",
      tone: "tool",
      itemType: "command_execution",
      toolTitle: "Searched",
      command: 'rg -n "ChatMarkdown" apps/web/src',
      toolDetails: {
        kind: "command",
        title: "Searched",
        command: 'rg -n "ChatMarkdown" apps/web/src',
        output: {
          stdout: "apps/web/src/components/ChatMarkdown.tsx:1",
        },
      },
    },
  },
  {
    id: "visual-assistant-entry",
    kind: "message",
    createdAt: "2026-03-17T19:12:28.000Z",
    message: {
      id: MessageId.makeUnsafe("visual-assistant"),
      role: "assistant",
      text: [
        "## Renderer update",
        "",
        "> Work rows now stay attached to the answer without overpowering the text.",
        "",
        "| Surface | Result |",
        "| --- | --- |",
        "| Markdown | Compact and contained |",
        "| Code | Copyable and wrapped |",
        "",
        "```ts",
        "const nativeFeeling = true;",
        "```",
      ].join("\n"),
      createdAt: "2026-03-17T19:12:28.000Z",
      streaming: false,
    },
  },
  {
    id: "visual-streaming-entry",
    kind: "message",
    createdAt: "2026-03-17T19:12:40.000Z",
    message: {
      id: MessageId.makeUnsafe("visual-streaming"),
      role: "assistant",
      text: "Streaming tail is still arriving, so scroll-follow should feel alive without yanking history.",
      createdAt: "2026-03-17T19:12:40.000Z",
      streaming: true,
    },
  },
];

function TranscriptVisualFixture() {
  const listRef = useRef<LegendListRef | null>(null);
  const approvalRequestId = ApprovalRequestId.makeUnsafe("visual-approval");
  const userInputRequestId = ApprovalRequestId.makeUnsafe("visual-user-input");

  return (
    <main
      data-testid="phase-10-visual-fixture"
      className="min-h-screen bg-background p-4 text-foreground"
    >
      <section className="mx-auto grid max-w-[1120px] gap-4 md:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-h-[620px] overflow-hidden rounded-lg border border-border bg-[var(--color-background-elevated-primary)]">
          <div className="flex h-[620px]">
            <ChatTranscriptPane
              activeThreadId="thread-phase-10-visual"
              activeTurnInProgress
              activeTurnStartedAt="2026-03-17T19:12:40.000Z"
              chatFontSizePx={15}
              emptyStateProjectName={undefined}
              expandedWorkGroups={EMPTY_WORK_GROUPS}
              hasMessages
              isRevertingCheckpoint={false}
              isWorking={false}
              followLiveOutput={false}
              listRef={listRef}
              markdownCwd="/Users/tylersheffield/code/synara"
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
              scrollButtonVisible
              terminalWorkspaceTerminalTabActive={false}
              timelineEntries={timelineEntries}
              timestampFormat="locale"
              turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFFS}
              workspaceRoot="/Users/tylersheffield/code/synara"
            />
          </div>
        </div>
        <aside className="space-y-4">
          <div className="rounded-lg border border-border bg-[var(--color-background-elevated-primary)]">
            <ComposerPendingApprovalPanel
              approval={{
                requestId: approvalRequestId,
                requestKind: "command",
                createdAt: "2026-03-17T19:12:44.000Z",
                detail: 'shell: {"command":"bun run typecheck"}',
              }}
              pendingCount={2}
            />
            <div className="flex flex-wrap justify-end gap-2 px-5 pb-3 sm:px-6">
              <ComposerPendingApprovalActions
                requestId={approvalRequestId}
                isResponding={false}
                describedById="pending-approval-status-visual-approval"
                onRespondToApproval={async () => undefined}
              />
            </div>
          </div>
          <div className="rounded-lg border border-border bg-[var(--color-background-elevated-primary)]">
            <ComposerPendingUserInputPanel
              pendingUserInputs={[
                {
                  requestId: userInputRequestId,
                  createdAt: "2026-03-17T19:12:50.000Z",
                  questions: [
                    {
                      id: "phase-10-choice",
                      header: "Review",
                      question: "Which transcript state should get the closest polish pass?",
                      multiSelect: true,
                      options: [
                        { label: "Streaming", description: "Tail behavior and markdown" },
                        { label: "Work rows", description: "Command and detail hierarchy" },
                        { label: "Composer", description: "Pending blockers and focus" },
                      ],
                    },
                  ],
                },
              ]}
              respondingRequestIds={[]}
              answers={{ "phase-10-choice": { selectedOptionLabels: ["Streaming"] } }}
              questionIndex={0}
              onToggleOption={() => null}
              onAdvance={() => undefined}
              onCancel={() => undefined}
            />
          </div>
        </aside>
      </section>
    </main>
  );
}

describe("ChatTranscriptPane visual fixture", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("captures desktop and narrow transcript state evidence", async () => {
    await page.viewport(1280, 900);
    const screen = await render(<TranscriptVisualFixture />);
    try {
      await expect.element(page.getByText("Renderer update")).toBeVisible();
      expect(document.body.textContent ?? "").toContain("Streaming tail is still arriving");
      expect(document.body.textContent ?? "").toContain("COMMAND");
      expect(document.body.textContent ?? "").toContain("Review");

      await page.screenshot({
        element: page.getByTestId("phase-10-visual-fixture"),
        path: "../../../../../.supergoal/evidence/phase-10-transcript-states-desktop.png",
      });

      await page.viewport(390, 844);
      await page.screenshot({
        element: page.getByTestId("phase-10-visual-fixture"),
        path: "../../../../../.supergoal/evidence/phase-10-transcript-states-mobile.png",
      });
    } finally {
      await page.viewport(1280, 720);
      await screen.unmount();
    }
  });
});
