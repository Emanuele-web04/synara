// FILE: useTailAnchorSpacer.ts
// Purpose: Size the transcript's tail spacer so a just-sent user message can anchor
//          at the top of the viewport while the assistant response streams below it.
// Layer: Chat transcript behavior hook
// Why: Right after a send there is almost no content below the new message, so the
//      browser cannot scroll it to the viewport top. Reserving the missing space in
//      the list footer makes "scrolled to end" mean "sent message anchored just
//      below the viewport top" (offset by the container's own top padding, matching
//      a chat's first message). Once the row is measurable, the slide targets
//      that exact anchored coordinate rather than LegendList's moving end, while
//      the footer reserve lets the message remain there as the response grows.
//      Resizes are applied synchronously with the content change that
//      caused them so the invariant holds within every frame — except on frames
//      where LegendList still positions the tail from `estimatedItemSize`, which
//      are skipped outright because sizing the reserve from an estimate moves the
//      scroll max and throws the anchored message past the viewport top. Through
//      the whole slide and its settle window this hook is the sole scroll owner
//      (the shared in-flight flag pauses ChatView's auto-follow re-snaps), and it
//      only ever chases the anchor's own target, never the raw list end. While the
//      response is shorter than the viewport it grows into the
//      reserve (total scroll height stays constant, so the message stays pinned);
//      once it overflows, the spacer bottoms out at the base inset and normal
//      follow-the-tail scrolling resumes. The reserve persists after the turn ends
//      so the settled transcript never jumps; it is replaced by the next send and
//      reset by thread switches (the timeline remounts per thread). The animated
//      collapse below is a fallback for an anchor being cleared while mounted.

import { type MessageId } from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { computeTailAnchorSpacerHeightPx, isScrollContainerNearBottom } from "../../chat-scroll";
import { DISCLOSURE_CLEANUP_BUFFER_MS, DISCLOSURE_TRANSITION_MS } from "~/lib/disclosureMotion";

// A freshly appended anchor row can take a while to be committed by the virtualized
// list — especially when the send happened far from the bottom and a tail reveal
// still has to bring the row into the render window. Retry across
// that window; afterwards content-size changes re-trigger measurement anyway.
const ANCHOR_MEASURE_MAX_RETRY_FRAMES = 90;

// Give the optimistic row a couple of frames to commit before asking LegendList
// to reveal its tail. Starting an animated end-scroll immediately creates a
// second, estimate-based motion before the real anchor target is measurable.
const ANCHOR_REVEAL_AFTER_MISSING_FRAMES = 3;

const ANCHOR_SLIDE_MAX_SETTLE_MS = 750;
const ANCHOR_SLIDE_SETTLED_FRAMES = 3;
const STEER_ANCHOR_MIN_SETTLE_MS = 500;

// How long a measurement may wait for LegendList's tail positions to match the
// rendered rows. Bounded so an unexpected steady-state mismatch (a row box the
// list measures differently than its border box) degrades to a small delay
// instead of freezing the reserve.
const STALE_TAIL_MAX_DEFERRED_FRAMES = 3;

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
  /** Lets the list suspend its own end-follow until the anchor slide is settled. */
  onAnchorSlideFinished?: ((messageId: MessageId) => void) | undefined;
  /** Changes whenever transcript content may have moved the anchor row. */
  contentChangeSignal?: unknown;
  /** Normal sends slide; steering an already-streaming turn anchors immediately. */
  animateAnchorSlide?: boolean | undefined;
}

function getScrollContainer(listRef: RefObject<LegendListRef | null>): HTMLElement | null {
  const node: unknown = listRef.current?.getScrollableNode?.();
  return node instanceof HTMLElement ? node : null;
}

/**
 * True when LegendList's tail positions match what is actually rendered.
 *
 * A freshly appended row is positioned from `estimatedItemSize` until its real
 * height is reported, so for one frame the list footer — and with it the spacer
 * — sits at an offset that does not match the rendered rows. Sizing the reserve
 * from that frame bakes the estimate in: the reserve over- or under-shrinks,
 * the scroll max moves with it, and the anchored message visibly overshoots the
 * top and springs back. The gap between the last rendered row's bottom edge and
 * the spacer's top edge is exactly that estimate error, so it is the signal to
 * wait a frame on. It is zero once the row's real size lands.
 */
function isTailLayoutSettled(
  listRef: RefObject<LegendListRef | null>,
  spacer: HTMLElement,
): boolean {
  const state = listRef.current?.getState?.();
  if (!state) {
    return true;
  }
  const lastIndex = state.data.length - 1;
  if (lastIndex < 0) {
    return true;
  }
  const lastElement: unknown = state.elementAtIndex(lastIndex);
  if (!(lastElement instanceof HTMLElement) || lastElement.getClientRects().length === 0) {
    return true;
  }
  return (
    Math.abs(spacer.getBoundingClientRect().top - lastElement.getBoundingClientRect().bottom) <= 1
  );
}

/**
 * scrollTop that puts the anchored message's top edge one top-inset below the
 * viewport top, clamped to the container's scroll range. Derived from the
 * anchor's own box, so unlike "the list end" it cannot be thrown off by a row
 * that momentarily overstates the content height.
 */
function anchoredScrollTopPx(
  container: HTMLElement,
  anchorElement: HTMLElement | null,
): number | null {
  if (!anchorElement || anchorElement.getClientRects().length === 0) {
    return null;
  }
  const topInsetPx = Number.parseFloat(getComputedStyle(container).paddingTop) || 0;
  const offsetFromViewportTop =
    anchorElement.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const maxScrollTopPx = Math.max(0, container.scrollHeight - container.clientHeight);
  return Math.min(
    maxScrollTopPx,
    Math.max(0, container.scrollTop + offsetFromViewportTop - topInsetPx),
  );
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
  onAnchorSlideFinished,
  contentChangeSignal,
  animateAnchorSlide = true,
}: UseTailAnchorSpacerOptions): void {
  const previousAnchorRef = useRef<MessageId | null>(null);
  const collapseTimeoutRef = useRef<number | null>(null);
  const collapseStartFrameRef = useRef<number | null>(null);
  const anchorSlideCorrectionRef = useRef<(() => void) | null>(null);
  const animateAnchorSlideRef = useRef(animateAnchorSlide);

  // Capture the mode selected for each new anchor without restarting an active
  // steering settle when `followLiveOutput` later flips to false.
  useLayoutEffect(() => {
    animateAnchorSlideRef.current = animateAnchorSlide;
  }, [anchorMessageId, animateAnchorSlide]);

  useLayoutEffect(() => {
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
    const shouldAnimateAnchorSlide = animateAnchorSlideRef.current;
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
    let missingAnchorFrames = 0;
    // The first successful measurement after a new anchor owns the smooth slide.
    let pendingAnchorScroll = true;
    // A send far from the bottom leaves the new row outside the render window,
    // so the slide toward the end must start before the row can be measured.
    let requestedTailReveal = false;
    // Consecutive measurements skipped while LegendList's tail was still on
    // estimated sizes (see isTailLayoutSettled).
    let deferredForStaleTail = 0;
    let anchorSlideFrameId: number | null = null;
    let anchorSlideFallbackId: number | null = null;
    let anchorSlideContainer: HTMLElement | null = null;
    let anchorSlideScrollEndListener: (() => void) | null = null;
    let advanceAnchorSlide: ((now: number) => boolean) | null = null;
    let anchorLayoutObserver: MutationObserver | null = null;

    function clearAnchorSlideCompletion(): void {
      if (anchorSlideFrameId !== null) {
        window.cancelAnimationFrame(anchorSlideFrameId);
        anchorSlideFrameId = null;
      }
      if (anchorSlideFallbackId !== null) {
        window.clearTimeout(anchorSlideFallbackId);
        anchorSlideFallbackId = null;
      }
      if (anchorSlideContainer && anchorSlideScrollEndListener) {
        anchorSlideContainer.removeEventListener("scrollend", anchorSlideScrollEndListener);
      }
      anchorSlideContainer = null;
      anchorSlideScrollEndListener = null;
      advanceAnchorSlide = null;
      anchorSlideCorrectionRef.current = null;
      anchorLayoutObserver?.disconnect();
      anchorLayoutObserver = null;
    }

    // The slide is over (or was never needed): hand scroll ownership back to
    // ChatView's auto-follow machinery.
    function finishAnchorSlide(): void {
      clearAnchorSlideCompletion();
      if (anchorScrollInFlightRef) {
        anchorScrollInFlightRef.current = false;
      }
      onAnchorSlideFinished?.(anchorId);
    }

    function findAnchorElement(): HTMLElement | null {
      return (
        timelineRootRef.current?.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(anchorId)}"]`,
        ) ?? null
      );
    }

    function settleAnimatedAnchorSlide(): void {
      if (disposed) {
        return;
      }
      if (anchorScrollInFlightRef && !anchorScrollInFlightRef.current) {
        finishAnchorSlide();
        return;
      }
      const container = getScrollContainer(listRef);
      const target = container ? anchoredScrollTopPx(container, findAnchorElement()) : null;
      if (container && target !== null && Math.abs(target - container.scrollTop) > 1) {
        container.scrollTop = target;
      }
      finishAnchorSlide();
    }

    function startAnchorSlide(container: HTMLElement, anchorElement: HTMLElement): void {
      const target = anchoredScrollTopPx(container, anchorElement);
      if (target === null) {
        finishAnchorSlide();
        return;
      }
      clearAnchorSlideCompletion();

      // Keep the already-stable normal-send motion unchanged. Only steering
      // needs the live coordinate correction below because it has a growing row
      // above the new anchor.
      if (shouldAnimateAnchorSlide) {
        if (prefersReducedMotion() || Math.abs(target - container.scrollTop) <= 1) {
          container.scrollTop = target;
          finishAnchorSlide();
          return;
        }
        anchorSlideContainer = container;
        anchorSlideScrollEndListener = () => {
          const currentTarget = anchoredScrollTopPx(container, findAnchorElement());
          if (currentTarget !== null && Math.abs(currentTarget - container.scrollTop) <= 1) {
            settleAnimatedAnchorSlide();
          }
        };
        container.addEventListener("scrollend", anchorSlideScrollEndListener);
        anchorSlideFallbackId = window.setTimeout(
          settleAnimatedAnchorSlide,
          ANCHOR_SLIDE_MAX_SETTLE_MS,
        );
        container.scrollTo({ top: target, behavior: "smooth" });
        return;
      }

      container.scrollTop = target;
      const startedAt = performance.now();
      const topInsetPx = Number.parseFloat(getComputedStyle(container).paddingTop) || 0;
      let settledFrames = 0;

      advanceAnchorSlide = (now: number) => {
        if (disposed) {
          return true;
        }
        // A pointer/wheel/touch gesture clears the shared flag in ChatView. Do
        // not pull the transcript back after the user takes over the scroll.
        if (anchorScrollInFlightRef && !anchorScrollInFlightRef.current) {
          finishAnchorSlide();
          return true;
        }
        const currentContainer = getScrollContainer(listRef);
        const currentAnchor = findAnchorElement();
        if (!currentContainer || !currentAnchor || currentAnchor.getClientRects().length === 0) {
          finishAnchorSlide();
          return true;
        }

        const desiredOffset = topInsetPx;
        const currentOffset =
          currentAnchor.getBoundingClientRect().top - currentContainer.getBoundingClientRect().top;
        const correction = currentOffset - desiredOffset;
        if (Math.abs(correction) > 0.5) {
          currentContainer.scrollTop += correction;
        }

        const spacer = spacerRef.current;
        const anchorIsSettled = Math.abs(currentOffset - topInsetPx) <= 1;
        settledFrames =
          spacer && anchorIsSettled && isTailLayoutSettled(listRef, spacer)
            ? settledFrames + 1
            : 0;
        if (
          (settledFrames < ANCHOR_SLIDE_SETTLED_FRAMES ||
            now - startedAt < STEER_ANCHOR_MIN_SETTLE_MS) &&
          now - startedAt < ANCHOR_SLIDE_MAX_SETTLE_MS
        ) {
          return false;
        }
        finishAnchorSlide();
        return true;
      };
      anchorSlideCorrectionRef.current = () => {
        advanceAnchorSlide?.(performance.now());
      };
      const timelineRoot = timelineRootRef.current;
      if (timelineRoot && typeof MutationObserver !== "undefined") {
        anchorLayoutObserver = new MutationObserver(() => {
          anchorSlideCorrectionRef.current?.();
        });
        // LegendList repositions the anchor's absolute wrapper by mutating its
        // inline style after a preceding streaming row is remeasured. Catch
        // that mutation before paint instead of waiting for the next rAF.
        anchorLayoutObserver.observe(timelineRoot, {
          attributes: true,
          attributeFilter: ["style"],
          subtree: true,
        });
      }
      const step = (now: number) => {
        anchorSlideFrameId = null;
        if (!advanceAnchorSlide?.(now)) {
          anchorSlideFrameId = window.requestAnimationFrame(step);
        }
      };
      anchorSlideFrameId = window.requestAnimationFrame(step);
    }

    function measure(): void {
      const container = getScrollContainer(listRef);
      const spacer = spacerRef.current;
      const root = timelineRootRef.current;
      if (!container || !spacer || !root) {
        return;
      }
      const anchorElement = findAnchorElement();
      if (!anchorElement || anchorElement.getClientRects().length === 0) {
        // Row not committed yet (or virtualized out). Retry briefly for the
        // fresh-send case; otherwise freeze the current reserve.
        if (retryFramesLeft > 0) {
          missingAnchorFrames += 1;
          if (
            pendingAnchorScroll &&
            !requestedTailReveal &&
            missingAnchorFrames >= ANCHOR_REVEAL_AFTER_MISSING_FRAMES
          ) {
            requestedTailReveal = true;
            // This is only a virtualization reveal. The one visible animation
            // begins after the row exists and can supply an exact top target.
            void listRef.current?.scrollToEnd?.({ animated: false });
          }
          retryFramesLeft -= 1;
          schedule();
        } else if (pendingAnchorScroll) {
          pendingAnchorScroll = false;
          finishAnchorSlide();
        }
        return;
      }
      missingAnchorFrames = 0;
      // Never size the reserve from a frame where the tail is still positioned
      // from estimated row sizes — that estimate error is what makes the
      // anchored message shoot past the top and spring back.
      if (
        !isTailLayoutSettled(listRef, spacer) &&
        deferredForStaleTail < STALE_TAIL_MAX_DEFERRED_FRAMES
      ) {
        deferredForStaleTail += 1;
        schedule();
        return;
      }
      deferredForStaleTail = 0;
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
      const spacerChanged = Math.abs(next - current) >= 1;
      const wasNearBottom = isScrollContainerNearBottom({
        scrollTop: container.scrollTop,
        clientHeight: container.clientHeight,
        scrollHeight: container.scrollHeight,
      });
      if (spacerChanged) {
        spacer.style.height = `${next}px`;
      }
      // Growing the reserve moves the list end away; re-stick so the anchored
      // message reaches (or stays at) the viewport top. Shrinks during streaming
      // are net-zero (content grew by the same amount) and need no scrolling.
      if (pendingAnchorScroll) {
        pendingAnchorScroll = false;
        startAnchorSlide(container, anchorElement);
      } else if (spacerChanged && next > current && wasNearBottom) {
        const target = anchoredScrollTopPx(container, anchorElement);
        if (target !== null && target - container.scrollTop > 1) {
          container.scrollTop = target;
        }
      }
      // A steering message is appended below an assistant row that may still
      // receive one last streaming chunk. Correct that above-anchor growth in
      // the same total-size notification so it never paints as a downward hop.
      advanceAnchorSlide?.(performance.now());
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
    if (shouldAnimateAnchorSlide) {
      schedule();
    } else {
      measureNow();
    }

    return () => {
      disposed = true;
      clearAnchorSlideCompletion();
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
  }, [
    anchorMessageId,
    anchorScrollInFlightRef,
    baseInsetPx,
    listRef,
    onAnchorSlideFinished,
    spacerRef,
    timelineRootRef,
  ]);

  // React commits streamed text before paint. Re-apply the current slide
  // coordinate in that layout window so a final pre-steer assistant chunk above
  // the anchor cannot push the steering message down for one visible frame.
  useLayoutEffect(() => {
    anchorSlideCorrectionRef.current?.();
  }, [contentChangeSignal]);

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
