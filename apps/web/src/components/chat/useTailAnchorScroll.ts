// the end-space is reserved by LegendList's anchoredEndSpace; this hook only animates the message to its anchored coordinate, re-reading the moving target every frame so the slide lands right while geometry shifts under it

import { type MessageId } from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useLayoutEffect, useRef, type RefObject } from "react";

import { ANCHOR_SLIDE_DURATION_MS, anchorSlideOffsetPx } from "./transcriptScroll";

// Absolute bound on the slide plus its hold, so a transcript that never stops moving can never hold the auto-follow pause open.
const ANCHOR_SLIDE_MAX_MS = 3_000;
// ownership is kept until the transcript stops moving the anchor — rows above keep settling to measured height for a few hundred ms after a send and would shove it off its coordinate
const ANCHOR_HOLD_QUIET_MS = 450;
// steering a streaming turn keeps holding the coordinate a beat: the previous assistant row can still receive late chunks above the new anchor
const STEER_ANCHOR_MIN_SETTLE_MS = 500;
// a freshly appended anchor row can take frames to commit; until it exists there's nothing to measure, so the loop waits
const ANCHOR_MOUNT_MAX_WAIT_MS = 1_000;
// consecutive overflow frames required before the hold hands off to follow-the-tail, so a one-frame reserve recompute can't end it early
const ANCHOR_OVERFLOW_HANDOFF_FRAMES = 3;
// while the reserve does its job the tail sits exactly at the viewport bottom — this only has to cover reserve-recompute rounding
const ANCHOR_OVERFLOW_SLACK_PX = 8;
// a fresh row can report a transient position for one frame; the slide's first move waits for a repeated content position, no longer than this
const ANCHOR_POSITION_CONFIRM_MAX_MS = 150;

type ScrollableListRef = RefObject<Pick<LegendListRef, "getScrollableNode"> | null>;

interface UseTailAnchorScrollOptions {
  listRef: ScrollableListRef;
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
  /** Changes whenever transcript geometry may have moved the anchor row. */
  contentChangeSignal?: unknown;
  /** Changes only when a real transcript message is added or updated. */
  messageChangeSignal?: unknown;
  /** Normal sends slide; steering an already-streaming turn anchors immediately. */
  animateAnchorSlide?: boolean | undefined;
}

function getScrollContainer(listRef: ScrollableListRef): HTMLElement | null {
  const node: unknown = listRef.current?.getScrollableNode?.();
  return node instanceof HTMLElement ? node : null;
}

/**
 * scrollTop that puts the anchored message's top edge one top-inset below the
 * viewport top, clamped to the currently reachable range. Derived from the
 * anchor's own box so it is exact regardless of the virtualized list's estimated
 * positions, and re-read every frame so the slide tracks the coordinate as the
 * native end-space reserve makes more of it reachable.
 */
function anchoredScrollTargetPx(
  container: HTMLElement,
  anchorElement: HTMLElement | null,
  topInsetPx: number,
): {
  desired: number;
  clamped: number;
  maxScrollTopPx: number;
  offsetFromViewportTop: number;
} | null {
  if (!anchorElement || anchorElement.getClientRects().length === 0) {
    return null;
  }
  const offsetFromViewportTop =
    anchorElement.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const maxScrollTopPx = Math.max(0, container.scrollHeight - container.clientHeight);
  const desired = Math.max(0, container.scrollTop + offsetFromViewportTop - topInsetPx);
  return {
    desired,
    clamped: Math.min(maxScrollTopPx, desired),
    maxScrollTopPx,
    offsetFromViewportTop,
  };
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
  messageChangeSignal,
  animateAnchorSlide = true,
}: UseTailAnchorScrollOptions): void {
  const anchorSlideCorrectionRef = useRef<(() => void) | null>(null);
  const lastContentChangeAtRef = useRef(0);
  const animateAnchorSlideRef = useRef(animateAnchorSlide);

  // capture the mode for each new anchor without restarting an active steering settle when followLiveOutput flips
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
    // steering (and reduced motion) skips the eased approach: the coordinate is taken immediately and held
    const easeToAnchor = animateAnchorSlideRef.current && !prefersReducedMotion();
    if (anchorScrollInFlightRef) {
      anchorScrollInFlightRef.current = true;
    }

    let disposed = false;
    let frameId: number | null = null;
    let layoutObserver: MutationObserver | null = null;
    // the top padding is fixed for the life of a slide — the layout-forcing computed-style read happens once
    let topInsetPx: number | null = null;
    const startedAt = performance.now();
    // flips once the anchor first reaches its coordinate (requires the reserve to exist); from then on corrections snap instead of easing so late layout shifts move it at most one frame
    let hasLanded = false;
    let lastCorrectionAt = startedAt;
    let overflowFrames = 0;
    // last observed content position, used to confirm the row is really laid out before the slide commits
    let confirmedDesired: number | null = null;
    // set on the first measurable frame; re-seeded if an early frame shows the row was still mid-layout
    let glideStartedAt: number | null = null;
    let glideFromOffsetPx = 0;
    // once the reserve has been deep enough to lift the anchor even once, a later shortfall means the response outgrew it
    let hasBeenReachable = false;

    function stopFrameLoop(): void {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        frameId = null;
      }
      anchorSlideCorrectionRef.current = null;
      layoutObserver?.disconnect();
      layoutObserver = null;
    }

    // slide over (or impossible): hand scroll ownership back to ChatView's auto-follow
    function finishAnchorSlide(): void {
      stopFrameLoop();
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

    /** One step of the slide. Returns true when the anchor is done moving. */
    function advanceAnchorSlide(now: number): boolean {
      if (disposed) {
        return true;
      }
      // a pointer/wheel/touch gesture clears the shared flag in ChatView — don't pull the transcript back after the user takes over
      if (anchorScrollInFlightRef && !anchorScrollInFlightRef.current) {
        finishAnchorSlide();
        return true;
      }
      const elapsedMs = now - startedAt;

      const container = getScrollContainer(listRef);
      if (container && topInsetPx === null) {
        topInsetPx = Number.parseFloat(window.getComputedStyle(container).paddingTop) || 0;
      }
      const target = container
        ? anchoredScrollTargetPx(container, findAnchorElement(), topInsetPx ?? 0)
        : null;
      if (!container || target === null) {
        // the row hasn't committed yet — keep waiting instead of finishing at whatever offset the transcript happens to sit at
        if (elapsedMs < ANCHOR_MOUNT_MAX_WAIT_MS) {
          return false;
        }
        finishAnchorSlide();
        return true;
      }

      // a non-repeating first measurement means the row was read mid-layout — acting on it would snap to a coordinate the message never had (visible jump); only the snap path waits, the glide re-seeds
      if (!easeToAnchor && !hasLanded && elapsedMs < ANCHOR_POSITION_CONFIRM_MAX_MS) {
        const settled =
          confirmedDesired !== null && Math.abs(target.desired - confirmedDesired) <= 1;
        confirmedDesired = target.desired;
        if (!settled) {
          return false;
        }
      }

      // the coordinate is reachable only once the end-space reserve is large enough to lift the anchor; until then it's still parked at the bottom
      const reachable = target.desired <= target.clamped + 1;
      hasBeenReachable = hasBeenReachable || reachable;
      // mirror image: holding the anchor at top leaves the live tail below the viewport — the response outgrew its reserve, hand off to follow-the-tail
      if (hasLanded && target.maxScrollTopPx - target.desired > ANCHOR_OVERFLOW_SLACK_PX) {
        overflowFrames += 1;
        if (overflowFrames >= ANCHOR_OVERFLOW_HANDOFF_FRAMES) {
          // complete the implied motion rather than releasing at the held coordinate — the list only re-sticks on its next content change, so leaving it would strand the transcript short of the live edge
          container.scrollTop = target.maxScrollTopPx;
          finishAnchorSlide();
          return true;
        }
      } else {
        overflowFrames = 0;
      }

      // the glide starts from wherever the message is painted on the first measurable frame — waiting for the reserve would hand the opening frames to the list, which puts the anchor at top itself leaving a jump
      const restOffsetPx = topInsetPx ?? 0;
      if (easeToAnchor && !hasLanded) {
        const scheduledOffsetPx =
          glideStartedAt === null
            ? Number.POSITIVE_INFINITY
            : anchorSlideOffsetPx({
                fromPx: glideFromOffsetPx,
                toPx: restOffsetPx,
                elapsedMs: now - glideStartedAt,
              });
        // finding the message below where the glide expects means it never moved: the reserve isn't deep enough yet (clock shouldn't run) or the seed was taken mid-layout — restart the schedule from the real position
        const belowSchedule = target.offsetFromViewportTop > scheduledOffsetPx + 1;
        if (
          glideStartedAt === null ||
          (belowSchedule && (!hasBeenReachable || elapsedMs < ANCHOR_POSITION_CONFIRM_MAX_MS))
        ) {
          glideFromOffsetPx = Math.min(
            Math.max(target.offsetFromViewportTop, restOffsetPx),
            container.clientHeight,
          );
          glideStartedAt = now;
        }
      }

      // the landing frame takes the absolute coordinate — relative placement accumulates sub-pixel error and the hold must be exact for the `target.clamped` comparison
      const glideElapsedMs = glideStartedAt === null ? 0 : now - glideStartedAt;
      const gliding =
        glideStartedAt !== null && !hasLanded && glideElapsedMs < ANCHOR_SLIDE_DURATION_MS;
      // positioning relative to where it was just measured keeps the motion on schedule as content above resizes: the scroll coordinate moves, the visible offset doesn't
      const nextScrollTopPx = gliding
        ? Math.min(
            target.maxScrollTopPx,
            Math.max(
              0,
              container.scrollTop +
                target.offsetFromViewportTop -
                anchorSlideOffsetPx({
                  fromPx: glideFromOffsetPx,
                  toPx: restOffsetPx,
                  elapsedMs: glideElapsedMs,
                }),
            ),
          )
        : target.clamped;

      // anything that moved the anchor off its coordinate since the last frame is a correction; while they arrive the hook keeps ownership
      if (Math.abs(nextScrollTopPx - container.scrollTop) > 0.5) {
        lastCorrectionAt = now;
        container.scrollTop = nextScrollTopPx;
      }

      if (gliding) {
        return false;
      }

      if (reachable && Math.abs(target.clamped - container.scrollTop) <= 1) {
        hasLanded = true;
      } else {
        lastCorrectionAt = now;
      }

      const minHoldMs = easeToAnchor ? 0 : STEER_ANCHOR_MIN_SETTLE_MS;
      const quiet =
        hasLanded &&
        now - Math.max(lastCorrectionAt, lastContentChangeAtRef.current) >= ANCHOR_HOLD_QUIET_MS;
      if ((!quiet || elapsedMs < minHoldMs) && elapsedMs < ANCHOR_SLIDE_MAX_MS) {
        return false;
      }
      finishAnchorSlide();
      return true;
    }

    anchorSlideCorrectionRef.current = () => {
      advanceAnchorSlide(performance.now());
    };
    const timelineRoot = timelineRootRef.current;
    if (timelineRoot && typeof MutationObserver !== "undefined") {
      layoutObserver = new MutationObserver(() => {
        anchorSlideCorrectionRef.current?.();
      });
      // LegendList mutates inline styles mid-frame after this loop's rAF step; correcting from the mutation lands before paint — waiting a frame leaves the anchor visibly displaced
      layoutObserver.observe(timelineRoot, {
        attributes: true,
        attributeFilter: ["style"],
        subtree: true,
      });
    }

    // frame-callback timestamps use a different clock origin than performance.now(); mixing them makes eased progress jump backwards mid-glide
    const step = () => {
      frameId = null;
      if (!advanceAnchorSlide(performance.now())) {
        frameId = window.requestAnimationFrame(step);
      }
    };
    frameId = window.requestAnimationFrame(step);

    return () => {
      disposed = true;
      stopFrameLoop();
      if (anchorScrollInFlightRef) {
        anchorScrollInFlightRef.current = false;
      }
    };
  }, [anchorMessageId, anchorScrollInFlightRef, listRef, onAnchorSlideFinished, timelineRootRef]);

  // declared before the geometry correction so a same-commit message updates the timestamp first — otherwise the correction could finish the hold before the new message extends it
  useLayoutEffect(() => {
    lastContentChangeAtRef.current = performance.now();
  }, [messageChangeSignal]);

  // React commits streamed text before paint — re-apply the slide coordinate in that layout window so a chunk above the anchor can't push it for one visible frame
  useLayoutEffect(() => {
    anchorSlideCorrectionRef.current?.();
  }, [contentChangeSignal]);
}
