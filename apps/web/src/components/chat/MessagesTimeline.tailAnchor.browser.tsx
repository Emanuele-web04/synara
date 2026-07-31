// FILE: MessagesTimeline.tailAnchor.browser.tsx
// Purpose: Browser regression for send-time anchoring — a just-sent user message
//          aligns with the viewport top, stays pinned while the response streams
//          below it, hands off to follow-the-tail once the response overflows,
//          and the reserved space collapses when the turn ends.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId } from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";
import type { deriveTimelineEntries } from "../../session-logic";

type TimelineEntries = ReturnType<typeof deriveTimelineEntries>;

const VIEWPORT_HEIGHT_PX = 420;
const BASE_BOTTOM_INSET_PX = 64;
// maintainScrollAtEnd re-sticks within its threshold rather than to the exact
// pixel bottom; anything within this tolerance counts as following the tail.
const AUTO_FOLLOW_TOLERANCE_PX = 96;
const SENT_MESSAGE_ID = "sent-user-message";
const STREAMING_MESSAGE_ID = "streaming-assistant-message";

function messageEntry(
  id: string,
  role: "user" | "assistant",
  text: string,
  streaming = false,
): TimelineEntries[number] {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: "2026-03-17T19:12:28.000Z",
    message: {
      id: MessageId.makeUnsafe(id),
      role,
      text,
      createdAt: "2026-03-17T19:12:28.000Z",
      streaming,
    },
  };
}

function seedEntries(): TimelineEntries {
  const entries: TimelineEntries = [];
  for (let index = 0; index < 6; index += 1) {
    entries.push(messageEntry(`seed-user-${index}`, "user", `Earlier question ${index}.`));
    entries.push(
      messageEntry(
        `seed-assistant-${index}`,
        "assistant",
        `Earlier answer ${index}. ${"Some settled response text. ".repeat(6)}`,
      ),
    );
  }
  return entries;
}

interface HarnessHandle {
  send: () => void;
  growStream: (lines: number) => void;
  finishTurn: () => void;
  listRef: React.RefObject<LegendListRef | null>;
}

function TailAnchorTimeline({ handleRef }: { handleRef: { current: HarnessHandle | null } }) {
  const listRef = useRef<LegendListRef | null>(null);
  const [entries, setEntries] = useState<TimelineEntries>(seedEntries);
  const [tailAnchorMessageId, setTailAnchorMessageId] = useState<MessageId | null>(null);
  const [followLiveOutput, setFollowLiveOutput] = useState(false);

  handleRef.current = {
    listRef,
    send: () => {
      setEntries((current) => [
        ...current,
        messageEntry(SENT_MESSAGE_ID, "user", "Freshly sent question."),
      ]);
      setTailAnchorMessageId(MessageId.makeUnsafe(SENT_MESSAGE_ID));
    },
    growStream: (lines: number) => {
      setFollowLiveOutput(true);
      setEntries((current) => {
        const streamingIndex = current.findIndex(
          (entry) => entry.kind === "message" && entry.message.id === STREAMING_MESSAGE_ID,
        );
        const existingText =
          streamingIndex >= 0 && current[streamingIndex]?.kind === "message"
            ? current[streamingIndex].message.text
            : "";
        const grownText = `${existingText}${"Streamed line of response text.\n\n".repeat(lines)}`;
        const grown = messageEntry(STREAMING_MESSAGE_ID, "assistant", grownText, true);
        if (streamingIndex < 0) {
          return [...current, grown];
        }
        return current.map((entry, index) => (index === streamingIndex ? grown : entry));
      });
    },
    finishTurn: () => {
      setFollowLiveOutput(false);
      setTailAnchorMessageId(null);
    },
  };

  return (
    <div style={{ height: VIEWPORT_HEIGHT_PX }}>
      <MessagesTimeline
        hasMessages={entries.length > 0}
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        listRef={listRef}
        tailAnchorMessageId={tailAnchorMessageId}
        followLiveOutput={followLiveOutput}
        timelineEntries={entries}
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

function getScrollContainer(handle: HarnessHandle): HTMLElement {
  const node: unknown = handle.listRef.current?.getScrollableNode?.();
  if (!(node instanceof HTMLElement)) {
    throw new Error("scroll container not available");
  }
  return node;
}

function getSpacer(): HTMLElement {
  const spacer = document.querySelector<HTMLElement>('[data-tail-anchor-spacer="true"]');
  if (!spacer) {
    throw new Error("tail anchor spacer not rendered");
  }
  return spacer;
}

function anchorTopOffsetPx(handle: HarnessHandle): number | null {
  const anchor = document.querySelector<HTMLElement>(`[data-message-id="${SENT_MESSAGE_ID}"]`);
  if (!anchor || anchor.getClientRects().length === 0) {
    return null;
  }
  const container = getScrollContainer(handle);
  return anchor.getBoundingClientRect().top - container.getBoundingClientRect().top;
}

function distanceFromBottomPx(handle: HarnessHandle): number {
  const container = getScrollContainer(handle);
  return container.scrollHeight - container.clientHeight - container.scrollTop;
}

async function settleFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }
}

describe("MessagesTimeline tail anchor", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("anchors a sent message at the viewport top, pins it while streaming, follows overflow, and collapses when the turn ends", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const screen = await render(<TailAnchorTimeline handleRef={handleRef} />);

    try {
      const handle = () => {
        if (!handleRef.current) throw new Error("harness not mounted");
        return handleRef.current;
      };

      // Let the list mount, then settle at the bottom like a real open conversation.
      await expect.poll(() => handle().listRef.current?.getScrollableNode?.() != null).toBe(true);
      await settleFrames(3);
      void handle().listRef.current?.scrollToEnd?.({ animated: false });
      await expect
        .poll(() => distanceFromBottomPx(handle()), { timeout: 5_000 })
        .toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);

      // 1) Send: the spacer reserves space and the new message slides to the top.
      // ChatView issues an animated scroll-to-end alongside every send; the hook's
      // spacer sizing is what turns that into "message at the viewport top".
      handle().send();
      void handle().listRef.current?.scrollToEnd?.({ animated: true });

      await expect
        .poll(() => getSpacer().getBoundingClientRect().height, { timeout: 5_000 })
        .toBeGreaterThan(BASE_BOTTOM_INSET_PX);
      await expect
        .poll(
          () => {
            const offset = anchorTopOffsetPx(handle());
            return offset !== null && Math.abs(offset) <= 8;
          },
          { timeout: 5_000 },
        )
        .toBe(true);

      // 2) Short streaming: response grows into the reserve; the message stays pinned.
      const container = getScrollContainer(handle());
      const scrollTopBeforeStream = container.scrollTop;
      const spacerBeforeStream = getSpacer().getBoundingClientRect().height;

      handle().growStream(2);
      await expect
        .poll(() => getSpacer().getBoundingClientRect().height, { timeout: 5_000 })
        .toBeLessThan(spacerBeforeStream);
      await settleFrames(3);

      expect(Math.abs(container.scrollTop - scrollTopBeforeStream)).toBeLessThanOrEqual(1);
      const pinnedOffset = anchorTopOffsetPx(handle());
      expect(pinnedOffset !== null && Math.abs(pinnedOffset) <= 8).toBe(true);

      // 3) Overflow: the response outgrows the viewport; the tail stays visible.
      handle().growStream(40);
      await expect
        .poll(() => getSpacer().getBoundingClientRect().height, { timeout: 5_000 })
        .toBe(BASE_BOTTOM_INSET_PX);
      await expect
        .poll(() => distanceFromBottomPx(handle()), { timeout: 5_000 })
        .toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);
      // The anchored message has scrolled up and out of the way of the live tail.
      const overflowOffset = anchorTopOffsetPx(handle());
      expect(overflowOffset === null || overflowOffset < 0).toBe(true);

      // 4) Turn end: the reserve collapses back to the base inset.
      handle().finishTurn();
      await expect
        .poll(() => getSpacer().getBoundingClientRect().height, { timeout: 5_000 })
        .toBe(BASE_BOTTOM_INSET_PX);
    } finally {
      await screen.unmount();
    }
  });
});
