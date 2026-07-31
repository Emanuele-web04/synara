// FILE: useTailAnchorSpacer.ts
// Purpose: Size the transcript's tail spacer so a just-sent user message can anchor
//          at the top of the viewport while the assistant response streams below it.
// Layer: Chat transcript behavior hook
// Why: Right after a send there is almost no content below the new message, so the
//      browser cannot scroll it to the viewport top. Reserving the missing space in
//      the list footer makes "scrolled to end" mean "sent message at viewport top",
//      which lets the existing scroll-to-end + stick-to-end machinery produce the
//      anchored layout with no second scroll system. While the response is shorter
//      than the viewport it grows into the reserve (total scroll height stays
//      constant, so the message stays pinned); once it overflows, the spacer bottoms
//      out at the base inset and normal follow-the-tail scrolling resumes. When the
//      turn ends the reserve collapses with the shared disclosure motion.

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
    const spacerAtStart = spacerRef.current;
    if (spacerAtStart) {
      spacerAtStart.style.transition = "";
    }

    let disposed = false;
    let measureFrameId: number | null = null;
    let retryFramesLeft = ANCHOR_MEASURE_MAX_RETRY_FRAMES;
    // The first successful measurement after a new anchor owns the smooth slide.
    let pendingAnchorScroll = true;

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
          retryFramesLeft -= 1;
          schedule();
        }
        return;
      }
      const spacerTop = spacer.getBoundingClientRect().top;
      const anchorTop = anchorElement.getBoundingClientRect().top;
      const paddingBottom = Number.parseFloat(getComputedStyle(container).paddingBottom) || 0;
      const next = computeTailAnchorSpacerHeightPx({
        viewportHeightPx: container.clientHeight,
        anchorTopToSpacerTopPx: spacerTop - anchorTop,
        trailingInsetPx: paddingBottom,
        baseInsetPx,
      });
      const current = readSpacerHeightPx(spacer, baseInsetPx);
      if (Math.abs(next - current) < 1) {
        pendingAnchorScroll = false;
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
        const animated = pendingAnchorScroll;
        pendingAnchorScroll = false;
        const scrolled = listRef.current?.scrollToEnd?.({ animated });
        // An animated scroll targets the end position captured at call time; row
        // measurement corrections that land mid-flight leave it short by the
        // delta. Snap the remainder once the animation settles.
        void scrolled?.then(() => {
          if (disposed) {
            return;
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
        measure();
      });
    }

    // Content-size changes (rows landing, streamed text growing) drive resizes;
    // the container observer covers viewport/layout changes.
    const unlistenTotalSize = listRef.current?.getState?.()?.listen?.("totalSize", schedule);
    const container = getScrollContainer(listRef);
    let resizeObserver: ResizeObserver | null = null;
    if (container && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(container);
    }
    schedule();

    return () => {
      disposed = true;
      if (measureFrameId !== null) {
        window.cancelAnimationFrame(measureFrameId);
        measureFrameId = null;
      }
      unlistenTotalSize?.();
      resizeObserver?.disconnect();
    };
  }, [anchorMessageId, baseInsetPx, listRef, spacerRef, timelineRootRef]);

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
