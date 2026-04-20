// FILE: useChatAutoScrollController.ts
// Purpose: Own the chat scroll state machine for auto-stick, user scroll intent, and button-driven jumps.
// Layer: UI hook
// Exports: useChatAutoScrollController
// Depends on: chat-scroll helpers and ChatView's message scroll container.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type TouchEvent,
  type WheelEvent,
} from "react";

import { isScrollContainerNearBottom } from "../../chat-scroll";

interface UseChatAutoScrollControllerOptions {
  threadId: string | null;
  followLiveOutput: boolean;
  messageCount: number;
}

interface UseChatAutoScrollControllerResult {
  messagesScrollElement: HTMLDivElement | null;
  showScrollToBottom: boolean;
  setMessagesBottomAnchorRef: (element: HTMLDivElement | null) => void;
  setMessagesScrollContainerRef: (element: HTMLDivElement | null) => void;
  forceStickToBottom: (behavior?: ScrollBehavior) => void;
  onLiveContentHeightChange: () => void;
  onComposerHeightChange: (previousHeight: number, nextHeight: number) => void;
  onMessagesClickCapture: (event: MouseEvent<HTMLDivElement>) => void;
  onMessagesPointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
  onMessagesPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onMessagesPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onMessagesScroll: () => void;
  onMessagesTouchEnd: (event: TouchEvent<HTMLDivElement>) => void;
  onMessagesTouchMove: (event: TouchEvent<HTMLDivElement>) => void;
  onMessagesTouchStart: (event: TouchEvent<HTMLDivElement>) => void;
  onMessagesWheel: (event: WheelEvent<HTMLDivElement>) => void;
}

// Keeps all auto-scroll heuristics in one place so ChatView can stay focused on orchestration.
export function useChatAutoScrollController(
  options: UseChatAutoScrollControllerOptions,
): UseChatAutoScrollControllerResult {
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const messagesBottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const [messagesScrollElement, setMessagesScrollElement] = useState<HTMLDivElement | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const shouldAutoScrollRef = useRef(true);
  const lastKnownScrollTopRef = useRef(0);
  const isPointerScrollActiveRef = useRef(false);
  const lastTouchClientYRef = useRef<number | null>(null);
  const pendingUserScrollUpIntentRef = useRef(false);
  const pendingAutoScrollFrameRef = useRef<number | null>(null);
  const pendingScrollFrameRef = useRef<number | null>(null);
  const pendingInteractionAnchorRef = useRef<{
    element: HTMLElement;
    top: number;
  } | null>(null);
  const pendingInteractionAnchorFrameRef = useRef<number | null>(null);
  const showScrollToBottomRef = useRef(false);

  const setMessagesBottomAnchorRef = useCallback((element: HTMLDivElement | null) => {
    messagesBottomAnchorRef.current = element;
  }, []);

  const setMessagesScrollContainerRef = useCallback((element: HTMLDivElement | null) => {
    messagesScrollRef.current = element;
    setMessagesScrollElement(element);
  }, []);

  // The bottom anchor gives us a stable "true bottom" target even while the
  // virtualizer is still reconciling row heights during an active turn.
  // Jumps to the latest known bottom and re-enables sticky behavior when the user returns there.
  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    const bottomAnchor = messagesBottomAnchorRef.current;
    if (bottomAnchor && scrollContainer.contains(bottomAnchor)) {
      const targetTop = Math.max(
        0,
        bottomAnchor.offsetTop + bottomAnchor.offsetHeight - scrollContainer.clientHeight,
      );
      scrollContainer.scrollTo({ top: targetTop, behavior });
    } else {
      scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior });
    }
    lastKnownScrollTopRef.current = scrollContainer.scrollTop;
    shouldAutoScrollRef.current = true;
    showScrollToBottomRef.current = false;
    setShowScrollToBottom(false);
  }, []);

  const cancelPendingStickToBottom = useCallback(() => {
    const pendingFrame = pendingAutoScrollFrameRef.current;
    if (pendingFrame === null) return;
    pendingAutoScrollFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);

  const cancelPendingScrollProcessing = useCallback(() => {
    const pendingFrame = pendingScrollFrameRef.current;
    if (pendingFrame === null) return;
    pendingScrollFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);

  const cancelPendingInteractionAnchorAdjustment = useCallback(() => {
    const pendingFrame = pendingInteractionAnchorFrameRef.current;
    if (pendingFrame === null) return;
    pendingInteractionAnchorFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);

  // Re-applies the stick after layout settles so virtualized rows and images can finish expanding.
  const scheduleStickToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (pendingAutoScrollFrameRef.current !== null) return;
      pendingAutoScrollFrameRef.current = window.requestAnimationFrame(() => {
        pendingAutoScrollFrameRef.current = null;
        scrollMessagesToBottom(behavior);
      });
    },
    [scrollMessagesToBottom],
  );

  const forceStickToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      cancelPendingStickToBottom();
      cancelPendingScrollProcessing();
      scrollMessagesToBottom(behavior);
      scheduleStickToBottom(behavior);
    },
    [
      cancelPendingScrollProcessing,
      cancelPendingStickToBottom,
      scheduleStickToBottom,
      scrollMessagesToBottom,
    ],
  );

  // Only follow transcript height growth while assistant text is actively streaming.
  // Buffering and tool-only activity should not keep re-sticking the viewport.
  const onLiveContentHeightChange = useCallback(() => {
    if (!options.followLiveOutput) return;
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [options.followLiveOutput, scheduleStickToBottom]);

  const onComposerHeightChange = useCallback(
    (previousHeight: number, nextHeight: number) => {
      if (previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) return;
      if (!shouldAutoScrollRef.current) return;
      scheduleStickToBottom();
    },
    [scheduleStickToBottom],
  );

  const onMessagesClickCapture = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer || !(event.target instanceof Element)) return;

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
        const activeScrollContainer = messagesScrollRef.current;
        if (!anchor || !activeScrollContainer) return;
        if (!anchor.element.isConnected || !activeScrollContainer.contains(anchor.element)) return;

        const nextTop = anchor.element.getBoundingClientRect().top;
        const delta = nextTop - anchor.top;
        if (Math.abs(delta) < 0.5) return;

        activeScrollContainer.scrollTop += delta;
        lastKnownScrollTopRef.current = activeScrollContainer.scrollTop;
      });
    },
    [cancelPendingInteractionAnchorAdjustment],
  );

  const updateScrollButtonVisibility = useCallback((visible: boolean) => {
    if (showScrollToBottomRef.current === visible) return;
    showScrollToBottomRef.current = visible;
    setShowScrollToBottom(visible);
  }, []);

  // Any explicit user scroll gesture should win over queued auto-stick work.
  // Keeping this centralized makes it easier to tweak the "manual scroll vs.
  // stick to bottom" contract without touching every event handler.
  const noteManualScrollIntent = useCallback(() => {
    pendingUserScrollUpIntentRef.current = true;
    cancelPendingStickToBottom();
  }, [cancelPendingStickToBottom]);

  const onMessagesScroll = useCallback(() => {
    if (pendingScrollFrameRef.current !== null) return;
    pendingScrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingScrollFrameRef.current = null;
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer) return;
      const currentScrollTop = scrollContainer.scrollTop;
      const isNearBottom = isScrollContainerNearBottom(scrollContainer);
      const didScrollUp = currentScrollTop < lastKnownScrollTopRef.current - 1;

      if (!shouldAutoScrollRef.current && isNearBottom) {
        shouldAutoScrollRef.current = true;
        pendingUserScrollUpIntentRef.current = false;
      } else if (shouldAutoScrollRef.current && pendingUserScrollUpIntentRef.current) {
        if (didScrollUp) {
          shouldAutoScrollRef.current = false;
        }
        pendingUserScrollUpIntentRef.current = false;
      } else if (shouldAutoScrollRef.current && isPointerScrollActiveRef.current) {
        if (didScrollUp) {
          shouldAutoScrollRef.current = false;
        }
      } else if (shouldAutoScrollRef.current && !isNearBottom) {
        // Catch keyboard or assistive scroll interactions that do not expose pointer intent.
        if (didScrollUp) {
          shouldAutoScrollRef.current = false;
        }
      }

      updateScrollButtonVisibility(!shouldAutoScrollRef.current);
      lastKnownScrollTopRef.current = currentScrollTop;
    });
  }, [updateScrollButtonVisibility]);

  const onMessagesWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (event.deltaY < 0) {
        noteManualScrollIntent();
      }
    },
    [noteManualScrollIntent],
  );

  const onMessagesPointerDown = useCallback(
    (_event: PointerEvent<HTMLDivElement>) => {
      isPointerScrollActiveRef.current = true;
      // Pointer-driven scrollbars/trackpads can start with pointer-down before
      // the first scroll event lands, so cancel pending stick work immediately.
      cancelPendingStickToBottom();
    },
    [cancelPendingStickToBottom],
  );

  const onMessagesPointerUp = useCallback((_event: PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = false;
  }, []);

  const onMessagesPointerCancel = useCallback((_event: PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = false;
  }, []);

  const onMessagesTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    lastTouchClientYRef.current = touch.clientY;
  }, []);

  const onMessagesTouchMove = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      const touch = event.touches[0];
      if (!touch) return;
      const previousTouchY = lastTouchClientYRef.current;
      if (previousTouchY !== null && touch.clientY > previousTouchY + 1) {
        noteManualScrollIntent();
      }
      lastTouchClientYRef.current = touch.clientY;
    },
    [noteManualScrollIntent],
  );

  const onMessagesTouchEnd = useCallback((_event: TouchEvent<HTMLDivElement>) => {
    lastTouchClientYRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      cancelPendingScrollProcessing();
      cancelPendingStickToBottom();
      cancelPendingInteractionAnchorAdjustment();
    };
  }, [
    cancelPendingInteractionAnchorAdjustment,
    cancelPendingScrollProcessing,
    cancelPendingStickToBottom,
  ]);

  useLayoutEffect(() => {
    if (!options.threadId) return;
    shouldAutoScrollRef.current = true;
    lastKnownScrollTopRef.current = 0;
    isPointerScrollActiveRef.current = false;
    lastTouchClientYRef.current = null;
    pendingUserScrollUpIntentRef.current = false;
    pendingInteractionAnchorRef.current = null;
    showScrollToBottomRef.current = false;
    setShowScrollToBottom(false);
    cancelPendingScrollProcessing();
    cancelPendingInteractionAnchorAdjustment();
    cancelPendingStickToBottom();
    scheduleStickToBottom();
    const timeout = window.setTimeout(() => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer) return;
      if (isScrollContainerNearBottom(scrollContainer)) return;
      scheduleStickToBottom();
    }, 96);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [
    cancelPendingInteractionAnchorAdjustment,
    cancelPendingScrollProcessing,
    cancelPendingStickToBottom,
    options.threadId,
    scheduleStickToBottom,
  ]);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [options.messageCount, scheduleStickToBottom]);

  useEffect(() => {
    if (!options.followLiveOutput) return;
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [options.followLiveOutput, scheduleStickToBottom]);

  return {
    messagesScrollElement,
    showScrollToBottom,
    setMessagesBottomAnchorRef,
    setMessagesScrollContainerRef,
    forceStickToBottom,
    onLiveContentHeightChange,
    onComposerHeightChange,
    onMessagesClickCapture,
    onMessagesPointerCancel,
    onMessagesPointerDown,
    onMessagesPointerUp,
    onMessagesScroll,
    onMessagesTouchEnd,
    onMessagesTouchMove,
    onMessagesTouchStart,
    onMessagesWheel,
  };
}
