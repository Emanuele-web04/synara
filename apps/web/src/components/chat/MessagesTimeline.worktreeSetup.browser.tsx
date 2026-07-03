// FILE: MessagesTimeline.worktreeSetup.browser.tsx
// Purpose: Browser regression for the transient worktree-setup step card lifecycle.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId } from "@t3tools/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";
import type { deriveTimelineEntries } from "../../session-logic";
import type { WorktreeSetupSnapshot, WorktreeSetupStepStatus } from "../../types";

type TimelineEntries = ReturnType<typeof deriveTimelineEntries>;

function userEntry(id: string, text: string): TimelineEntries[number] {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: "2026-03-17T19:12:28.000Z",
    message: {
      id: MessageId.makeUnsafe(id),
      role: "user",
      text,
      createdAt: "2026-03-17T19:12:28.000Z",
      streaming: false,
    },
  };
}

function setupSnapshot(statuses: [WorktreeSetupStepStatus, WorktreeSetupStepStatus]) {
  return {
    steps: [
      { id: "create-worktree", label: "Creating branch and worktree", status: statuses[0] },
      { id: "prepare-thread", label: "Linking thread workspace", status: statuses[1] },
    ],
  } satisfies WorktreeSetupSnapshot;
}

function WorktreeSetupTimeline() {
  const [worktreeSetup, setWorktreeSetup] = useState<WorktreeSetupSnapshot | null>(() =>
    setupSnapshot(["active", "pending"]),
  );

  return (
    <div>
      <button
        type="button"
        data-testid="advance-step"
        onClick={() => setWorktreeSetup(setupSnapshot(["done", "active"]))}
      >
        Advance step
      </button>
      <button type="button" data-testid="clear-setup" onClick={() => setWorktreeSetup(null)}>
        Clear setup
      </button>
      <div style={{ height: 420 }}>
        <MessagesTimeline
          hasMessages
          isWorking
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          worktreeSetup={worktreeSetup}
          timelineEntries={[userEntry("user-message", "Start in a worktree.")]}
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
        />
      </div>
    </div>
  );
}

function FailedSetupWithoutMessagesTimeline() {
  return (
    <div style={{ height: 420 }}>
      <MessagesTimeline
        hasMessages={false}
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        worktreeSetup={setupSnapshot(["error", "pending"])}
        timelineEntries={[]}
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
      />
    </div>
  );
}

const setupRow = () =>
  document.querySelector<HTMLElement>('[data-timeline-row-kind="worktree-setup"]');
const workingRow = () => document.querySelector<HTMLElement>('[data-timeline-row-kind="working"]');

describe("MessagesTimeline worktree setup card", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows step progress, then animates out and hands off to the working shimmer", async () => {
    const screen = await render(<WorktreeSetupTimeline />);

    try {
      await expect.poll(() => setupRow() !== null).toBe(true);
      expect(setupRow()?.textContent).toContain("Preparing worktree...");
      expect(setupRow()?.textContent).toContain("Creating branch and worktree");
      // The generic working shimmer stays suppressed while the card is open.
      expect(workingRow()).toBeNull();

      document.querySelector<HTMLButtonElement>('[data-testid="advance-step"]')?.click();
      await expect.poll(() => setupRow()?.textContent).toContain("Linking thread workspace");
      expect(workingRow()).toBeNull();

      document.querySelector<HTMLButtonElement>('[data-testid="clear-setup"]')?.click();
      // The card stays mounted through the disclosure close animation while the
      // working shimmer takes over immediately.
      expect(setupRow()).not.toBeNull();
      await expect.poll(() => workingRow() !== null).toBe(true);
      await expect.poll(() => setupRow() === null, { timeout: 2000 }).toBe(true);
      expect(workingRow()).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a failed first-send setup row visible after the optimistic message is removed", async () => {
    const screen = await render(<FailedSetupWithoutMessagesTimeline />);

    try {
      await expect.poll(() => setupRow()?.textContent).toContain("Creating branch and worktree");
      expect(setupRow()?.textContent).toContain("failed");
      expect(document.body.textContent).not.toContain("Send a message to start the conversation.");
    } finally {
      await screen.unmount();
    }
  });
});
