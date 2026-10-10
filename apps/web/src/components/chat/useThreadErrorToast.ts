// FILE: useThreadErrorToast.ts
// Purpose: Surfaces thread-level runtime errors as a floating error toast.
// Layer: Chat status presentation
// Exports: useThreadErrorToast, buildThreadErrorToastOptions, threadErrorToastId, decideThreadErrorToastAction, collectThreadErrorMap

import type { ThreadId } from "@synara/contracts";
import { isProviderDeliveryBlockDetail } from "@synara/shared/providerDeliveryBlock";
import { useEffect, useRef, type RefObject } from "react";

import { useStore } from "../../store";
import type { ThreadShell } from "../../types";
import { toastManager } from "../ui/toast";

type ThreadErrorToastOptions = Parameters<typeof toastManager.add>[0];

/** One toast per thread: re-adding under the same id updates the card in place
 *  instead of stacking a new toast for every error update. */
export function threadErrorToastId(threadId: ThreadId): string {
  return `thread-error:${threadId}`;
}

/** Threads currently rendered by a mounted chat surface. An error on a visible
 *  thread already surfaces inline over the transcript, so a toast for it would
 *  double-report the same live failure. Refcounted: a pane's thread assignment
 *  is not guaranteed unique while views are rearranged. */
const visibleThreadCounts = new Map<ThreadId, number>();

function isThreadVisible(threadId: ThreadId): boolean {
  return (visibleThreadCounts.get(threadId) ?? 0) > 0;
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

// A thread rendered on screen carries its error in the inline banner — the
// toast must stay quiet for it. For a thread nobody is viewing, the first error
// observed arrives with hydration — nothing fired during this mounted session —
// so it stays off the toast surface too. A later *change* to that stored value
// is a live provider failure and earns a toast. While a live toast is open,
// further values just refresh its content.
export function decideThreadErrorToastAction(input: {
  readonly previous: string | null | undefined;
  readonly error: string;
  readonly liveToastOpen: boolean;
  readonly threadVisible: boolean;
}): ThreadErrorToastAction {
  if (input.threadVisible) {
    return "none";
  }
  if (input.previous !== undefined && input.previous !== input.error) {
    return "toast";
  }
  return input.liveToastOpen ? "refresh" : "none";
}

/** Projects the per-thread error values out of the shell record so store
 *  updates can be diffed without walking whole shells. */
export function collectThreadErrorMap(
  shells: Readonly<Record<ThreadId, ThreadShell>> | undefined,
): Map<ThreadId, string | null> {
  const errors = new Map<ThreadId, string | null>();
  if (!shells) return errors;
  for (const [threadId, shell] of Object.entries(shells)) {
    errors.set(threadId as ThreadId, shell.error ?? null);
  }
  return errors;
}

/** Closing the toast on our own behalf (error cleared, thread now visible,
 *  thread removed) must not report a user dismissal, which would clear thread
 *  state we still need. */
function closeSilently(threadId: ThreadId, silentRef: RefObject<boolean>): void {
  silentRef.current = true;
  toastManager.close(threadErrorToastId(threadId));
  silentRef.current = false;
}

/**
 * Mirrors live thread-level errors into a floating toast, but only for threads
 * the user is not currently viewing — a visible thread's error already shows in
 * the transcript's `ThreadErrorBanner`, so toasting it as well renders the same
 * failure twice. A stored error observed for the first time is hydration, not a
 * live event, and stays off the toast surface.
 */
export function useThreadErrorToast(input: {
  /** The thread this chat surface is rendering; its errors stay inline. */
  threadId: ThreadId | null;
  onDismiss: (threadId: ThreadId) => void;
  onUnblock: (threadId: ThreadId) => void;
  /** Thread whose unblock recovery is in flight, if any. */
  unblockingThreadId: ThreadId | null;
}): void {
  const { onDismiss, onUnblock, threadId, unblockingThreadId } = input;
  const callbacksRef = useRef({ onDismiss, onUnblock });
  const closingSilentlyRef = useRef(false);
  const unblockingThreadIdRef = useRef(unblockingThreadId);
  // Per-thread observation state: the first error seen for a thread is the
  // hydrated/stored one (inline surface only); a value that changes afterwards
  // is a live event and earns a toast when the thread is off screen.
  const lastErrorByThreadRef = useRef(new Map<ThreadId, string | null>());
  const liveToastThreadRef = useRef(new Set<ThreadId>());

  useEffect(() => {
    callbacksRef.current = { onDismiss, onUnblock };
  }, [onDismiss, onUnblock]);

  useEffect(() => {
    unblockingThreadIdRef.current = unblockingThreadId;
  }, [unblockingThreadId]);

  // Declared before the observation effect so a thread registered as visible in
  // the same commit is never toasted.
  useEffect(() => {
    if (!threadId) return;
    visibleThreadCounts.set(threadId, (visibleThreadCounts.get(threadId) ?? 0) + 1);
    // A toast that opened while this thread was off screen must yield to the
    // inline banner now that the thread is on screen.
    liveToastThreadRef.current.delete(threadId);
    closeSilently(threadId, closingSilentlyRef);
    return () => {
      const count = (visibleThreadCounts.get(threadId) ?? 1) - 1;
      if (count <= 0) {
        visibleThreadCounts.delete(threadId);
      } else {
        visibleThreadCounts.set(threadId, count);
      }
    };
  }, [threadId]);

  useEffect(() => {
    const reconcile = (errors: Map<ThreadId, string | null>): void => {
      const previousByThread = lastErrorByThreadRef.current;
      for (const [observedThreadId, error] of errors) {
        if (!error) {
          liveToastThreadRef.current.delete(observedThreadId);
          closeSilently(observedThreadId, closingSilentlyRef);
          continue;
        }
        const action = decideThreadErrorToastAction({
          previous: previousByThread.get(observedThreadId),
          error,
          liveToastOpen: liveToastThreadRef.current.has(observedThreadId),
          threadVisible: isThreadVisible(observedThreadId),
        });
        if (action === "toast") {
          liveToastThreadRef.current.add(observedThreadId);
        }
        // Re-add under the same id while a live toast is open so the card
        // refreshes in place (e.g. the "Unblocking…" action state) without a
        // re-animation.
        if (action === "none") {
          continue;
        }
        toastManager.add(
          buildThreadErrorToastOptions({
            error,
            threadId: observedThreadId,
            unblocking: unblockingThreadIdRef.current === observedThreadId,
            onClose: () => {
              if (closingSilentlyRef.current) return;
              liveToastThreadRef.current.delete(observedThreadId);
              callbacksRef.current.onDismiss(observedThreadId);
            },
            onUnblock: () => {
              callbacksRef.current.onUnblock(observedThreadId);
            },
          }),
        );
      }
      // Threads that vanished (deleted) can no longer surface a banner — drop
      // any toast their live error opened.
      for (const removedThreadId of previousByThread.keys()) {
        if (!errors.has(removedThreadId)) {
          liveToastThreadRef.current.delete(removedThreadId);
          closeSilently(removedThreadId, closingSilentlyRef);
        }
      }
      lastErrorByThreadRef.current = errors;
    };

    reconcile(collectThreadErrorMap(useStore.getState().threadShellById));
    return useStore.subscribe((state, previousState) => {
      if (state.threadShellById === previousState.threadShellById) return;
      reconcile(collectThreadErrorMap(state.threadShellById));
    });
  }, []);
}
