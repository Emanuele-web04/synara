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
  isStreaming: boolean;
  messageCount: number;
}

interface UseChatAutoScrollControllerResult {
  messagesScrollElement: HTMLDivElement | null;
  showScrollToBottom: boolean;
  setMessagesScrollContainerRef: (element: HTMLDivElement | null) => void;
  forceStickToBottom: (behavior?: ScrollBehavior) => void;
  onTimelineHeightChange: () => void;
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
  const [messagesScrollElement, setMessagesScrollElement] = useState<HTMLDivElement | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const shouldAutoScrollRef = useRef(true);
  const lastKnownScrollTopRef = useRef(0);
  const isPointerScrollActiveRef = useRef(false);
  const lastTouchClientYRef = useRef<number | null>(null);
  const pendingUserScrollUpIntentRef = useRef(false);
  const pendingAutoScrollFrameRef = useRef<number | null>(null);
  const pendingInteractionAnchorRef = useRef<{
    element: HTMLElement;
    top: number;
  } | null>(null);
  const pendingInteractionAnchorFrameRef = useRef<number | null>(null);

  const setMessagesScrollContainerRef = useCallback((element: HTMLDivElement | null) => {
    messagesScrollRef.current = element;
    setMessagesScrollElement(element);
  }, []);

  // Jumps to the latest known bottom and re-enables sticky behavior when the user returns there.
  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior });
    lastKnownScrollTopRef.current = scrollContainer.scrollTop;
    shouldAutoScrollRef.current = true;
    setShowScrollToBottom(false);
  }, []);

  const cancelPendingStickToBottom = useCallback(() => {
    const pendingFrame = pendingAutoScrollFrameRef.current;
    if (pendingFrame === null) return;
    pendingAutoScrollFrameRef.current = null;
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
      scrollMessagesToBottom(behavior);
      scheduleStickToBottom(behavior);
    },
    [cancelPendingStickToBottom, scheduleStickToBottom, scrollMessagesToBottom],
  );

  const onTimelineHeightChange = useCallback(() => {
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [scheduleStickToBottom]);

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

  const onMessagesScroll = useCallback(() => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    const currentScrollTop = scrollContainer.scrollTop;
    const isNearBottom = isScrollContainerNearBottom(scrollContainer);

    if (!shouldAutoScrollRef.current && isNearBottom) {
      shouldAutoScrollRef.current = true;
      pendingUserScrollUpIntentRef.current = false;
    } else if (shouldAutoScrollRef.current && pendingUserScrollUpIntentRef.current) {
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (scrolledUp) {
        shouldAutoScrollRef.current = false;
      }
      pendingUserScrollUpIntentRef.current = false;
    } else if (shouldAutoScrollRef.current && isPointerScrollActiveRef.current) {
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (scrolledUp) {
        shouldAutoScrollRef.current = false;
      }
    } else if (shouldAutoScrollRef.current && !isNearBottom) {
      // Catch keyboard or assistive scroll interactions that do not expose pointer intent.
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (scrolledUp) {
        shouldAutoScrollRef.current = false;
      }
    }

    setShowScrollToBottom(!shouldAutoScrollRef.current);
    lastKnownScrollTopRef.current = currentScrollTop;
  }, []);

  const onMessagesWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      pendingUserScrollUpIntentRef.current = true;
    }
  }, []);

  const onMessagesPointerDown = useCallback((_event: PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = true;
  }, []);

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

  const onMessagesTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    const previousTouchY = lastTouchClientYRef.current;
    if (previousTouchY !== null && touch.clientY > previousTouchY + 1) {
      pendingUserScrollUpIntentRef.current = true;
    }
    lastTouchClientYRef.current = touch.clientY;
  }, []);

  const onMessagesTouchEnd = useCallback((_event: TouchEvent<HTMLDivElement>) => {
    lastTouchClientYRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      cancelPendingStickToBottom();
      cancelPendingInteractionAnchorAdjustment();
    };
  }, [cancelPendingInteractionAnchorAdjustment, cancelPendingStickToBottom]);

  useLayoutEffect(() => {
    if (!options.threadId) return;
    shouldAutoScrollRef.current = true;
    lastKnownScrollTopRef.current = 0;
    isPointerScrollActiveRef.current = false;
    lastTouchClientYRef.current = null;
    pendingUserScrollUpIntentRef.current = false;
    pendingInteractionAnchorRef.current = null;
    setShowScrollToBottom(false);
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
    cancelPendingStickToBottom,
    options.threadId,
    scheduleStickToBottom,
  ]);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [options.messageCount, scheduleStickToBottom]);

  useEffect(() => {
    if (!options.isStreaming) return;
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [options.isStreaming, scheduleStickToBottom]);

  return {
    messagesScrollElement,
    showScrollToBottom,
    setMessagesScrollContainerRef,
    forceStickToBottom,
    onTimelineHeightChange,
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
