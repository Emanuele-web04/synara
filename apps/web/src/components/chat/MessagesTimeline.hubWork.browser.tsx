import "../../index.css";

import { MessageId, ThreadId, type HubWorkItem } from "@synara/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MessagesTimeline } from "./MessagesTimeline";

const messageId = MessageId.makeUnsafe("request-hub-work");
const threadId = ThreadId.makeUnsafe("hub-coordinator");
const workerId = ThreadId.makeUnsafe("hub-worker");
const onOpenThread = vi.fn();
const item: HubWorkItem = {
  id: "hub-work-1",
  sourceThreadId: threadId,
  sourceMessageId: messageId,
  title: "Fix login",
  workerThreadId: null,
  state: "queued",
  queueReason: "Waiting for a free thread slot",
  resultSummary: null,
  progress: null,
  revision: 0,
  createdAt: "2026-10-02T12:00:00.000Z",
  updatedAt: "2026-10-02T12:00:00.000Z",
};

function Timeline() {
  const [work, setWork] = useState(item);
  return (
    <>
      <button
        onClick={() =>
          setWork({
            ...work,
            workerThreadId: workerId,
            state: "completed",
            queueReason: null,
            resultSummary: "Login repaired",
            progress: {
              revision: 1,
              steps: [{ id: "verify", text: "Verify login", status: "completed" }],
            },
          })
        }
      >
        Complete work
      </button>
      <div style={{ height: 420 }}>
        <MessagesTimeline
          hasMessages
          isWorking={false}
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          timelineEntries={[
            {
              id: "request",
              kind: "message",
              createdAt: "2026-10-02T12:00:00.000Z",
              message: {
                id: messageId,
                role: "user",
                text: "Repair sign in",
                createdAt: "2026-10-02T12:00:00.000Z",
                streaming: false,
              },
            },
          ]}
          hubWorkItemsByMessageId={new Map([[messageId, [work]]])}
          messageChangeSignal={messageId}
          turnDiffSummaryByAssistantMessageId={new Map()}
          onOpenTurnDiff={() => {}}
          onOpenThread={onOpenThread}
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
    </>
  );
}

describe("Hub work in the coordinator transcript", () => {
  it("keeps queued work and durable progress under the original request after the turn ends", async () => {
    onOpenThread.mockClear();
    const screen = await render(<Timeline />);
    try {
      await expect.element(page.getByText("Queued", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("Waiting for a free thread slot")).toBeInTheDocument();
      const request = document.querySelector('[data-chat-find-document-id="request-hub-work"]');
      const card = document.querySelector('article[aria-label="Work: Fix login"]');
      expect(request).not.toBeNull();
      expect(card).not.toBeNull();
      expect(card!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        request!.getBoundingClientRect().bottom,
      );
      expect(
        request!.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      await page.getByRole("button", { name: "Complete work" }).click();
      await expect.element(page.getByText("Login repaired", { exact: true })).toBeInTheDocument();
      await expect
        .element(page.getByRole("listitem", { name: "Verify login: completed" }))
        .toBeInTheDocument();
      expect(document.querySelectorAll('article[aria-label="Work: Fix login"]')).toHaveLength(1);
      await page.getByRole("button", { name: "Fix login", exact: true }).click();
      expect(onOpenThread).toHaveBeenCalledWith(workerId);
    } finally {
      await screen.unmount();
    }
  });
});
