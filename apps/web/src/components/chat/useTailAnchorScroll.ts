// FILE: useTailAnchorScroll.ts
// Purpose: Slide a just-sent user message to the top of the transcript viewport
//          and own the scroll until that slide settles.
// Layer: Chat transcript behavior hook
// Why: The space that lets the message anchor at the top while the response
//      streams below it is reserved natively by LegendList's `anchoredEndSpace`
//      (configured in MessagesTimeline), which keeps the reserve in sync with
//      measured row sizes inside the list's own layout pass. This hook only
//      performs the one visible motion — scrolling the sent message to its
//      anchored coordinate — and guards it: while the slide is in flight the
//      shared flag pauses ChatView's auto-follow re-snaps so the slide has a
//      single scroll owner. Normal sends animate; steering an already-streaming
//      turn anchors immediately and then holds the coordinate for a settle
//      window because the previous assistant row can still receive late chunks
//      above the new anchor.

import { type MessageId } from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useLayoutEffect, useRef, type RefObject } from "react";

// A freshly appended anchor row can take a few frames to be committed and for
// the native end-space reserve to make its anchored coordinate reachable.
const ANCHOR_MEASURE_MAX_RETRY_FRAMES = 90;

const ANCHOR_SLIDE_MAX_SETTLE_MS = 750;
const ANCHOR_SLIDE_SETTLED_FRAMES = 3;
const STEER_ANCHOR_MIN_SETTLE_MS = 500;

interface UseTailAnchorScrollOptions {
  listRef: RefObject<LegendListRef | null>;
  timelineRootRef: RefObject<HTMLElement | null>;
  /** User message currently anchored at the viewport top; null releases the hook. */
  anchorMessageId: MessageId | null;
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
 * scrollTop that puts the anchored message's top edge one top-inset below the
 * viewport top. Derived from the anchor's own box so it is exact regardless of
 * the virtualized list's estimated positions. Returns both the desired and the
 * range-clamped value so callers can tell when the native end-space reserve has
 * not yet made the coordinate reachable.
 */
function anchoredScrollTargetPx(
  container: HTMLElement,
  anchorElement: HTMLElement | null,
): { desired: number; clamped: number } | null {
  if (!anchorElement || anchorElement.getClientRects().length === 0) {
    return null;
  }
  const topInsetPx = Number.parseFloat(getComputedStyle(container).paddingTop) || 0;
  const offsetFromViewportTop =
    anchorElement.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const maxScrollTopPx = Math.max(0, container.scrollHeight - container.clientHeight);
  const desired = Math.max(0, container.scrollTop + offsetFromViewportTop - topInsetPx);
  return { desired, clamped: Math.min(maxScrollTopPx, desired) };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function useTailAnchorScroll({
  listRef,
  timelineRootRef,
  anchorMessageId,
  anchorScrollInFlightRef,
  onAnchorSlideFinished,
  contentChangeSignal,
  animateAnchorSlide = true,
}: UseTailAnchorScrollOptions): void {
  const anchorSlideCorrectionRef = useRef<(() => void) | null>(null);
  const animateAnchorSlideRef = useRef(animateAnchorSlide);

  // Capture the mode selected for each new anchor without restarting an active
  // steering settle when `followLiveOutput` later flips to false.
  useLayoutEffect(() => {
    animateAnchorSlideRef.current = animateAnchorSlide;
  }, [anchorMessageId, animateAnchorSlide]);

  useLayoutEffect(() => {
    if (anchorMessageId === null) {
      if (anchorScrollInFlightRef) {
        anchorScrollInFlightRef.current = false;
      }
      return;
    }

    const anchorId = anchorMessageId;
    const shouldAnimateAnchorSlide = animateAnchorSlideRef.current;
    if (anchorScrollInFlightRef) {
      anchorScrollInFlightRef.current = true;
    }

    let disposed = false;
    let waitFrameId: number | null = null;
    let retryFramesLeft = ANCHOR_MEASURE_MAX_RETRY_FRAMES;
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

    // The slide is over (or was never possible): hand scroll ownership back to
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
      const target = container ? anchoredScrollTargetPx(container, findAnchorElement()) : null;
      if (container && target !== null && Math.abs(target.clamped - container.scrollTop) > 1) {
        container.scrollTop = target.clamped;
      }
      finishAnchorSlide();
    }

    function startAnchorSlide(container: HTMLElement, anchorElement: HTMLElement): void {
      const target = anchoredScrollTargetPx(container, anchorElement);
      if (target === null) {
        finishAnchorSlide();
        return;
      }
      clearAnchorSlideCompletion();

      // Keep the already-stable normal-send motion unchanged. Only steering
      // needs the live coordinate correction below because it has a growing row
      // above the new anchor.
      if (shouldAnimateAnchorSlide) {
        if (prefersReducedMotion() || Math.abs(target.clamped - container.scrollTop) <= 1) {
          container.scrollTop = target.clamped;
          finishAnchorSlide();
          return;
        }
        anchorSlideContainer = container;
        anchorSlideScrollEndListener = () => {
          const currentTarget = anchoredScrollTargetPx(container, findAnchorElement());
          if (
            currentTarget !== null &&
            Math.abs(currentTarget.clamped - container.scrollTop) <= 1
          ) {
            settleAnimatedAnchorSlide();
          }
        };
        container.addEventListener("scrollend", anchorSlideScrollEndListener);
        anchorSlideFallbackId = window.setTimeout(
          settleAnimatedAnchorSlide,
          ANCHOR_SLIDE_MAX_SETTLE_MS,
        );
        container.scrollTo({ top: target.clamped, behavior: "smooth" });
        return;
      }

      container.scrollTop = target.clamped;
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

        const currentOffset =
          currentAnchor.getBoundingClientRect().top - currentContainer.getBoundingClientRect().top;
        const correction = currentOffset - topInsetPx;
        if (Math.abs(correction) > 0.5) {
          currentContainer.scrollTop += correction;
        }

        settledFrames = Math.abs(currentOffset - topInsetPx) <= 1 ? settledFrames + 1 : 0;
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

    // Wait until the anchor row is committed and the native end-space reserve
    // has made its anchored coordinate reachable, then run the single slide.
    // Bounded so a degenerate transcript degrades to a clamped slide instead of
    // holding the auto-follow pause forever.
    function waitForAnchorAndSlide(): void {
      if (disposed) {
        return;
      }
      const container = getScrollContainer(listRef);
      const anchorElement = findAnchorElement();
      const target = container ? anchoredScrollTargetPx(container, anchorElement) : null;
      if (
        container &&
        anchorElement &&
        target !== null &&
        (target.desired <= target.clamped + 1 || retryFramesLeft <= 0)
      ) {
        startAnchorSlide(container, anchorElement);
        return;
      }
      if (retryFramesLeft <= 0) {
        finishAnchorSlide();
        return;
      }
      retryFramesLeft -= 1;
      waitFrameId = window.requestAnimationFrame(() => {
        waitFrameId = null;
        waitForAnchorAndSlide();
      });
    }

    waitForAnchorAndSlide();

    return () => {
      disposed = true;
      clearAnchorSlideCompletion();
      if (anchorScrollInFlightRef) {
        anchorScrollInFlightRef.current = false;
      }
      if (waitFrameId !== null) {
        window.cancelAnimationFrame(waitFrameId);
        waitFrameId = null;
      }
    };
  }, [anchorMessageId, anchorScrollInFlightRef, listRef, onAnchorSlideFinished, timelineRootRef]);

  // React commits streamed text before paint. Re-apply the current slide
  // coordinate in that layout window so a final pre-steer assistant chunk above
  // the anchor cannot push the steering message down for one visible frame.
  useLayoutEffect(() => {
    anchorSlideCorrectionRef.current?.();
  }, [contentChangeSignal]);
}
