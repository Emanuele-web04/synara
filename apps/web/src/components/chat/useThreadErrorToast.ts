// FILE: useThreadErrorToast.ts
// Purpose: Surfaces thread-level runtime errors as a floating error toast.
// Layer: Chat status presentation
// Exports: useThreadErrorToast, buildThreadErrorToastOptions, threadErrorToastId

import type { ThreadId } from "@synara/contracts";
import { isProviderDeliveryBlockDetail } from "@synara/shared/providerDeliveryBlock";
import { useEffect, useRef, type RefObject } from "react";

import { toastManager } from "../ui/toast";

type ThreadErrorToastOptions = Parameters<typeof toastManager.add>[0];

/** One toast per thread: re-adding under the same id updates the card in place
 *  instead of stacking a new toast for every error update. */
export function threadErrorToastId(threadId: ThreadId): string {
  return `thread-error:${threadId}`;
}

export function buildThreadErrorToastOptions(input: {
  error: string;
  onClose: () => void;
  onUnblock: () => void;
  threadId: ThreadId;
  unblocking: boolean;
}): ThreadErrorToastOptions {
  const canUnblock = isProviderDeliveryBlockDetail(input.error);
  return {
    id: threadErrorToastId(input.threadId),
    type: "error",
    title: input.error,
    timeout: 0,
    priority: "high",
    onClose: input.onClose,
    data: { copyText: input.error, threadId: input.threadId },
    ...(canUnblock
      ? {
          actionProps: {
            children: input.unblocking ? "Unblocking…" : "Unblock thread",
            disabled: input.unblocking,
            onClick: input.onUnblock,
          },
        }
      : {}),
  };
}

type ThreadErrorToastAction = "none" | "refresh" | "toast";

// The first error observed for a thread arrives with hydration — nothing fired
// during this mounted session — so it belongs inline in the transcript only.
// A later *change* to that stored value is a live provider failure and earns a
// toast. While a live toast is open, further values just refresh its content.
export function decideThreadErrorToastAction(input: {
  readonly previous: string | null | undefined;
  readonly error: string;
  readonly liveToastOpen: boolean;
}): ThreadErrorToastAction {
  if (input.previous !== undefined && input.previous !== input.error) {
    return "toast";
  }
  return input.liveToastOpen ? "refresh" : "none";
}

/** Closing the toast on our own behalf (error cleared, thread switched, unmount)
 *  must not report a user dismissal, which would clear thread state we still need. */
function closeSilently(threadId: ThreadId, silentRef: RefObject<boolean>): void {
  silentRef.current = true;
  toastManager.close(threadErrorToastId(threadId));
  silentRef.current = false;
}

/**
 * Mirrors the thread-level error of `threadId` into a floating toast for LIVE
 * error events only. A stored error surfaces inline over the transcript via
 * `ThreadErrorBanner`; toasting it again on every mount would re-alert the same
 * persisted failure on each reload.
 */
export function useThreadErrorToast(input: {
  error: string | null;
  onDismiss: () => void;
  onUnblock: () => void;
  threadId: ThreadId | null;
  unblocking: boolean;
}): void {
  const { error, onDismiss, onUnblock, threadId, unblocking } = input;
  const callbacksRef = useRef({ onDismiss, onUnblock });
  const closingSilentlyRef = useRef(false);
  // Per-thread observation state: the first error seen after a thread becomes
  // active is the hydrated/stored one (inline surface only); a value that
  // changes afterwards is a live event and earns a toast.
  const lastErrorByThreadRef = useRef(new Map<ThreadId, string | null>());
  const liveToastThreadRef = useRef(new Set<ThreadId>());

  useEffect(() => {
    callbacksRef.current = { onDismiss, onUnblock };
  }, [onDismiss, onUnblock]);

  useEffect(() => {
    if (!threadId) return;
    const previous = lastErrorByThreadRef.current.get(threadId);
    lastErrorByThreadRef.current.set(threadId, error);
    if (!error) {
      liveToastThreadRef.current.delete(threadId);
      closeSilently(threadId, closingSilentlyRef);
      return;
    }
    const action = decideThreadErrorToastAction({
      previous,
      error,
      liveToastOpen: liveToastThreadRef.current.has(threadId),
    });
    if (action === "toast") {
      liveToastThreadRef.current.add(threadId);
    }
    // Re-add under the same id while a live toast is open so the card refreshes
    // in place (e.g. the "Unblocking…" action state) without a re-animation.
    if (action === "none") {
      return;
    }
    toastManager.add(
      buildThreadErrorToastOptions({
        error,
        threadId,
        unblocking,
        onClose: () => {
          if (closingSilentlyRef.current) return;
          liveToastThreadRef.current.delete(threadId);
          callbacksRef.current.onDismiss();
        },
        onUnblock: () => {
          callbacksRef.current.onUnblock();
        },
      }),
    );
  }, [error, threadId, unblocking]);

  // Kept separate from the content effect so an error update refreshes the card in
  // place instead of tearing it down and replaying the entrance animation.
  useEffect(() => {
    if (!threadId) return;
    return () => {
      closeSilently(threadId, closingSilentlyRef);
    };
  }, [threadId]);
}
