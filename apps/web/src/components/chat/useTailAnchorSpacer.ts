// FILE: useTailAnchorSpacer.ts
// Purpose: Size the transcript's tail spacer so a just-sent user message can anchor
//          at the top of the viewport while the assistant response streams below it.
// Layer: Chat transcript behavior hook
// Why: Right after a send there is almost no content below the new message, so the
//      browser cannot scroll it to the viewport top. Reserving the missing space in
//      the list footer makes "scrolled to end" mean "sent message anchored just
//      below the viewport top" (offset by the container's own top padding, matching
//      a chat's first message), which lets the existing scroll-to-end +
//      stick-to-end machinery produce the anchored layout with no second scroll
//      system. Resizes are applied synchronously with the content change that
//      caused them so the invariant holds within every frame, and while the
//      post-send slide is animating this hook is the sole scroll owner (the
//      shared in-flight flag pauses ChatView's auto-follow re-snaps). While the
//      response is shorter than the viewport it grows into the
//      reserve (total scroll height stays constant, so the message stays pinned);
//      once it overflows, the spacer bottoms out at the base inset and normal
//      follow-the-tail scrolling resumes. The reserve persists after the turn ends
//      so the settled transcript never jumps; it is replaced by the next send and
//      reset by thread switches (the timeline remounts per thread). The animated
//      collapse below is a fallback for an anchor being cleared while mounted.

import { type MessageId } from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useEffect, useRef, type RefObject } from "react";
import { computeTailAnchorSpacerHeightPx, isScrollContainerNearBottom } from "../../chat-scroll";
import { DISCLOSURE_CLEANUP_BUFFER_MS, DISCLOSURE_TRANSITION_MS } from "~/lib/disclosureMotion";

// A freshly appended anchor row can take a while to be committed by the virtualized
// list — especially when the send happened far from the bottom and the animated
// scroll-to-end still has to bring the row into the render window. Retry across
// that window; afterwards content-size changes re-trigger measurement anyway.
const ANCHOR_MEASURE_MAX_RETRY_FRAMES = 90;

interface UseTailAnchorSpacerOptions {
  listRef: RefObject<LegendListRef | null>;
  timelineRootRef: RefObject<HTMLElement | null>;
  spacerRef: RefObject<HTMLDivElement | null>;
  /** User message currently anchored at the viewport top; null collapses the reserve. */
  anchorMessageId: MessageId | null;
  baseInsetPx: number;
  /**
   * Shared flag owned by ChatView: true from send until this hook finishes the
   * anchored slide. While set, ChatView's auto-follow re-snaps stay quiet so the
   * slide has a single scroll owner and cannot be preempted mid-flight.
   */
  anchorScrollInFlightRef?: RefObject<boolean> | undefined;
}

function getScrollContainer(listRef: RefObject<LegendListRef | null>): HTMLElement | null {
  const node: unknown = listRef.current?.getScrollableNode?.();
  return node instanceof HTMLElement ? node : null;
}

function readSpacerHeightPx(spacer: HTMLElement, baseInsetPx: number): number {
  const parsed = Number.parseFloat(spacer.style.height);
  return Number.isFinite(parsed) ? parsed : baseInsetPx;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function useTailAnchorSpacer({
  listRef,
  timelineRootRef,
  spacerRef,
  anchorMessageId,
  baseInsetPx,
  anchorScrollInFlightRef,
}: UseTailAnchorSpacerOptions): void {
  const previousAnchorRef = useRef<MessageId | null>(null);
  const collapseTimeoutRef = useRef<number | null>(null);
  const collapseStartFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const previousAnchor = previousAnchorRef.current;
    previousAnchorRef.current = anchorMessageId;

    const clearCollapseTimers = () => {
      if (collapseTimeoutRef.current !== null) {
        window.clearTimeout(collapseTimeoutRef.current);
        collapseTimeoutRef.current = null;
      }
      if (collapseStartFrameRef.current !== null) {
        window.cancelAnimationFrame(collapseStartFrameRef.current);
        collapseStartFrameRef.current = null;
      }
    };

    if (anchorMessageId === null) {
      // No anchor. If one was just cleared (turn ended), animate the reserved
      // space away so the transcript settles back to its true bottom.
      if (anchorScrollInFlightRef) {
        anchorScrollInFlightRef.current = false;
      }
      if (previousAnchor === null) {
        return;
      }
      const spacer = spacerRef.current;
      if (!spacer) {
        return;
      }
      clearCollapseTimers();
      if (readSpacerHeightPx(spacer, baseInsetPx) <= baseInsetPx) {
        spacer.style.height = `${baseInsetPx}px`;
        return;
      }
      if (prefersReducedMotion()) {
        spacer.style.height = `${baseInsetPx}px`;
        return;
      }
      spacer.style.transition = `height ${DISCLOSURE_TRANSITION_MS}ms ease-out`;
      // Let the transition style land before changing the height so it animates.
      collapseStartFrameRef.current = window.requestAnimationFrame(() => {
        collapseStartFrameRef.current = null;
        spacer.style.height = `${baseInsetPx}px`;
        collapseTimeoutRef.current = window.setTimeout(() => {
          collapseTimeoutRef.current = null;
          spacer.style.transition = "";
        }, DISCLOSURE_TRANSITION_MS + DISCLOSURE_CLEANUP_BUFFER_MS);
      });
      return () => {
        clearCollapseTimers();
      };
    }

    // Fresh anchor (new send, or steer replacing the previous anchor): size the
    // reserve instantly and slide the transcript so the message lands at the top.
    const anchorId = anchorMessageId;
    clearCollapseTimers();
    if (anchorScrollInFlightRef) {
      anchorScrollInFlightRef.current = true;
    }
    const spacerAtStart = spacerRef.current;
    if (spacerAtStart) {
      spacerAtStart.style.transition = "";
    }

    let disposed = false;
    let measureFrameId: number | null = null;
    let measuring = false;
    let retryFramesLeft = ANCHOR_MEASURE_MAX_RETRY_FRAMES;
    // The first successful measurement after a new anchor owns the smooth slide.
    let pendingAnchorScroll = true;
    // A send far from the bottom leaves the new row outside the render window,
    // so the slide toward the end must start before the row can be measured.
    let requestedTailReveal = false;

    // The slide is over (or was never needed): hand scroll ownership back to
    // ChatView's auto-follow machinery.
    function finishAnchorSlide(): void {
      if (anchorScrollInFlightRef) {
        anchorScrollInFlightRef.current = false;
      }
    }

    function measure(): void {
      const container = getScrollContainer(listRef);
      const spacer = spacerRef.current;
      const root = timelineRootRef.current;
      if (!container || !spacer || !root) {
        return;
      }
      const anchorElement = root.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(anchorId)}"]`,
      );
      if (!anchorElement || anchorElement.getClientRects().length === 0) {
        // Row not committed yet (or virtualized out). Retry briefly for the
        // fresh-send case; otherwise freeze the current reserve.
        if (retryFramesLeft > 0) {
          if (pendingAnchorScroll && !requestedTailReveal) {
            requestedTailReveal = true;
            void listRef.current?.scrollToEnd?.({ animated: true });
          }
          retryFramesLeft -= 1;
          schedule();
        } else if (pendingAnchorScroll) {
          pendingAnchorScroll = false;
          finishAnchorSlide();
        }
        return;
      }
      const spacerTop = spacer.getBoundingClientRect().top;
      const anchorTop = anchorElement.getBoundingClientRect().top;
      const containerStyle = getComputedStyle(container);
      const paddingBottom = Number.parseFloat(containerStyle.paddingBottom) || 0;
      const paddingTop = Number.parseFloat(containerStyle.paddingTop) || 0;
      const next = computeTailAnchorSpacerHeightPx({
        viewportHeightPx: container.clientHeight,
        anchorTopToSpacerTopPx: spacerTop - anchorTop,
        trailingInsetPx: paddingBottom,
        topInsetPx: paddingTop,
        baseInsetPx,
      });
      const current = readSpacerHeightPx(spacer, baseInsetPx);
      if (Math.abs(next - current) < 1) {
        if (pendingAnchorScroll) {
          pendingAnchorScroll = false;
          finishAnchorSlide();
        }
        return;
      }
      const wasNearBottom = isScrollContainerNearBottom({
        scrollTop: container.scrollTop,
        clientHeight: container.clientHeight,
        scrollHeight: container.scrollHeight,
      });
      spacer.style.height = `${next}px`;
      // Growing the reserve moves the list end away; re-stick so the anchored
      // message reaches (or stays at) the viewport top. Shrinks during streaming
      // are net-zero (content grew by the same amount) and need no scrolling.
      if (pendingAnchorScroll || (next > current && wasNearBottom)) {
        const wasAnchorSlide = pendingAnchorScroll;
        pendingAnchorScroll = false;
        const scrolled = listRef.current?.scrollToEnd?.({ animated: wasAnchorSlide });
        if (wasAnchorSlide && typeof scrolled?.then !== "function") {
          finishAnchorSlide();
        }
        // An animated scroll targets the end position captured at call time; row
        // measurement corrections that land mid-flight leave it short by the
        // delta. Snap the remainder once the animation settles.
        void scrolled?.then(() => {
          if (disposed) {
            return;
          }
          if (wasAnchorSlide) {
            finishAnchorSlide();
          }
          const settledContainer = getScrollContainer(listRef);
          if (!settledContainer) {
            return;
          }
          const distanceFromBottom =
            settledContainer.scrollHeight -
            settledContainer.clientHeight -
            settledContainer.scrollTop;
          // Within a viewport of the end means the anchor scroll basically got
          // there and only late row measurements left it short; farther away
          // means the user scrolled off mid-animation — leave them alone.
          if (distanceFromBottom > 1 && distanceFromBottom <= settledContainer.clientHeight) {
            let snapFramesLeft = 10;
            const snap = () => {
              if (disposed || snapFramesLeft <= 0) {
                return;
              }
              snapFramesLeft -= 1;
              const c = getScrollContainer(listRef);
              if (!c) {
                return;
              }
              const max = c.scrollHeight - c.clientHeight;
              if (max - c.scrollTop > 1) {
                c.scrollTop = max;
              }
              window.requestAnimationFrame(snap);
            };
            snap();
          }
        });
      }
    }

    function schedule(): void {
      if (disposed || measureFrameId !== null) {
        return;
      }
      measureFrameId = window.requestAnimationFrame(() => {
        measureFrameId = null;
        if (measuring) {
          return;
        }
        measuring = true;
        measure();
        measuring = false;
      });
    }

    // Spacer resizes must land in the same frame as the content change that
    // caused them: the pinned layout relies on total scroll height staying
    // constant while the response streams, and a frame of lag lets the other
    // scroll-at-end keepers (LegendList's maintainScrollAtEnd, ChatView's
    // auto-follow) see a stale end and yank the viewport up, then the late
    // shrink clamps it back down — the visible send jitter. The <1px guard in
    // measure() breaks any resize->totalSize feedback loop. A change can also
    // fire while LegendList's DOM is mid-update (row appended but not yet
    // positioned), so a rAF verification pass always follows the synchronous
    // one; it is a no-op whenever the synchronous pass already got it right.
    function measureNow(): void {
      if (disposed || measuring) {
        return;
      }
      measuring = true;
      measure();
      measuring = false;
      schedule();
    }

    // Content-size changes (rows landing, streamed text growing) drive the
    // synchronous resizes; the container observer covers viewport/layout
    // changes, which are not part of the pinned-height invariant and stay on
    // the rAF path (mutating layout inside a ResizeObserver callback triggers
    // "loop completed with undelivered notifications").
    const unlistenTotalSize = listRef.current?.getState?.()?.listen?.("totalSize", measureNow);
    const container = getScrollContainer(listRef);
    let resizeObserver: ResizeObserver | null = null;
    if (container && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(container);
    }
    schedule();

    return () => {
      disposed = true;
      if (anchorScrollInFlightRef) {
        anchorScrollInFlightRef.current = false;
      }
      if (measureFrameId !== null) {
        window.cancelAnimationFrame(measureFrameId);
        measureFrameId = null;
      }
      unlistenTotalSize?.();
      resizeObserver?.disconnect();
    };
  }, [anchorMessageId, anchorScrollInFlightRef, baseInsetPx, listRef, spacerRef, timelineRootRef]);

  // Unmount (thread switch remounts the timeline): drop any pending collapse timers.
  useEffect(() => {
    return () => {
      if (collapseTimeoutRef.current !== null) {
        window.clearTimeout(collapseTimeoutRef.current);
      }
      if (collapseStartFrameRef.current !== null) {
        window.cancelAnimationFrame(collapseStartFrameRef.current);
      }
    };
  }, []);
}
