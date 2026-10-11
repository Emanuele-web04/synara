import "../../index.css";

import { MessageId, ThreadId } from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useImperativeHandle, useRef, useState, type MutableRefObject } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";
import { useChatTranscriptScroll } from "./useChatTranscriptScroll";
import type { deriveTimelineEntries } from "../../session-logic";

type TimelineEntries = ReturnType<typeof deriveTimelineEntries>;

const THREAD_ID = ThreadId.makeUnsafe("scroll-ownership-thread");
const VIEWPORT_HEIGHT_PX = 420;
const AUTO_FOLLOW_TOLERANCE_PX = 120;

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
  for (let index = 0; index < 8; index += 1) {
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
  listRef: React.RefObject<LegendListRef | null>;
  startStreaming: () => void;
  send: () => void;
  isAnchorSliding: () => boolean;
  streamChunk: (lines: number) => void;
  scrollToBottom: () => void;
}

function ScrollOwnershipTimeline({
  handleRef,
}: {
  handleRef: MutableRefObject<HarnessHandle | null>;
}) {
  const listRef = useRef<LegendListRef | null>(null);
  const [entries, setEntries] = useState<TimelineEntries>(seedEntries);
  const [isStreaming, setIsStreaming] = useState(false);
  const [tailAnchorMessageId, setTailAnchorMessageId] = useState<MessageId | null>(null);
  const scroll = useChatTranscriptScroll({
    activeThreadId: THREAD_ID,
    legendListRef: listRef,
    timelineEntries: entries,
    hasStreamingAssistantText: isStreaming,
    composerTranscriptInsetPx: 0,
    isInactiveSplitPane: false,
  });

  useImperativeHandle(
    handleRef,
    () => ({
      listRef,
      startStreaming: () => setIsStreaming(true),
      send: () => {
        const messageId = MessageId.makeUnsafe("sent-user-message");
        scroll.armTranscriptAutoFollow(THREAD_ID);
        setIsStreaming(true);
        setEntries((current) => [...current, messageEntry(messageId, "user", "New question")]);
        setTailAnchorMessageId(messageId);
      },
      streamChunk: (lines: number) => {
        setEntries((current) => {
          const lastIndex = current.findIndex(
            (entry) => entry.kind === "message" && entry.message.streaming,
          );
          const existingText =
            lastIndex >= 0 && current[lastIndex]?.kind === "message"
              ? current[lastIndex].message.text
              : "";
          const grownText = `${existingText}${"Streamed line of response text.\n\n".repeat(lines)}`;
          const grown = messageEntry("streaming-assistant-message", "assistant", grownText, true);
          if (lastIndex < 0) return [...current, grown];
          return current.map((entry, index) => (index === lastIndex ? grown : entry));
        });
      },
      scrollToBottom: scroll.onScrollToBottom,
      isAnchorSliding: () => scroll.tailAnchorScrollInFlightRef.current,
    }),
    [scroll.armTranscriptAutoFollow, scroll.onScrollToBottom, scroll.tailAnchorScrollInFlightRef],
  );

  return (
    <div style={{ height: VIEWPORT_HEIGHT_PX }}>
      <MessagesTimeline
        hasMessages={entries.length > 0}
        isWorking={isStreaming}
        activeTurnInProgress={isStreaming}
        activeTurnStartedAt={isStreaming ? "2026-03-17T19:12:29.000Z" : null}
        listRef={listRef}
        tailAnchorMessageId={tailAnchorMessageId}
        animateTailAnchorSlide
        tailAnchorScrollInFlightRef={scroll.tailAnchorScrollInFlightRef}
        followLiveOutput={!scroll.isUserScrollDetached}
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
        onMessagesWheel={scroll.onMessagesWheelBase}
        onMessagesPointerDown={scroll.onMessagesPointerDownBase}
        onMessagesPointerUp={scroll.onMessagesPointerUpBase}
        onIsAtEndChange={scroll.onIsAtEndChange}
      />
    </div>
  );
}

function getScrollContainer(handle: HarnessHandle): HTMLElement {
  const node: unknown = handle.listRef.current?.getScrollableNode?.();
  if (!(node instanceof HTMLElement)) throw new Error("scroll container not available");
  return node;
}

function distanceFromBottomPx(container: HTMLElement): number {
  return container.scrollHeight - container.clientHeight - container.scrollTop;
}

async function settleFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }
}

async function startStreamingAndFollow(
  handle: HarnessHandle,
  container: HTMLElement,
): Promise<void> {
  await expect.poll(() => handle.listRef.current?.getScrollableNode?.() != null).toBe(true);
  await settleFrames(3);
  void handle.listRef.current?.scrollToEnd?.({ animated: false });
  await expect
    .poll(() => distanceFromBottomPx(container), { timeout: 5_000 })
    .toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);
  handle.startStreaming();
  for (let index = 0; index < 8; index += 1) {
    handle.streamChunk(2);
    await settleFrames(1);
  }
  await expect
    .poll(() => distanceFromBottomPx(container), { timeout: 5_000 })
    .toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);
}

function wheelUp(handle: HarnessHandle, scrollBy: number, eventDelta: number): void {
  const container = getScrollContainer(handle);
  const before = container.scrollTop;
  container.dispatchEvent(
    new WheelEvent("wheel", {
      bubbles: true,
      deltaY: -eventDelta,
      clientX: container.clientWidth / 2,
      clientY: container.clientHeight / 2,
    }),
  );
  container.scrollTop = Math.max(0, before - scrollBy);
  container.dispatchEvent(new Event("scroll"));
}

describe("MessagesTimeline scroll ownership", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lets a single wheel up detach auto-follow and never re-snaps for 60 frames", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const screen = await render(<ScrollOwnershipTimeline handleRef={handleRef} />);

    try {
      const handle = handleRef.current;
      if (!handle) throw new Error("harness not mounted");
      const container = getScrollContainer(handle);

      await startStreamingAndFollow(handle, container);
      const scrollTopBeforeWheel = container.scrollTop;
      wheelUp(handle, 100, 100);
      await settleFrames(2);

      expect(container.scrollTop).toBeLessThan(scrollTopBeforeWheel);

      const readingTop = container.scrollTop;
      const samples: number[] = [readingTop];
      for (let frame = 0; frame < 60; frame += 1) {
        handle.streamChunk(1);
        await settleFrames(1);
        samples.push(container.scrollTop);
      }

      for (const scrollTop of samples) {
        expect(scrollTop).toBeCloseTo(readingTop, 0);
      }
    } finally {
      await screen.unmount();
    }
  });

  it("lets a wheel gesture cancel the send-anchor slide while output continues", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const screen = await render(<ScrollOwnershipTimeline handleRef={handleRef} />);

    try {
      const handle = handleRef.current;
      if (!handle) throw new Error("harness not mounted");
      const container = getScrollContainer(handle);
      await settleFrames(3);
      void handle.listRef.current?.scrollToEnd?.({ animated: false });
      await expect
        .poll(() => distanceFromBottomPx(container), { timeout: 5_000 })
        .toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);

      handle.send();
      await expect.poll(() => handle.isAnchorSliding()).toBe(true);
      wheelUp(handle, 100, 100);
      expect(handle.isAnchorSliding()).toBe(false);
      await settleFrames(2);
      const readingTop = container.scrollTop;

      handle.streamChunk(10);
      for (let frame = 0; frame < 24; frame += 1) {
        await settleFrames(1);
        expect(container.scrollTop).toBeCloseTo(readingTop, 0);
      }
    } finally {
      await screen.unmount();
    }
  });

  it.each(["native scroll", "bottom button"] as const)(
    "re-attaches end-follow after returning to the bottom via %s",
    async (method) => {
      const handleRef: { current: HarnessHandle | null } = { current: null };
      const screen = await render(<ScrollOwnershipTimeline handleRef={handleRef} />);

      try {
        const handle = handleRef.current;
        if (!handle) throw new Error("harness not mounted");
        const container = getScrollContainer(handle);

        await startStreamingAndFollow(handle, container);
        wheelUp(handle, 300, 200);
        await settleFrames(3);

        expect(distanceFromBottomPx(container)).toBeGreaterThan(AUTO_FOLLOW_TOLERANCE_PX);

        if (method === "bottom button") {
          handle.scrollToBottom();
        } else {
          container.scrollTop = container.scrollHeight;
          container.dispatchEvent(new Event("scroll"));
        }
        await expect
          .poll(() => distanceFromBottomPx(container), { timeout: 5_000 })
          .toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);

        for (let frame = 0; frame < 24; frame += 1) {
          handle.streamChunk(1);
          await settleFrames(1);
        }

        await expect
          .poll(() => distanceFromBottomPx(container), { timeout: 5_000 })
          .toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);
      } finally {
        await screen.unmount();
      }
    },
  );
});
