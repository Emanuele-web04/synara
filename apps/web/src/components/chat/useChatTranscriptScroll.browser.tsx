import type { LegendListRef } from "@legendapp/list/react";
import { ThreadId } from "@synara/contracts";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useChatTranscriptScroll } from "./useChatTranscriptScroll";
import type { TimelineEntry } from "../../session-logic";

const EMPTY_TIMELINE: [] = [];
const waitForFrames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

describe("transcript follow after switching threads", () => {
  it("follows an idle destination after leaving a detached transcript", async () => {
    // Detached nodes have no layout, so model an overflowing viewport directly.
    const node = document.createElement("div");
    Object.defineProperties(node, {
      scrollHeight: { value: 1_000 },
      clientHeight: { value: 200 },
      scrollTop: { value: 300, writable: true },
    });
    const scrollToEnd = vi.fn(async () => {
      node.scrollTop = 800;
    });
    const listRef = {
      current: {
        scrollToEnd,
        getScrollableNode: () => node,
      } as unknown as LegendListRef,
    };
    let controls: ReturnType<typeof useChatTranscriptScroll> | undefined;
    function Harness({
      threadId,
      timelineEntries = EMPTY_TIMELINE,
    }: {
      threadId: string;
      timelineEntries?: TimelineEntry[];
    }) {
      controls = useChatTranscriptScroll({
        activeThreadId: ThreadId.makeUnsafe(threadId),
        legendListRef: listRef,
        timelineEntries,
        hasStreamingAssistantText: false,
        composerTranscriptInsetPx: 0,
        isInactiveSplitPane: false,
      });
      return null;
    }
    const screen = await render(<Harness threadId="first" />);
    try {
      await waitForFrames();
      controls!.onTranscriptNavigate();
      await screen.rerender(<Harness threadId="first" />);
      await waitForFrames();
      expect(controls!.isUserScrollDetached).toBe(true);

      for (const threadId of ["second", "first"]) {
        node.scrollTop = 300;
        scrollToEnd.mockClear();
        await screen.rerender(<Harness threadId={threadId} />);
        await waitForFrames();
        expect(controls!.isUserScrollDetached).toBe(false);
        expect(scrollToEnd).toHaveBeenCalledTimes(1);
        expect(node.scrollTop).toBe(800);
        scrollToEnd.mockClear();
        for (const detail of ["Inspecting the boundary", "Verifying cancellation"]) {
          await screen.rerender(
            <Harness
              threadId={threadId}
              timelineEntries={[
                {
                  kind: "work",
                  id: "live-reasoning",
                  createdAt: "2026-03-17T19:12:28.000Z",
                  entry: {
                    id: "live-reasoning",
                    createdAt: "2026-03-17T19:12:28.000Z",
                    tone: "tool",
                    label: "Reasoning trace",
                    toolCallId: "reasoning-item",
                    toolStatus: "running",
                    detail,
                  },
                },
              ]}
            />,
          );
          await waitForFrames();
          expect(scrollToEnd).not.toHaveBeenCalled();
        }
        // Detach again so the return trip starts from a detached reader too.
        controls!.onTranscriptNavigate();
        await screen.rerender(<Harness threadId={threadId} />);
      }
    } finally {
      await screen.unmount();
    }
  });

  it("preserves send-anchor ownership when an idle destination starts streaming", async () => {
    const node = document.createElement("div");
    const scrollToEnd = vi.fn(async () => {});
    const listRef = {
      current: {
        scrollToEnd,
        getScrollableNode: () => node,
      } as unknown as LegendListRef,
    };
    let controls: ReturnType<typeof useChatTranscriptScroll> | undefined;
    function Harness({ threadId, streaming }: { threadId: string; streaming: boolean }) {
      controls = useChatTranscriptScroll({
        activeThreadId: ThreadId.makeUnsafe(threadId),
        legendListRef: listRef,
        timelineEntries: EMPTY_TIMELINE,
        hasStreamingAssistantText: streaming,
        composerTranscriptInsetPx: 0,
        isInactiveSplitPane: false,
      });
      return null;
    }
    const screen = await render(<Harness threadId="first" streaming={false} />);
    try {
      await waitForFrames();
      await screen.rerender(<Harness threadId="second" streaming={false} />);
      await waitForFrames();
      scrollToEnd.mockClear();

      // Sending owns the scroll before the optimistic row appears. Provider text
      // can arrive while the 320ms anchor slide is still moving that row.
      controls!.tailAnchorScrollInFlightRef.current = true;
      await screen.rerender(<Harness threadId="second" streaming />);
      await waitForFrames();
      expect(scrollToEnd).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});

describe("transcript detach on reader gestures", () => {
  function createOverflowingList() {
    // Detached nodes have no layout, so model an overflowing viewport directly.
    const node = document.createElement("div");
    Object.defineProperties(node, {
      scrollHeight: { value: 1_000 },
      clientHeight: { value: 200 },
      scrollTop: { value: 800, writable: true },
    });
    return {
      current: {
        scrollToEnd: vi.fn(async () => {}),
        getScrollableNode: () => node,
        getState: () => ({ isAtEnd: false }),
      } as unknown as LegendListRef,
    };
  }

  it("commits the detached follow state before an already queued frame runs", async () => {
    const listRef = createOverflowingList();
    let controls: ReturnType<typeof useChatTranscriptScroll> | undefined;
    // Stands in for the list, which reads `followLiveOutput` from its last committed render.
    const committedFollow = { current: true };
    function List({ followLiveOutput }: { followLiveOutput: boolean }) {
      useLayoutEffect(() => {
        committedFollow.current = followLiveOutput;
      }, [followLiveOutput]);
      return null;
    }
    function Harness() {
      controls = useChatTranscriptScroll({
        activeThreadId: ThreadId.makeUnsafe("detach-frame"),
        legendListRef: listRef,
        timelineEntries: EMPTY_TIMELINE,
        hasStreamingAssistantText: true,
        composerTranscriptInsetPx: 0,
        isInactiveSplitPane: false,
      });
      return <List followLiveOutput={!controls.isUserScrollDetached} />;
    }
    const screen = await render(<Harness />);
    try {
      await waitForFrames();
      expect(committedFollow.current).toBe(true);
      // Browsers deliver wheel input in the same frame as animation callbacks, so the
      // list's already queued maintain-at-end callback runs right after the gesture,
      // before any task React could schedule a deferred render in.
      requestAnimationFrame(() => {
        controls!.onMessagesWheelBase({ ctrlKey: false, deltaY: -120 } as never);
      });
      const followSeenByQueuedFrame = new Promise<boolean>((resolve) => {
        requestAnimationFrame(() => resolve(committedFollow.current));
      });
      expect(await followSeenByQueuedFrame).toBe(false);
    } finally {
      await screen.unmount();
    }
  });

  it("detaches without a flushSync warning when a gesture lands inside a commit", async () => {
    const listRef = createOverflowingList();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let controls: ReturnType<typeof useChatTranscriptScroll> | undefined;
    function GestureDuringCommit({ fire }: { fire: boolean }) {
      useLayoutEffect(() => {
        if (fire) controls!.onMessagesPointerDownBase();
      }, [fire]);
      return null;
    }
    function Harness({ fire }: { fire: boolean }) {
      controls = useChatTranscriptScroll({
        activeThreadId: ThreadId.makeUnsafe("detach-commit"),
        legendListRef: listRef,
        timelineEntries: EMPTY_TIMELINE,
        hasStreamingAssistantText: false,
        composerTranscriptInsetPx: 0,
        isInactiveSplitPane: false,
      });
      return <GestureDuringCommit fire={fire} />;
    }
    const screen = await render(<Harness fire={false} />);
    try {
      await waitForFrames();
      await screen.rerender(<Harness fire />);
      await waitForFrames();
      expect(controls!.isUserScrollDetached).toBe(true);
      expect(consoleError.mock.calls.some((call) => String(call[0]).includes("flushSync"))).toBe(
        false,
      );
    } finally {
      consoleError.mockRestore();
      await screen.unmount();
    }
  });
});
