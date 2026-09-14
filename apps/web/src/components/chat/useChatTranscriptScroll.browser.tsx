import type { LegendListRef } from "@legendapp/list/react";
import { ThreadId } from "@synara/contracts";
import { useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { useChatTranscriptScroll } from "./useChatTranscriptScroll";

it.each(["edge notification", "delayed native movement", "no movement during output"])(
  "handles upward wheel input with %s",
  async (scenario) => {
    vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let scroll: ReturnType<typeof useChatTranscriptScroll> | undefined;
    const scrollToEnd = vi.fn(() => {
      const viewport = host.firstElementChild as HTMLElement;
      viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
    });
    function Harness() {
      const viewportRef = useRef<HTMLDivElement | null>(null);
      const listRef = useRef({
        getScrollableNode: () => viewportRef.current!,
        getState: () => ({ isAtEnd: true }),
        scrollToEnd,
      } as unknown as LegendListRef);
      scroll = useChatTranscriptScroll({
        activeThreadId: ThreadId.makeUnsafe("wheel-ownership"),
        legendListRef: listRef,
        timelineEntries: [],
        hasStreamingAssistantText: true,
        composerTranscriptInsetPx: 0,
        isInactiveSplitPane: false,
      });
      return (
        <div
          ref={viewportRef}
          onWheel={scroll.onMessagesWheelBase}
          style={{ height: 200, overflow: "auto" }}
        >
          <div style={{ height: 1000 }} />
        </div>
      );
    }
    try {
      flushSync(() => root.render(<Harness />));
      await vi.advanceTimersByTimeAsync(200);
      const viewport = host.firstElementChild as HTMLElement;
      viewport.scrollTop = 800;
      scrollToEnd.mockClear();
      viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -12 }));
      expect(scroll!.isUserScrollDetached).toBe(true);
      if (scenario === "no movement during output") {
        (viewport.firstElementChild as HTMLElement).style.height = "1200px";
        await vi.advanceTimersByTimeAsync(200);
        flushSync(() => {});
        expect(scroll!.isUserScrollDetached).toBe(false);
        expect(viewport.scrollTop).toBe(1000);
        expect(scrollToEnd).toHaveBeenCalledTimes(1);
        return;
      }
      if (scenario === "edge notification") {
        // A geometry notification can arrive before the browser applies the wheel delta.
        flushSync(() => scroll!.onIsAtEndChange(true));
      } else {
        // Native scrolling need not start within the next two animation frames.
        await vi.advanceTimersByTimeAsync(64);
      }
      expect(scroll!.isUserScrollDetached).toBe(true);
      viewport.scrollTop -= 12;
      flushSync(() => scroll!.onIsAtEndChange(true));
      await vi.advanceTimersByTimeAsync(200);
      expect(scroll!.isUserScrollDetached).toBe(true);
      expect(scrollToEnd).not.toHaveBeenCalled();
      viewport.scrollTop = 800;
      flushSync(() => scroll!.onIsAtEndChange(true));
      expect(scroll!.isUserScrollDetached).toBe(false);
    } finally {
      flushSync(() => root.unmount());
      host.remove();
      vi.useRealTimers();
    }
  },
);
