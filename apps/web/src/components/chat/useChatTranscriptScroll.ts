import type { LegendListRef } from "@legendapp/list/react";
import { ThreadId } from "@synara/contracts";
import { Debouncer } from "@tanstack/react-pacer";
import type { RefObject } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type WheelEvent,
} from "react";
import { flushSync } from "react-dom";
import { isScrollContainerNearBottom } from "../../chat-scroll";
import { isEditableEventTarget } from "../../lib/editableEventTarget";
import type { TimelineEntry } from "../../session-logic";
import { buildTranscriptAutoFollowSignal, buildTranscriptTailKey } from "../ChatView.logic";
import {
  scrollTranscriptToSettledEnd,
  stopTranscriptScrollAtCurrentOffset,
} from "./transcriptScroll";

interface ChatTranscriptScrollInput {
  activeThreadId: ThreadId | null;
  legendListRef: RefObject<LegendListRef | null>;
  timelineEntries: readonly TimelineEntry[];
  hasStreamingAssistantText: boolean;
  composerTranscriptInsetPx: number;
  isInactiveSplitPane: boolean;
}

export function useChatTranscriptScroll({
  activeThreadId,
  legendListRef,
  timelineEntries,
  hasStreamingAssistantText,
  composerTranscriptInsetPx,
  isInactiveSplitPane,
}: ChatTranscriptScrollInput) {
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const isAtEndRef = useRef(true);
  const autoFollowThreadIdRef = useRef<ThreadId | null>(null);
  const pendingInteractionAnchorRef = useRef<{
    element: HTMLElement;
    top: number;
  } | null>(null);
  const pendingInteractionAnchorFrameRef = useRef<number | null>(null);
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );

  useEffect(() => {
    const scrollDebouncer = showScrollDebouncer.current;
    return () => {
      scrollDebouncer.cancel();
      const pendingFrame = pendingInteractionAnchorFrameRef.current;
      if (pendingFrame !== null) {
        window.cancelAnimationFrame(pendingFrame);
      }
    };
  }, []);

  const tailAnchorScrollInFlightRef = useRef(false);

  // Scroll helpers stay list-owned so transcript updates stop bouncing through
  // a separate measurement/controller loop during streaming.
  // Guards isAtEndRef from flipping during reflow-induced scroll events that
  // fire immediately after an explicit scrollToEnd.
  const programmaticScrollUntilRef = useRef(0);
  // A scroll event carries the position from when it was generated, not when it
  // is delivered: a list stick-to-end queued before an upward gesture can fire
  // isAtEnd after detach latched and be misread as the user reaching the bottom.
  // Bare isAtEnd notifications may not re-stick inside this grace; explicit
  // gesture-end calls (release/decide) bypass it.
  const detachedAtRef = useRef(0);
  const DETACHED_RESTICK_GRACE_MS = 250;
  // User scroll gestures take ownership from streaming auto-follow. Ref updates
  // are immediate; state updates project into the `followLiveOutput` prop.
  const [isUserScrollDetached, setIsUserScrollDetached] = useState(false);
  const isUserScrollDetachedRef = useRef(isUserScrollDetached);
  const setTranscriptScrollDetached = useCallback((detached: boolean) => {
    isUserScrollDetachedRef.current = detached;
    setIsUserScrollDetached(detached);
  }, []);
  const pendingScrollGestureRef = useRef<{
    container: HTMLElement;
    scrollTop: number;
    scrollHeight: number;
    wasFollowing: boolean;
    movedUp?: boolean;
    keyboard?: boolean;
  } | null>(null);
  // A wheel/key gesture judged a no-op can still be real: under load the
  // compositor scroll lands after the settle check, and the late scroll would
  // otherwise be read as an unsolicited departure and snapped back to the tail.
  // For a short window after the re-stick, a scroll below the gesture origin
  // re-detaches follow instead.
  const lateGestureScrollRef = useRef<{ until: number; scrollTop: number } | null>(null);
  const LATE_GESTURE_VERIFY_MS = 500;
  const pendingScrollGestureFrameRef = useRef<number | null>(null);
  const cancelPendingScrollGesture = useCallback(() => {
    const frameId = pendingScrollGestureFrameRef.current;
    if (frameId !== null) window.cancelAnimationFrame(frameId);
    pendingScrollGestureFrameRef.current = null;
    pendingScrollGestureRef.current = null;
  }, []);
  useEffect(() => cancelPendingScrollGesture, [activeThreadId, cancelPendingScrollGesture]);
  // The arrow's smooth jump is followed by one exact settle after LegendList
  // has measured the tail. A user gesture invalidates that pending settle.
  const settledScrollRequestRef = useRef(0);
  const settledScrollInFlightRef = useRef(false);
  // Smooth only the first auto-follow after a send; live stream re-sticks stay cheap.
  const animateNextAutoFollowScrollRef = useRef(false);
  const scrollToEnd = useCallback(
    (animated = false) => {
      programmaticScrollUntilRef.current = performance.now() + 200;
      legendListRef.current?.scrollToEnd?.({ animated });
    },
    [legendListRef],
  );
  const armTranscriptAutoFollow = useCallback(
    (targetThreadId: ThreadId, animated = false) => {
      cancelPendingScrollGesture();
      lateGestureScrollRef.current = null;
      autoFollowThreadIdRef.current = targetThreadId;
      animateNextAutoFollowScrollRef.current = animated;
      isAtEndRef.current = true;
      setTranscriptScrollDetached(false);
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    },
    [cancelPendingScrollGesture, setTranscriptScrollDetached],
  );
  const clearTranscriptAutoFollow = useCallback(
    (synchronous = false) => {
      cancelPendingScrollGesture();
      const scrollTarget = settledScrollInFlightRef.current ? legendListRef.current : null;
      autoFollowThreadIdRef.current = null;
      animateNextAutoFollowScrollRef.current = false;
      settledScrollRequestRef.current += 1;
      settledScrollInFlightRef.current = false;
      programmaticScrollUntilRef.current = 0;
      // A user scroll gesture takes over from any in-flight tail-anchor slide.
      tailAnchorScrollInFlightRef.current = false;
      const container = legendListRef.current?.getScrollableNode();
      const detached =
        container instanceof HTMLElement && container.scrollHeight > container.clientHeight + 1;
      if (detached) {
        detachedAtRef.current = performance.now();
        lateGestureScrollRef.current = null;
      }
      if (detached !== isUserScrollDetachedRef.current) {
        // Disable list-owned follow before an already queued animation frame can
        // run. Continuous wheel events otherwise defer this prop update in React.
        if (synchronous) flushSync(() => setTranscriptScrollDetached(detached));
        else setTranscriptScrollDetached(detached);
      }
      if (scrollTarget) {
        void stopTranscriptScrollAtCurrentOffset(scrollTarget);
      }
    },
    [legendListRef, cancelPendingScrollGesture, setTranscriptScrollDetached],
  );
  const onTranscriptNavigate = useCallback(() => {
    // Search can navigate from an effect. Its ref ownership changes immediately,
    // while React applies the list prop before the animated jump's next frame.
    clearTranscriptAutoFollow();
    isAtEndRef.current = false;
    showScrollDebouncer.current.maybeExecute();
  }, [clearTranscriptAutoFollow]);
  const transcriptMessageCount = useMemo(
    () => timelineEntries.filter((entry) => entry.kind === "message").length,
    [timelineEntries],
  );
  const latestTranscriptMessage = useMemo(() => {
    for (let index = timelineEntries.length - 1; index >= 0; index -= 1) {
      const entry = timelineEntries[index];
      if (entry?.kind === "message") {
        return entry.message;
      }
    }
    return null;
  }, [timelineEntries]);
  const transcriptTailKey = buildTranscriptTailKey(latestTranscriptMessage);
  const transcriptAutoFollowSignal = buildTranscriptAutoFollowSignal({
    messageCount: transcriptMessageCount,
    tailKey: transcriptTailKey,
  });
  const onIsAtEndChange = useCallback(
    (isAtEnd: boolean, fromGestureEnd = false) => {
      const container = legendListRef.current?.getScrollableNode();
      const pending = pendingScrollGestureRef.current;
      if (
        pending &&
        container === pending.container &&
        container.scrollTop < pending.scrollTop - 1
      ) {
        // Streamed growth can compensate the offset back above the gesture's
        // origin before the settle check runs; remember that real upward
        // movement happened so the gesture is not misread as a no-op.
        pending.movedUp = true;
      }
      if (pending?.keyboard && container === pending.container) {
        // Native key scrolling can begin after keyup and after multiple frames.
        if (container.scrollTop >= pending.scrollTop || isScrollContainerNearBottom(container, 1))
          return;
        pendingScrollGestureRef.current = null;
      }
      if (!isAtEnd && !isUserScrollDetachedRef.current) {
        const lateGesture = lateGestureScrollRef.current;
        if (lateGesture && container instanceof HTMLElement) {
          // Inside the verify window a departure from the bottom may be the
          // gesture arriving late, with its scrollTop already compensated back
          // above the origin by streamed growth — but it may equally be an emit
          // transient. Transients re-pin within a frame or two while a gesture
          // stays off the bottom, so verify persistence before detaching. Past
          // the window only an observed dip below the origin still counts
          // (growth alone never decreases scrollTop).
          if (container.scrollTop < lateGesture.scrollTop - 1) {
            lateGestureScrollRef.current = null;
            clearTranscriptAutoFollow(true);
            return;
          }
          const inWindow = performance.now() <= lateGesture.until;
          if (!inWindow) {
            lateGestureScrollRef.current = null;
          } else if (!isScrollContainerNearBottom(container, 1)) {
            // Verify against this exact record: a later arm, gesture, or dip
            // clears the ref and retires the pending check with it.
            const record = lateGesture;
            window.requestAnimationFrame(() =>
              window.requestAnimationFrame(() => {
                if (lateGestureScrollRef.current !== record) return;
                lateGestureScrollRef.current = null;
                if (
                  !isUserScrollDetachedRef.current &&
                  legendListRef.current?.getScrollableNode() === container &&
                  !isScrollContainerNearBottom(container, 1)
                )
                  clearTranscriptAutoFollow(true);
              }),
            );
            return;
          }
        }
        if (
          hasStreamingAssistantText &&
          container instanceof HTMLElement &&
          !isScrollContainerNearBottom(container, 1) &&
          !tailAnchorScrollInFlightRef.current &&
          !settledScrollInFlightRef.current &&
          performance.now() >= programmaticScrollUntilRef.current
        ) {
          const request = settledScrollRequestRef.current;
          programmaticScrollUntilRef.current = performance.now() + 200;
          window.requestAnimationFrame(() => {
            if (
              request === settledScrollRequestRef.current &&
              !isUserScrollDetachedRef.current &&
              !tailAnchorScrollInFlightRef.current &&
              !settledScrollInFlightRef.current &&
              legendListRef.current?.getScrollableNode() === container &&
              !isScrollContainerNearBottom(container, 1)
            )
              scrollToEnd();
          });
        }
        return;
      }
      if (
        !isAtEnd &&
        (tailAnchorScrollInFlightRef.current ||
          settledScrollInFlightRef.current ||
          performance.now() < programmaticScrollUntilRef.current)
      ) {
        return;
      }
      // The list can report its content end while the viewport is still inside
      // the bottom inset, and its isAtEnd flag can also arrive stale when this
      // handler reads it before the list's own scroll pass. A detached reader
      // therefore resumes only on the container's physical position: actually
      // at the bottom, outside the post-detach grace that filters stale events
      // (explicit gesture-end calls bypass the grace).
      const nearBottom =
        container instanceof HTMLElement && isScrollContainerNearBottom(container, 1);
      const atEnd =
        (isAtEnd || (isUserScrollDetachedRef.current && nearBottom)) &&
        (!isUserScrollDetachedRef.current ||
          !(container instanceof HTMLElement) ||
          (nearBottom &&
            (fromGestureEnd ||
              performance.now() - detachedAtRef.current > DETACHED_RESTICK_GRACE_MS)));
      if (atEnd === isAtEndRef.current && (!atEnd || !isUserScrollDetachedRef.current)) return;
      // A gesture can detach without changing the previous edge notification.
      if (atEnd) {
        setTranscriptScrollDetached(false);
        showScrollDebouncer.current.cancel();
        setShowScrollToBottom(false);
      } else {
        // A changing layout can temporarily leave the end during output. Only
        // user gestures detach live follow; a geometry notification must not.
        showScrollDebouncer.current.maybeExecute();
      }
      isAtEndRef.current = atEnd;
    },
    [
      legendListRef,
      hasStreamingAssistantText,
      scrollToEnd,
      setTranscriptScrollDetached,
      clearTranscriptAutoFollow,
    ],
  );
  const cancelPendingInteractionAnchorAdjustment = useCallback(() => {
    const pendingFrame = pendingInteractionAnchorFrameRef.current;
    if (pendingFrame === null) return;
    pendingInteractionAnchorFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);
  const onMessagesClickCaptureBase = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const scrollContainer = legendListRef.current?.getScrollableNode?.();
      if (!(scrollContainer instanceof HTMLElement) || !(event.target instanceof Element)) return;

      const trigger = event.target.closest<HTMLElement>(
        "button, summary, [role='button'], [data-scroll-anchor-target]",
      );
      if (!trigger || !scrollContainer.contains(trigger)) return;
      if (trigger.closest("[data-scroll-anchor-ignore]")) return;

      pendingInteractionAnchorRef.current = {
        element: trigger,
        top: trigger.getBoundingClientRect().top,
      };

      cancelPendingInteractionAnchorAdjustment();
      pendingInteractionAnchorFrameRef.current = window.requestAnimationFrame(() => {
        pendingInteractionAnchorFrameRef.current = null;
        const anchor = pendingInteractionAnchorRef.current;
        pendingInteractionAnchorRef.current = null;
        const activeScrollContainer = legendListRef.current?.getScrollableNode?.();
        if (!(activeScrollContainer instanceof HTMLElement) || !anchor) return;
        if (!anchor.element.isConnected || !activeScrollContainer.contains(anchor.element)) return;

        const nextTop = anchor.element.getBoundingClientRect().top;
        const delta = nextTop - anchor.top;
        if (Math.abs(delta) < 0.5) return;

        activeScrollContainer.scrollTop += delta;
      });
    },
    [legendListRef, cancelPendingInteractionAnchorAdjustment],
  );
  const onMessagesPointerDownBase = useCallback(() => {
    clearTranscriptAutoFollow(true);
  }, [clearTranscriptAutoFollow]);
  const releaseTranscriptScrollGesture = useCallback(() => {
    const state = legendListRef.current?.getState();
    if (state) onIsAtEndChange(state.isAtEnd, /* fromGestureEnd */ true);
  }, [legendListRef, onIsAtEndChange]);
  const onMessagesPointerCancelBase = releaseTranscriptScrollGesture;
  const onMessagesPointerUpBase = releaseTranscriptScrollGesture;
  const onMessagesScrollBase = useCallback(() => {}, []);
  const onMessagesTouchEndBase = releaseTranscriptScrollGesture;
  const onMessagesTouchMoveBase = useCallback(() => {
    clearTranscriptAutoFollow(true);
  }, [clearTranscriptAutoFollow]);
  const onMessagesTouchStartBase = useCallback(() => {
    clearTranscriptAutoFollow(true);
  }, [clearTranscriptAutoFollow]);
  const onMessagesScrollGesture = useCallback(
    (upward: boolean) => {
      const container = legendListRef.current?.getScrollableNode();
      if (!(container instanceof HTMLElement)) return;
      if (!upward && isAtEndRef.current && isScrollContainerNearBottom(container, 1)) return;
      const pending = pendingScrollGestureRef.current;
      const origin =
        pending?.container === container
          ? pending
          : {
              container,
              scrollTop: container.scrollTop,
              scrollHeight: container.scrollHeight,
              wasFollowing:
                isAtEndRef.current &&
                !isUserScrollDetachedRef.current &&
                (!upward || isScrollContainerNearBottom(container, 1)),
            };
      clearTranscriptAutoFollow(true);
      pendingScrollGestureRef.current = origin;
      const decide = () => {
        pendingScrollGestureRef.current = null;
        // A wheel that never moved the scroll position upward is a no-op —
        // sub-pixel delta, nested target, or already at the limit — and must
        // not strand live follow. Real upward movement can be compensated
        // back above the origin by streamed growth inside this window, so the
        // gesture is judged by the lowest offset observed (movedUp), not the
        // final one.
        if (container.scrollTop < origin.scrollTop - 1) origin.movedUp = true;
        if (origin.wasFollowing && !origin.movedUp) {
          lateGestureScrollRef.current = {
            until: performance.now() + LATE_GESTURE_VERIFY_MS,
            scrollTop: origin.scrollTop,
          };
          setTranscriptScrollDetached(false);
          onIsAtEndChange(true, /* fromGestureEnd */ true);
          scrollToEnd();
        } else {
          releaseTranscriptScrollGesture();
        }
      };
      if (!upward) {
        // Native scrolling can settle on the next rendering pass. Keep one
        // pending check per gesture burst, preserving ownership from its first event.
        pendingScrollGestureFrameRef.current = window.requestAnimationFrame(() => {
          pendingScrollGestureFrameRef.current = window.requestAnimationFrame(() => {
            pendingScrollGestureFrameRef.current = null;
            decide();
          });
        });
        return;
      }
      // An upward wheel's scroll lands on the compositor a few frames after the
      // event; under load the two-frame window can close first and an unmoved
      // scrollTop would be misread as a no-op. Like the keyboard path below,
      // give the gesture rendering time before deciding it did nothing.
      const deadline = performance.now() + 150;
      const check = () => {
        pendingScrollGestureFrameRef.current = null;
        if (pendingScrollGestureRef.current !== origin) return;
        if (container.scrollTop < origin.scrollTop - 1) origin.movedUp = true;
        const settled = origin.movedUp || container.scrollHeight !== origin.scrollHeight;
        if (!settled && performance.now() < deadline) {
          pendingScrollGestureFrameRef.current = window.requestAnimationFrame(check);
          return;
        }
        decide();
      };
      pendingScrollGestureFrameRef.current = window.requestAnimationFrame(() => {
        pendingScrollGestureFrameRef.current = window.requestAnimationFrame(check);
      });
    },
    [
      legendListRef,
      clearTranscriptAutoFollow,
      onIsAtEndChange,
      releaseTranscriptScrollGesture,
      scrollToEnd,
      setTranscriptScrollDetached,
    ],
  );
  const onMessagesWheelBase = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      // Horizontal scroll, zoom, and scrolling down at the end do not leave it.
      if (event.ctrlKey || event.deltaY === 0) return;
      onMessagesScrollGesture(event.deltaY < 0);
    },
    [onMessagesScrollGesture],
  );
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const container = legendListRef.current?.getScrollableNode();
      if (
        !(container instanceof HTMLElement) ||
        !(event.target instanceof Element) ||
        !container.contains(event.target) ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        isEditableEventTarget(event)
      )
        return;
      if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
        return;
      if (event.key === " " && event.target.closest("button, a, [role='button']")) return;
      const upward =
        event.key === "ArrowUp" ||
        event.key === "PageUp" ||
        event.key === "Home" ||
        (event.key === " " && event.shiftKey);
      if (upward) {
        if (container.scrollTop <= 0) return;
        const pending = pendingScrollGestureRef.current;
        const origin =
          pending?.keyboard && pending.container === container
            ? pending
            : {
                container,
                scrollTop: container.scrollTop,
                scrollHeight: container.scrollHeight,
                wasFollowing: isAtEndRef.current && !isUserScrollDetachedRef.current,
                keyboard: true,
              };
        clearTranscriptAutoFollow(true);
        pendingScrollGestureRef.current = origin;
        isAtEndRef.current = false;
        showScrollDebouncer.current.maybeExecute();
      } else {
        onMessagesScrollGesture(false);
      }
    };
    const releaseKeyboardGesture = () => {
      const origin = pendingScrollGestureRef.current;
      if (!origin?.keyboard) return;
      const previousFrame = pendingScrollGestureFrameRef.current;
      if (previousFrame !== null) window.cancelAnimationFrame(previousFrame);
      // Native key scrolling may begin after keyup. Give it rendering time to
      // move, then recover a no-op/nested gesture instead of holding indefinitely.
      const deadline = performance.now() + 150;
      const check = () => {
        pendingScrollGestureFrameRef.current = null;
        if (pendingScrollGestureRef.current !== origin) return;
        if (origin.container.scrollTop < origin.scrollTop - 1) origin.movedUp = true;
        if (!origin.movedUp && performance.now() < deadline) {
          pendingScrollGestureFrameRef.current = window.requestAnimationFrame(check);
          return;
        }
        pendingScrollGestureRef.current = null;
        if (origin.wasFollowing && !origin.movedUp) {
          lateGestureScrollRef.current = {
            until: performance.now() + LATE_GESTURE_VERIFY_MS,
            scrollTop: origin.scrollTop,
          };
          setTranscriptScrollDetached(false);
          onIsAtEndChange(true, /* fromGestureEnd */ true);
          scrollToEnd();
        } else {
          releaseTranscriptScrollGesture();
        }
      };
      pendingScrollGestureFrameRef.current = window.requestAnimationFrame(check);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", releaseKeyboardGesture);
    window.addEventListener("blur", releaseKeyboardGesture);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", releaseKeyboardGesture);
      window.removeEventListener("blur", releaseKeyboardGesture);
    };
  }, [
    legendListRef,
    clearTranscriptAutoFollow,
    onIsAtEndChange,
    onMessagesScrollGesture,
    releaseTranscriptScrollGesture,
    scrollToEnd,
    setTranscriptScrollDetached,
  ]);
  // A thread switch hands scroll ownership back to follow. This must be a
  // layout effect declared before the auto-follow effect below: that effect
  // reads the detached ref in the same commit, and a passive reset would run
  // after it had already skipped the new thread, without re-triggering it.
  useLayoutEffect(() => {
    isAtEndRef.current = true;
    settledScrollRequestRef.current += 1;
    settledScrollInFlightRef.current = false;
    programmaticScrollUntilRef.current = 0;
    setTranscriptScrollDetached(false);
    showScrollDebouncer.current.cancel();
    const settle = window.setTimeout(() => setShowScrollToBottom(false), 0);
    return () => window.clearTimeout(settle);
  }, [activeThreadId, setTranscriptScrollDetached]);
  useLayoutEffect(() => {
    const shouldFollowPendingTurn =
      activeThreadId !== null && autoFollowThreadIdRef.current === activeThreadId;
    if (isUserScrollDetachedRef.current || (!isAtEndRef.current && !shouldFollowPendingTurn)) {
      return;
    }
    // Re-apply the bottom stick only for real transcript messages; tool/work
    // rows can arrive quickly and should not churn scroll/layout work.
    const frameId = window.requestAnimationFrame(() => {
      // The tail-anchor slide owns the scroll after a send; a re-snap here
      // would hard-jump past the smooth slide mid-flight. Once the anchor
      // settles the spacer keeps the end position exact, so nothing is missed.
      if (tailAnchorScrollInFlightRef.current || isUserScrollDetachedRef.current) {
        return;
      }
      const shouldAnimate = animateNextAutoFollowScrollRef.current;
      animateNextAutoFollowScrollRef.current = false;
      scrollToEnd(shouldAnimate);
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeThreadId, scrollToEnd, transcriptAutoFollowSignal]);

  // A composer that grows (attachments, approval cards, queued turns) eats into the
  // transcript's bottom content inset, which would push the tail behind the frosted
  // surface. Re-stick a transcript that was already parked at the end.
  //
  // This is driven by the *committed* inset rather than by a ResizeObserver on the
  // composer: the inset lands a render after the measurement, so a scroll scheduled
  // from the observer would race the padding it is supposed to compensate for. Here
  // the new padding is already in the DOM, so the pre-resize viewport is simply the
  // current one with the inset delta backed out.
  const previousComposerTranscriptInsetRef = useRef({
    threadId: activeThreadId ?? null,
    insetPx: composerTranscriptInsetPx,
  });
  useLayoutEffect(() => {
    const threadId = activeThreadId ?? null;
    const previous = previousComposerTranscriptInsetRef.current;
    previousComposerTranscriptInsetRef.current = {
      threadId,
      insetPx: composerTranscriptInsetPx,
    };
    if (previous.threadId !== threadId) return;

    const insetDeltaPx = composerTranscriptInsetPx - previous.insetPx;
    if (isInactiveSplitPane || Math.abs(insetDeltaPx) < 0.5) return;

    const scrollContainer = legendListRef.current?.getScrollableNode?.();
    if (!(scrollContainer instanceof HTMLElement)) return;
    const wasNearEndBeforeResize = isScrollContainerNearBottom({
      scrollTop: scrollContainer.scrollTop,
      clientHeight: scrollContainer.clientHeight,
      scrollHeight: scrollContainer.scrollHeight - insetDeltaPx,
    });
    if (!wasNearEndBeforeResize) return;

    // Compensate by the exact inset delta rather than asking the list to scroll to its
    // end: LegendList re-measures the padded viewport on its own schedule, so an
    // end-scroll issued in this commit would aim at the pre-padding content height and
    // land a composer-growth short of the tail.
    programmaticScrollUntilRef.current = performance.now() + 200;
    scrollContainer.scrollTop += insetDeltaPx;
  }, [legendListRef, activeThreadId, composerTranscriptInsetPx, isInactiveSplitPane]);

  const onScrollToBottom = useCallback(() => {
    cancelPendingScrollGesture();
    lateGestureScrollRef.current = null;
    tailAnchorScrollInFlightRef.current = false;
    setTranscriptScrollDetached(false);
    isAtEndRef.current = true;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    const target = legendListRef.current;
    if (!target) {
      return;
    }

    const requestId = settledScrollRequestRef.current + 1;
    settledScrollRequestRef.current = requestId;
    settledScrollInFlightRef.current = true;
    programmaticScrollUntilRef.current = performance.now() + 200;
    void scrollTranscriptToSettledEnd({
      target,
      isCurrent: () =>
        settledScrollRequestRef.current === requestId && legendListRef.current === target,
      beforeFinalScroll: () => {
        programmaticScrollUntilRef.current = performance.now() + 200;
      },
    })
      .then((settled) => {
        if (settledScrollRequestRef.current !== requestId) {
          return;
        }
        settledScrollInFlightRef.current = false;
        if (!settled) {
          return;
        }
        isAtEndRef.current = true;
        showScrollDebouncer.current.cancel();
        setShowScrollToBottom(false);
      })
      .catch(() => {
        if (settledScrollRequestRef.current === requestId) {
          settledScrollInFlightRef.current = false;
        }
      });
  }, [legendListRef, cancelPendingScrollGesture, setTranscriptScrollDetached]);

  const previousThreadIdRef = useRef(activeThreadId);
  const pendingStreamingThreadRef = useRef<ThreadId | null>(null);
  useEffect(() => {
    if (previousThreadIdRef.current !== activeThreadId) {
      previousThreadIdRef.current = activeThreadId;
      pendingStreamingThreadRef.current = activeThreadId;
    }
    if (
      activeThreadId === null ||
      !hasStreamingAssistantText ||
      pendingStreamingThreadRef.current !== activeThreadId
    )
      return;
    pendingStreamingThreadRef.current = null;

    // The replacement list can expand after its first end-scroll as virtual rows
    // acquire their measured heights. Keep the live response at the end while
    // that initial layout settles, but yield immediately to a reader gesture.
    let cancelled = false;
    const settleAtEnd = async () => {
      const target = legendListRef.current;
      if (!target) return;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (
          cancelled ||
          tailAnchorScrollInFlightRef.current ||
          isUserScrollDetachedRef.current ||
          legendListRef.current !== target
        )
          return;
        programmaticScrollUntilRef.current = performance.now() + 200;
        await target.scrollToEnd({ animated: false });
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });
        if (
          cancelled ||
          tailAnchorScrollInFlightRef.current ||
          isUserScrollDetachedRef.current ||
          legendListRef.current !== target
        )
          return;
        const node = target.getScrollableNode();
        if (node instanceof HTMLElement && isScrollContainerNearBottom(node, 1)) return;
      }
    };
    const frameId = window.requestAnimationFrame(() => void settleAtEnd());
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
    };
  }, [activeThreadId, hasStreamingAssistantText, legendListRef]);

  return {
    showScrollToBottom,
    isUserScrollDetached,
    tailAnchorScrollInFlightRef,
    armTranscriptAutoFollow,
    onTranscriptNavigate,
    onIsAtEndChange,
    onScrollToBottom,
    onMessagesClickCaptureBase,
    onMessagesPointerDownBase,
    onMessagesPointerUpBase,
    onMessagesPointerCancelBase,
    onMessagesScrollBase,
    onMessagesTouchEndBase,
    onMessagesTouchMoveBase,
    onMessagesTouchStartBase,
    onMessagesWheelBase,
  };
}
