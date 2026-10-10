// FILE: deferredChatMount.ts
// Purpose: Schedules deferred chat mounting and after-paint work with a bounded fallback when Chromium
//          suppresses animation frames during Electron startup/background throttling.
// Layer: Chat surface lifecycle helper

export const DEFERRED_CHAT_MOUNT_FALLBACK_MS = 500;

export interface DeferredChatMountScheduler {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

/**
 * Wait for two paints before mounting a heavy chat surface, but never leave the
 * loader visible forever when Chromium pauses animation frames. Returns a cleanup
 * function that prevents either path from committing after the caller unmounts.
 */
export function scheduleDeferredChatMount(
  scheduler: DeferredChatMountScheduler,
  onReady: () => void,
): () => void {
  let firstFrame = 0;
  let secondFrame = 0;
  let fallbackTimer = 0;
  let settled = false;

  const markReady = () => {
    if (settled) {
      return;
    }
    settled = true;
    scheduler.clearTimeout(fallbackTimer);
    onReady();
  };

  fallbackTimer = scheduler.setTimeout(markReady, DEFERRED_CHAT_MOUNT_FALLBACK_MS);
  firstFrame = scheduler.requestAnimationFrame(() => {
    if (settled) {
      return;
    }
    secondFrame = scheduler.requestAnimationFrame(markReady);
  });

  return () => {
    settled = true;
    scheduler.clearTimeout(fallbackTimer);
    scheduler.cancelAnimationFrame(firstFrame);
    scheduler.cancelAnimationFrame(secondFrame);
  };
}

/**
 * Run `onReady` right after the next paint: the frame callback hands off to a timer, which
 * fires once that frame is on screen rather than a whole frame later. For work that must
 * not delay a visual acknowledgement (a pressed tab's highlight) but should start as soon
 * as it shows. Same bounded fallback and cleanup contract as `scheduleDeferredChatMount`.
 */
export function scheduleAfterNextPaint(
  scheduler: DeferredChatMountScheduler,
  onReady: () => void,
): () => void {
  let frame = 0;
  let afterPaintTimer = 0;
  let fallbackTimer = 0;
  let settled = false;

  const markReady = () => {
    if (settled) {
      return;
    }
    settled = true;
    scheduler.clearTimeout(fallbackTimer);
    scheduler.clearTimeout(afterPaintTimer);
    onReady();
  };

  fallbackTimer = scheduler.setTimeout(markReady, DEFERRED_CHAT_MOUNT_FALLBACK_MS);
  frame = scheduler.requestAnimationFrame(() => {
    if (settled) {
      return;
    }
    afterPaintTimer = scheduler.setTimeout(markReady, 0);
  });

  return () => {
    settled = true;
    scheduler.clearTimeout(fallbackTimer);
    scheduler.clearTimeout(afterPaintTimer);
    scheduler.cancelAnimationFrame(frame);
  };
}
